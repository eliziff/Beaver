"""Score a native addon against every completed gold run, per layer.

Each gold PDF is parsed again with the request its gold was made from, by a pinned addon
(LEGAL_STRUCTURE_ADDON) or the most recently built: shards of runs in parallel, each loading the
addon once (extract.mjs --batch), long PDFs first, with earlier builds' OCR and extraction carried
forward. Runs are then scored in parallel against their gold with its document-level layer.
Totals are micro-averaged over all runs. `--saved` scores each run's saved baseline instead.

  --mode / --runs     score a subset (written to subset.json unless --tag)
  --tag NAME          write score/runs/NAME.json and NAME.manifest.json (each run's candidate,
                      engine inputs and witnesses, filed with its cached document)
  --replay MANIFEST   re-resolve the dumped structure-engine inputs with the engine's replay
                      example instead of parsing: an engine change measured in seconds
  --against SUMMARY   per mode, the change in each layer's pooled F1 and, per document, how many
                      got better or worse with the mean and median change

LEGALPDF_COMPOSITIONS and LAYOUT_PACK/LAYOUT_RUNTIME (layout mode) pass through the environment.
"""
import argparse
import hashlib
import os
import shutil
import statistics
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import sqlite3
from contextlib import closing
import worker
import hierarchy_pass
import evaluate
import corpus_store
import package

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REPLAY = ROOT / 'native/legal-structure-node/target/release/examples/replay.exe'
TIMINGS = {}


def reference_metadata(row, out=ROOT / 'benchmarks/local-data/legal-structure-gold'):
    """Resolve an explicit saved reference without deriving identity from its path."""
    result = {key: row[key] for key in ('source_sha256', 'mode') if key in row}
    if len(result) < 2:
        receipt = worker.read_json(Path(out) / row['run'] / 'receipt.json')
        saved = {'source_sha256': receipt['source_sha256'], 'mode': receipt['configuration']['mode']}
        worker.require(all(saved[key] == value for key, value in result.items()), 'Saved source metadata differs')
        result = saved
    return result


def completed(out, unavailable=None):
    for pending in out.glob('current/*/publication.json'):
        worker.recover_update(pending.parent)
    selected = {}
    indexed = set()
    omitted = {}
    if corpus_store.DB.exists():
        with closing(sqlite3.connect(corpus_store.DB.as_uri()+'?mode=ro',uri=True)) as db:
            current = db.execute("select r.sha256,a.path,a.sha256,g.path,g.sha256 from gold_records r"
                " join gold_artifacts a on a.run_id=r.run_id and a.role='receipt'"
                " join gold_artifacts g on g.run_id=r.run_id and g.role='gold'"
                " where r.dataset=? and r.status='complete'", (package.VERSION,)).fetchall()
        for sha,receipt_path,receipt_sha,gold_path,gold_sha in current:
            receipt = Path(receipt_path)
            job = receipt.parent
            if not job.resolve().is_relative_to(out.resolve()): continue
            worker.require(worker.digest(receipt) == receipt_sha, 'Selected gold receipt changed')
            value = worker.read_json(receipt)
            worker.require(value['status'] == 'complete' and value['source_sha256'] == sha and
                worker.digest(Path(gold_path)) == gold_sha == value['gold_sha256'], 'Selected gold changed')
            compact = worker.read_json(Path(gold_path))
            if 'legal_structure' not in compact.get('layers', {}):
                omitted[sha] = {'run': str(job.relative_to(out)), 'source_sha256': sha,
                    'mode': value['configuration']['mode'], 'reason': 'legal_structure_not_annotated'}
                continue
            selected[sha] = (None, (value['configuration']['mode'], job, value))
            indexed.add(sha)
    for receipt in sorted(out.glob('*/*/*/receipt.json')):
        mode = receipt.parents[2].name
        if mode not in ('digitalborn', 'ocr', 'packages'): continue
        if receipt.parents[1].name in indexed: continue
        value = worker.read_json(receipt)
        if value.get('status') != 'complete' or not (receipt.parent / 'gold.json.gz').exists(): continue
        sha = value['source_sha256']
        if sha in indexed: continue
        expected = worker.read_json(receipt.parent / 'gold.json.gz')
        if not ('legal_structure' in expected.get('layers', {}) if expected.get('schema_version') == package.VERSION else 'structure' in expected):
            omitted.setdefault(sha, {'run': str(receipt.parent.relative_to(out)), 'source_sha256': sha,
                'mode': value['configuration']['mode'], 'reason': 'legal_structure_not_annotated'})
            continue
        source = worker.read_json(receipt.parent / value['parent_run'] / 'receipt.json') if value.get('parent_run') else value
        priority = (source.get('finished_at',0), mode == 'packages', value.get('finished_at',0))
        if sha not in selected or priority > selected[sha][0]:
            selected[sha] = (priority, (value['configuration']['mode'], receipt.parent, value))
    missing = [row for sha, row in sorted(omitted.items()) if sha not in selected]
    if unavailable is not None:
        unavailable.extend(missing)
    elif missing:
        print(f'Skipping {len(missing)} sources without legal-structure annotations', file=sys.stderr)
    for sha in sorted(selected): yield selected[sha][1]


def addon_sha256():
    # The addon extract.mjs will load: a pinned one, or the most recently built.
    pinned = os.environ.get('LEGAL_STRUCTURE_ADDON')
    built = [ROOT / 'native/legal-structure-node/target' / p / 'legal_structure_node.dll' for p in ('debug', 'release')]
    chosen = Path(pinned) if pinned else max((p for p in built if p.exists()), key=lambda p: p.stat().st_mtime)
    return hashlib.sha256(chosen.read_bytes()).hexdigest()


def gold_request(job):
    # Parse with the request the gold was made from, so source lines stay comparable. The
    # earliest golds predate recording it; they read native text only. A Tesseract timeout
    # only bounds the wait, so a loaded machine may wait longer.
    request = worker.read_json(job / 'gold.json.gz')['provenance']['configuration'].get('parser', {}).get('request', {})
    if request.get('ocr', {}).get('provider') == 'tesseract':
        request = {**request, 'ocr': {**request['ocr'], 'settings': {**request['ocr'].get('settings', {}), 'timeout_seconds': 1200}}}
    return request


def carry(cache, sha, binary, request):
    # An earlier build's recognition and extraction, hard-linked forward: their cache keys name
    # the OCR and extraction code, so a structure-only build reuses them and any other misses
    # them. Each request keeps its own; a layout parse reuses its plain request's.
    root = cache / sha
    layout = '-layout' if os.environ.get('LAYOUT_PACK') else ''
    # Carried already: nothing to walk.
    own = root / binary / (request + layout) / 'parse-v1'
    if not root.is_dir() or all((own / stage).exists() for stage in ('recognition', 'extractions')):
        return
    for stage in ('recognition', 'extractions'):
        newest = {}
        for source in root.glob(f'*/*/parse-v1/{stage}'):
            request = source.parents[1].name
            if source.parents[2].name == binary or request.endswith('-layout'):
                continue
            if request not in newest or source.stat().st_mtime > newest[request].stat().st_mtime:
                newest[request] = source
        for request, previous in newest.items():
            target = root / binary / (request + layout) / 'parse-v1' / stage
            if not target.exists():
                try: shutil.copytree(previous, target, copy_function=os.link)
                except OSError: shutil.copytree(previous, target, dirs_exist_ok=True)


def extract_all(items, out, workers, env=None):
    """Parse every run's PDF with the addon loaded once per shard: shards in parallel, long PDFs
    first. Returns {run: (candidate file, engine dump or None)} and {run: error}."""
    cache, binary = out / 'score' / 'candidates', addon_sha256()
    jobs, runs, keys = [], {}, {}
    requests = {}
    for mode, job, receipt in items:
        request = gold_request(job)
        saved = cache / f'request-{worker.fingerprint(request)[:16]}.json'
        if saved not in requests:
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.write_text(json.dumps(request), encoding='utf-8'); requests[saved] = True
        pdf = pdf_path(receipt['source_sha256'])
        # The parse's cache directory is named for the request as extract.mjs serializes it.
        keys[receipt['source_sha256']] = hashlib.sha256(json.dumps(request, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()[:16]
        jobs.append({'pdf': str(pdf), 'output': str(cache), 'mode': mode, 'requestFile': str(saved)})
        runs[(str(pdf), mode)] = str(job.relative_to(out))
    with ThreadPoolExecutor(16) as pool:
        list(pool.map(lambda item: carry(cache, item[2]['source_sha256'], binary, keys[item[2]['source_sha256']]), items))
    jobs.sort(key=lambda j: -Path(j['pdf']).stat().st_size)
    shards = [shard for shard in (jobs[i::workers] for i in range(workers)) if shard]
    produced, errors = {}, {}
    with tempfile.TemporaryDirectory() as temp:
        processes = []
        for n, shard in enumerate(shards):
            listing, log = Path(temp) / f'jobs-{n}.json', Path(temp) / f'out-{n}.jsonl'
            listing.write_text(json.dumps(shard), encoding='utf-8')
            handle = log.open('w', encoding='utf-8')
            processes.append((subprocess.Popen(['node', str(HERE / 'extract.mjs'), '--batch', str(listing)], stdout=handle, env=env,
                creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS if sys.platform == 'win32' else 0), handle, log))
        for process, handle, log in processes:
            process.wait(); handle.close()
            for line in log.read_text(encoding='utf-8').splitlines():
                try: row = json.loads(line)
                except ValueError: continue
                run = runs.get((row['pdf'], row['mode']))
                if run is None: continue
                if 'file' in row:
                    produced[run] = (row['file'], row.get('dump'), row.get('witnesses'))
                    TIMINGS[run] = row.get('parseMs', 0)
                else: errors[run] = row['error']
    return produced, errors


def replay_all(manifest, out):
    """Re-resolve each run's dumped structure-engine inputs with the engine's replay example and
    return {run: (candidate file, replayed structure file)}."""
    root = out / 'score' / 'replay'
    root.mkdir(parents=True, exist_ok=True)
    rows = worker.read_json(manifest)
    jobs = [{'dump': r['dump'], 'output': str(root / f'{n}.json')} for n, r in enumerate(rows)]
    for job in jobs: Path(job['output']).unlink(missing_ok=True)
    listing = root / 'jobs.json'
    listing.write_text(json.dumps(jobs), encoding='utf-8')
    subprocess.run([str(REPLAY), str(listing), str(os.cpu_count() or 8)], check=True)
    return {r['run']: (r['candidate'], j['output']) for r, j in zip(rows, jobs) if Path(j['output']).exists()}


def score_one(item):
    run, out, candidate, structure = item
    job = Path(out) / run
    try:
        worker.recover_update(job)
        gold_sha = worker.digest(job / 'gold.json.gz')
        expected = worker.read_json(job / 'gold.json.gz')
        if expected.get('schema_version') == package.VERSION and 'legal_structure' not in expected['layers']:
            return {'run': run, **reference_metadata({'run': run}, out),
                    'status': 'unavailable', 'reason': 'legal_structure_not_annotated'}
        # The document's hierarchy, decided over the whole document, where its layer exists.
        expected = hierarchy_pass.apply(job, expected)
        reference_sha = worker.fingerprint(evaluate.state_of(expected)[1])
        value = worker.read_json(Path(candidate))
        if structure:
            value['structure'] = json.loads(Path(structure).read_text(encoding='utf-8'))
        result = evaluate.compare(expected, value)
        worker.require(worker.digest(job / 'gold.json.gz') == gold_sha, 'Gold changed during scoring')
        return {'run': run, **reference_metadata({'run': run}, out),
                'gold_sha256': gold_sha, 'gold_state_sha256': reference_sha, **result}
    except Exception as error:
        return {'run': run, 'error': str(error)[-600:]}


def aggregate(rows):
    totals = {}
    for row in rows:
        for name, metric in row['metrics'].items():
            total = totals.setdefault(name, {'expected': 0, 'predicted': 0, 'correct': 0})
            for key in total: total[key] += metric[key]
    for total in totals.values():
        p = total['correct'] / total['predicted'] if total['predicted'] else 1.0
        r = total['correct'] / total['expected'] if total['expected'] else 1.0
        total.update(precision=p, recall=r, f1=2 * p * r / (p + r) if p + r else 0.0)
    return totals


def compare(before, after, layers=None, out=ROOT / 'benchmarks/local-data/legal-structure-gold'):
    """The change from one summary to another over the runs both scored, per mode: per layer, the
    pooled F1 of each, and per document how many got better or worse and the mean and median
    change, so neither a few large documents nor many tiny ones decide alone."""
    def indexed(summary):
        result = {}
        for row in summary['per_run']:
            row = {**row, **reference_metadata(row, out)}
            key = (row['source_sha256'], row['mode'])
            worker.require(key not in result, 'Repeated source/mode in score summary')
            result[key] = row
        return result
    earlier, later = indexed(before), indexed(after)
    common = [run for run in later if run in earlier]
    def f1(m):
        p = m['correct'] / m['predicted'] if m['predicted'] else (1.0 if not m['expected'] else 0.0)
        r = m['correct'] / m['expected'] if m['expected'] else (1.0 if not m['predicted'] else 0.0)
        return 2 * p * r / (p + r) if p + r else 0.0
    for mode in sorted({key[1] for key in common}):
        runs = [key for key in common if key[1] == mode]
        pooled_before = aggregate([earlier[run] for run in runs]); pooled_after = aggregate([later[run] for run in runs])
        print(f"\n{mode}: {len(runs)} runs in common")
        changed, unknown = [], []
        for key in runs:
            left, right = earlier[key], later[key]
            identity = 'gold_state_sha256' if left.get('gold_state_sha256') and right.get('gold_state_sha256') else 'gold_sha256'
            if not left.get(identity) or not right.get(identity): unknown.append(key[0])
            elif left[identity] != right[identity]: changed.append(key[0])
        if changed:
            print('Reference identities differ; deltas also reflect changed Gold references: ' + ', '.join(changed))
        if unknown:
            print(f'{len(unknown)} saved references lack a comparable identity; reference equality is unverified')
        print(f"{'layer':20} {'F1 before':>9} {'after':>7} {'delta':>7}   {'better':>6} {'worse':>6} {'mean':>8} {'median':>8}")
        for name in sorted(pooled_after):
            if layers and name not in layers: continue
            deltas = [f1(later[run]['metrics'][name]) - f1(earlier[run]['metrics'][name]) for run in runs
                      if name in earlier[run]['metrics'] and name in later[run]['metrics']
                      and (later[run]['metrics'][name]['expected'] or later[run]['metrics'][name]['predicted'] or earlier[run]['metrics'][name]['predicted'])]
            if not deltas: continue
            b, a = pooled_before[name]['f1'], pooled_after[name]['f1']
            print(f"{name:20} {b:9.3f} {a:7.3f} {a - b:+7.3f}   {sum(d > 1e-9 for d in deltas):6} {sum(d < -1e-9 for d in deltas):6}"
                  f" {statistics.mean(deltas):+8.4f} {statistics.median(deltas):+8.4f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, default=ROOT / 'benchmarks/local-data/legal-structure-gold')
    parser.add_argument('--saved', action='store_true', help="Score each run's saved baseline")
    parser.add_argument('--against', type=Path, help='Earlier summary to compare with')
    parser.add_argument('--workers', type=int, default=os.cpu_count() or 8)
    parser.add_argument('--show', action='store_true', help='Print per-run F1 for each layer')
    parser.add_argument('--runs', nargs='*', default=[], help='Score only runs whose source SHA256 starts with one of these')
    parser.add_argument('--mode', choices=('digitalborn', 'ocr', 'packages'), help='Score only runs of this mode')
    parser.add_argument('--tag', help='Write the summary to score/runs/TAG.json (and its replay manifest beside it)')
    parser.add_argument('--replay', type=Path, help="Re-resolve a tagged run's dumped engine inputs (TAG.manifest.json) with the replay example; no parsing")
    parser.add_argument('--layers', help='Comma-separated layers to show in --against')
    parser.add_argument('--rescore', help="Score a tagged run's candidates again, parsing nothing (a scorer change)")
    args = parser.parse_args()
    unavailable = []
    items = [r for r in completed(args.out, unavailable) if (not args.runs or any(r[2]['source_sha256'].startswith(p) for p in args.runs))
             and (not args.mode or r[0] == args.mode)]
    unavailable = [r for r in unavailable if (not args.runs or any(r['source_sha256'].startswith(p) for p in args.runs))
                   and (not args.mode or r['mode'] == args.mode)]
    started = time.time()
    errors, dumps = {}, {}
    if args.rescore:
        sources = {row['run']: (row['candidate'], None) for row in worker.read_json(args.out / 'score' / 'runs' / f'{args.rescore}.manifest.json')}
    elif args.replay:
        sources = {run: files for run, files in replay_all(args.replay, args.out).items()}
    elif args.saved:
        sources = {str(job.relative_to(args.out)): (str(job / receipt.get('artifact_paths', {}).get('baseline', 'baseline.json.gz')), None)
                   for _, job, receipt in items}
    else:
        produced, errors = extract_all(items, args.out, args.workers) if items else ({}, {})
        sources = {run: (file, None) for run, (file, _, _) in produced.items()}
        dumps = {run: (dump, witnesses) for run, (_, dump, witnesses) in produced.items() if dump and Path(dump).is_file()}
    parsed = time.time()
    with ProcessPoolExecutor(args.workers) as pool:
        results = list(pool.map(score_one, [(run, str(args.out), c, s) for run, (c, s) in sources.items()], chunksize=4))
    results += [{'run': run, 'error': error} for run, error in errors.items()]
    scored = [r for r in results if 'metrics' in r]
    summary = {'source': 'rescore' if args.rescore else 'replay' if args.replay else 'saved' if args.saved else 'addon', 'runs': len(results),
               'errors': [r for r in results if 'error' in r], 'totals': aggregate(scored),
               'unavailable': unavailable + [r for r in results if r.get('status') == 'unavailable'],
               'per_run': [{'run': r['run'], **{key:r[key] for key in ('source_sha256','mode','gold_sha256','gold_state_sha256','alignment','text')},
                            'metrics': {k: {c: v[c] for c in ('expected', 'predicted', 'correct', 'f1')}
                                                          for k, v in r['metrics'].items()}} for r in scored]}
    destination = (args.out / 'score' / 'runs' / f'{args.tag}.json' if args.tag else
                   args.out / 'score' / ('saved.json' if args.saved else 'subset.json' if (args.runs or args.mode) else 'latest.json'))
    worker.write_json(destination, summary)
    if dumps:
        references = {row['run']: row for row in scored}
        worker.write_json(destination.with_suffix('.manifest.json'),
                          [{'run': run, **reference_metadata({'run': run}, args.out),
                            **{key: references[run][key] for key in ('gold_sha256','gold_state_sha256') if run in references},
                            'candidate': sources[run][0], 'dump': dump, 'witnesses': witnesses}
                           for run, (dump, witnesses) in dumps.items()])
    print(f"{summary['runs']} runs, {len(summary['errors'])} errors, {len(summary['unavailable'])} unannotated sources -> {destination} "
          f"(parse {parsed - started:.0f}s, score {time.time() - parsed:.0f}s)")
    if TIMINGS:
        slowest = sorted(TIMINGS.items(), key=lambda item: -item[1])[:8]
        print(f"structure stage {sum(TIMINGS.values()) / 1000:.0f}s in all; slowest: " + ", ".join(f"{run.split(os.sep)[1][:12]} {ms / 1000:.1f}s" for run, ms in slowest))
    if args.against:
        compare(worker.read_json(args.against), summary, set(args.layers.split(',')) if args.layers else None, args.out)
    else:
        print(f"{'layer':22} {'exp':>6} {'pred':>6} {'P':>6} {'R':>6} {'F1':>6}")
        for name, t in sorted(summary['totals'].items()):
            print(f"{name:22} {t['expected']:6} {t['predicted']:6} {t['precision']:6.3f} {t['recall']:6.3f} {t['f1']:6.3f}")
    if args.show:
        for row in summary['per_run']:
            print(row['run'], ' '.join(f"{k}={v['f1']:.2f}" for k, v in sorted(row['metrics'].items())))
    for error in summary['errors']: print('ERROR', error['run'], error['error'][-300:], file=sys.stderr)


def pdf_path(sha):
    row = corpus_store.connect().execute('select path from files where sha256=?', (sha,)).fetchone()
    return corpus_store.HOME / row[0]


if __name__ == '__main__': main()
