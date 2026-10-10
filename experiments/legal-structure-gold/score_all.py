"""Score a native addon against every completed gold run, per layer.

Each gold PDF is parsed again with the request its gold was made from, by a pinned addon
(LEGAL_STRUCTURE_ADDON) or the most recently built: shards of runs in parallel, each loading the
addon once (extract.mjs --batch), long PDFs first, with earlier builds' OCR and extraction carried
forward. Runs are then scored in parallel against their gold with its document-level layer.
Totals are micro-averaged over all runs. `--saved` scores each run's saved baseline instead.

  --mode / --runs     score a subset (written to subset.json unless --tag)
  --tag NAME          write score/runs/NAME.json; with RESOLVER_DUMP=1 also NAME.manifest.json
  --replay MANIFEST   re-resolve the dumped structure-engine inputs with the engine's replay
                      example instead of parsing: an engine change measured in seconds
  --against SUMMARY   per mode, the change in each layer's pooled F1 and, per document, how many
                      got better or worse with the mean and median change

Parser switches (LEVER_*), LAYOUT_PACK/LAYOUT_RUNTIME (layout mode) and RESOLVER_DUMP pass through
the environment.
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
import worker
import hierarchy_pass
import evaluate
import corpus_store

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REPLAY = ROOT / 'native/legal-structure-node/target/release/examples/replay.exe'
TIMINGS = {}


def completed(out):
    for receipt in sorted(out.glob('*/*/*/receipt.json')):
        mode = receipt.parents[2].name
        if mode not in ('digitalborn', 'ocr'): continue
        value = worker.read_json(receipt)
        if value.get('status') == 'complete' and (receipt.parent / 'gold.json.gz').exists():
            yield mode, receipt.parent, value


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


def extract_all(items, out, workers):
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
    shards = [jobs[i::workers] for i in range(workers)]
    produced, errors = {}, {}
    with tempfile.TemporaryDirectory() as temp:
        processes = []
        for n, shard in enumerate(shards):
            listing, log = Path(temp) / f'jobs-{n}.json', Path(temp) / f'out-{n}.jsonl'
            listing.write_text(json.dumps(shard), encoding='utf-8')
            handle = log.open('w', encoding='utf-8')
            processes.append((subprocess.Popen(['node', str(HERE / 'extract.mjs'), '--batch', str(listing)], stdout=handle,
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
        expected = worker.read_json(job / 'gold.json.gz')
        # The document's hierarchy, decided over the whole document, where its layer exists.
        expected = hierarchy_pass.apply(job, expected)
        value = worker.read_json(Path(candidate))
        if structure:
            value['structure'] = json.loads(Path(structure).read_text(encoding='utf-8'))
        result = evaluate.compare(expected, value)
        return {'run': run, **result}
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


def compare(before, after, layers=None):
    """The change from one summary to another over the runs both scored, per mode: per layer, the
    pooled F1 of each, and per document how many got better or worse and the mean and median
    change, so neither a few large documents nor many tiny ones decide alone."""
    earlier = {row['run']: row for row in before['per_run']}
    later = {row['run']: row for row in after['per_run']}
    common = [run for run in later if run in earlier]
    def f1(m):
        p = m['correct'] / m['predicted'] if m['predicted'] else (1.0 if not m['expected'] else 0.0)
        r = m['correct'] / m['expected'] if m['expected'] else (1.0 if not m['predicted'] else 0.0)
        return 2 * p * r / (p + r) if p + r else 0.0
    for mode in sorted({run.split(os.sep)[0].split('/')[0] for run in common}):
        runs = [run for run in common if run.replace('\\', '/').split('/')[0] == mode]
        pooled_before = aggregate([earlier[run] for run in runs]); pooled_after = aggregate([later[run] for run in runs])
        print(f"\n{mode}: {len(runs)} runs in common")
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
    args = parser.parse_args()
    items = [r for r in completed(args.out) if (not args.runs or any(r[1].parent.name.startswith(p) for p in args.runs))
             and (not args.mode or r[0] == args.mode)]
    started = time.time()
    errors, dumps = {}, {}
    if args.replay:
        sources = {run: files for run, files in replay_all(args.replay, args.out).items()}
    elif args.saved:
        sources = {str(job.relative_to(args.out)): (str(job / receipt.get('artifact_paths', {}).get('baseline', 'baseline.json.gz')), None)
                   for _, job, receipt in items}
    else:
        produced, errors = extract_all(items, args.out, args.workers)
        sources = {run: (file, None) for run, (file, _, _) in produced.items()}
        dumps = {run: (dump, witnesses) for run, (_, dump, witnesses) in produced.items() if dump and Path(dump).is_file()}
    parsed = time.time()
    with ProcessPoolExecutor(args.workers) as pool:
        results = list(pool.map(score_one, [(run, str(args.out), c, s) for run, (c, s) in sources.items()], chunksize=4))
    results += [{'run': run, 'error': error} for run, error in errors.items()]
    scored = [r for r in results if 'metrics' in r]
    summary = {'source': 'replay' if args.replay else 'saved' if args.saved else 'addon', 'runs': len(results),
               'errors': [r for r in results if 'error' in r], 'totals': aggregate(scored),
               'per_run': [{'run': r['run'], 'metrics': {k: {c: v[c] for c in ('expected', 'predicted', 'correct', 'f1')}
                                                          for k, v in r['metrics'].items()}} for r in scored]}
    destination = (args.out / 'score' / 'runs' / f'{args.tag}.json' if args.tag else
                   args.out / 'score' / ('saved.json' if args.saved else 'subset.json' if (args.runs or args.mode) else 'latest.json'))
    worker.write_json(destination, summary)
    if dumps:
        worker.write_json(destination.with_suffix('.manifest.json'),
                          [{'run': run, 'candidate': sources[run][0], 'dump': dump, 'witnesses': witnesses}
                           for run, (dump, witnesses) in dumps.items()])
    print(f"{summary['runs']} runs, {len(summary['errors'])} errors -> {destination} "
          f"(parse {parsed - started:.0f}s, score {time.time() - parsed:.0f}s)")
    if TIMINGS:
        slowest = sorted(TIMINGS.items(), key=lambda item: -item[1])[:8]
        print(f"structure stage {sum(TIMINGS.values()) / 1000:.0f}s in all; slowest: " + ", ".join(f"{run.split(os.sep)[1][:12]} {ms / 1000:.1f}s" for run, ms in slowest))
    if args.against:
        compare(worker.read_json(args.against), summary, set(args.layers.split(',')) if args.layers else None)
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
