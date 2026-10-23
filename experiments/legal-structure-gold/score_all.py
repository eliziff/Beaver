"""Score a native addon against every completed v4 gold (<out>/v4/*/gold.json.gz), per layer.

Each gold PDF is parsed again with the app's PDF profile, as its gold was, by a pinned addon
(LEGAL_STRUCTURE_ADDON) or the most recently built: shards of runs in parallel, each loading the
addon once (extract.mjs --batch), long PDFs first, sharing the authoring cache in parsed/ and
carrying earlier builds' OCR and extraction forward. Runs are then scored in parallel against
their gold. Totals are micro-averaged over all runs. PDFs come from the corpus, or from an
authoring manifest (--manifest, as author.py takes).

  --mode / --runs     score a subset (written to subset.json unless --tag)
  --tag NAME          write score/runs/NAME.json and NAME.manifest.json (each run's candidate,
                      engine inputs and witnesses, filed with its cached document)
  --replay MANIFEST   re-resolve the dumped structure-engine inputs with the engine's replay
                      example instead of parsing: an engine change measured in seconds
  --frozen MANIFEST   score against frozen gold files (manifest sources with gold/<sha>.json.gz)
                      instead of <out>/v4; --split picks train, development or test
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
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import subprocess
import sys
sys.path[:0] = [str(Path(__file__).resolve().parents[2] / 'tools'), str(Path(__file__).resolve().parents[2] / 'experiments/legal_pdf_corpus')]
from codex_runner.artifacts import atomic_json as write_json, digest, fingerprint, read_json  # noqa: E402
from gold import require  # noqa: E402
import evaluate  # noqa: E402
import corpus_store  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REPLAY = ROOT / 'native/legal-structure-node/target/release/examples/replay.exe'
TIMINGS = {}


def gold_file(job):
    """A run directory's gold, or a frozen gold file itself."""
    return job if job.name.endswith('.json.gz') else job / 'gold.json.gz'


def frozen(manifest, split=None):
    """Frozen evaluation gold as (mode, gold file, metadata), in the manifest's order."""
    manifest = manifest.resolve()
    rows = read_json(manifest)['sources']
    for sha, row in sorted(rows.items()):
        if split and row['split'] != split: continue
        target = manifest.parent / 'gold' / f'{sha}.json.gz'
        require(digest(target) == row['frozen_sha256'], 'Frozen gold changed')
        yield row['mode'], target, {'source_sha256': sha, 'mode': row['mode'], 'split': row['split'], 'pages': row['pages']}


def reference_metadata(row, out=ROOT / 'benchmarks/local-data/legal-structure-gold'):
    """Resolve an explicit saved reference without deriving identity from its path."""
    if row['run'].startswith('frozen-eval'):
        sha = Path(row['run']).name.split('.')[0]
        return {'source_sha256': sha, 'mode': read_json(out / 'frozen-eval' / 'manifest.json')['sources'][sha]['mode']}
    result = {key: row[key] for key in ('source_sha256', 'mode') if key in row}
    if len(result) < 2:
        receipt = read_json(Path(out) / row['run'] / 'receipt.json')
        saved = {'source_sha256': receipt['source_sha256'], 'mode': receipt['mode']}
        require(all(saved[key] == value for key, value in result.items()), 'Saved source metadata differs')
        result = saved
    return result


def completed(out):
    """Completed v4 golds as (mode, run directory, receipt)."""
    for receipt in sorted(out.glob('v4/*/receipt.json')):
        value = read_json(receipt)
        if value.get('status') == 'complete' and (receipt.parent / 'gold.json.gz').is_file():
            yield value['mode'], receipt.parent, value


def addon_sha256():
    # The addon extract.mjs will load: a pinned one, or the most recently built.
    pinned = os.environ.get('LEGAL_STRUCTURE_ADDON') or os.environ.get('LEGAL_STRUCTURE_NATIVE')
    built = [ROOT / 'native/legal-structure-node/target' / p / 'legal_structure_node.dll' for p in ('debug', 'release')]
    chosen = Path(pinned) if pinned else max((p for p in built if p.exists()), key=lambda p: p.stat().st_mtime)
    return hashlib.sha256(chosen.read_bytes()).hexdigest()


def carry(cache, sha, binary):
    # An earlier build's recognition and extraction, hard-linked forward: their cache keys name
    # the OCR and extraction code, so a structure-only build reuses them and any other misses
    # them. Each request keeps its own; a layout parse reuses its plain request's.
    root = cache / sha
    layout = '-layout' if os.environ.get('LAYOUT_PACK') else ''
    if not root.is_dir(): return
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


def extract_all(items, out, workers, pdfs, env=None):
    """Parse every run's PDF with the addon loaded once per shard: shards in parallel, long PDFs
    first. Returns {run: (candidate file, engine dump or None)} and {run: error}."""
    cache, binary = out / 'parsed', addon_sha256()
    jobs, runs = [], {}
    for mode, job, receipt in items:
        pdf = pdf_path(receipt['source_sha256'], pdfs)
        jobs.append({'pdf': str(pdf), 'output': str(cache), 'mode': mode})
        runs[(str(pdf), mode)] = str(job.relative_to(out))
    with ThreadPoolExecutor(16) as pool:
        list(pool.map(lambda item: carry(cache, item[2]['source_sha256'], binary), items))
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
    rows = read_json(manifest)
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
        gold_sha = digest(gold_file(job))
        expected = read_json(gold_file(job))
        reference_sha = fingerprint(evaluate.state_of(expected)[1])
        value = read_json(Path(candidate))
        if structure:
            value['structure'] = json.loads(Path(structure).read_text(encoding='utf-8'))
        result = evaluate.compare(expected, value)
        require(digest(gold_file(job)) == gold_sha, 'Gold changed during scoring')
        return {'run': run, **reference_metadata({'run': run}, out),
                'gold_sha256': gold_sha, 'gold_state_sha256': reference_sha, **result}
    except Exception as error:
        return {'run': run, 'error': str(error)[-600:]}


def score_sources(sources, out, workers):
    """Report completed documents even when an earlier, longer document is still running."""
    started = time.time()
    finished, errors = {}, 0
    progress = out / 'score' / 'progress.json'
    def report():
        try:
            write_json(progress, {'stage': 'metrics', 'completed': len(finished), 'total': len(sources),
                                  'errors': errors, 'started_at': started, 'updated_at': time.time()})
        except PermissionError:
            # A Windows reader can briefly prevent replacement; progress must not discard scores.
            pass
    report()
    with ProcessPoolExecutor(workers) as pool:
        futures = [pool.submit(score_one, (run, str(out), candidate, structure))
                   for run, (candidate, structure) in sources.items()]
        for future in as_completed(futures):
            result = future.result()
            finished[result['run']] = result
            errors += 'error' in result
            report()
            print(f"Scored {len(finished)}/{len(sources)} ({errors} errors)", flush=True)
    return [finished[run] for run in sources]


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
            require(key not in result, 'Repeated source/mode in score summary')
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
    parser.add_argument('--against', type=Path, help='Earlier summary to compare with')
    parser.add_argument('--workers', type=int, default=os.cpu_count() or 8)
    parser.add_argument('--parse-workers', type=int, help='PDF parsing processes (default: --workers)')
    parser.add_argument('--show', action='store_true', help='Print per-run F1 for each layer')
    parser.add_argument('--runs', nargs='*', default=[], help='Score only runs whose source SHA256 starts with one of these')
    parser.add_argument('--mode', choices=('digitalborn', 'ocr'), help='Score only runs of this mode')
    parser.add_argument('--tag', help='Write the summary to score/runs/TAG.json (and its replay manifest beside it)')
    parser.add_argument('--replay', type=Path, help="Re-resolve a tagged run's dumped engine inputs (TAG.manifest.json) with the replay example; no parsing")
    parser.add_argument('--layers', help='Comma-separated layers to show in --against')
    parser.add_argument('--frozen', type=Path, help='Score against this frozen-eval manifest')
    parser.add_argument('--split', choices=('train', 'development', 'test'), help='With --frozen, score only this split')
    parser.add_argument('--rescore', help="Score a tagged run's candidates again, parsing nothing (a scorer change)")
    parser.add_argument('--manifest', type=Path, help='Find PDFs outside the corpus by an authoring manifest: {documents: [{path}]}')
    parser.add_argument('--root', type=Path, help='Base for manifest paths (default: the manifest directory)')
    args = parser.parse_args()
    if os.environ.get('LEGAL_STRUCTURE_NATIVE') and not os.environ.get('LEGAL_STRUCTURE_ADDON'):
        os.environ['LEGAL_STRUCTURE_ADDON'] = os.environ['LEGAL_STRUCTURE_NATIVE']
    source = frozen(args.frozen, args.split) if args.frozen else completed(args.out)
    items = [r for r in source if (not args.runs or any(r[2]['source_sha256'].startswith(p) for p in args.runs))
             and (not args.mode or r[0] == args.mode)]
    pdfs = {}
    if args.manifest:
        base = args.root or args.manifest.parent
        for row in read_json(args.manifest)['documents']:
            pdfs[digest(base / row['path'])] = (base / row['path']).resolve()
    started = time.time()
    errors, dumps = {}, {}
    if args.rescore:
        sources = {row['run']: (row['candidate'], None) for row in read_json(args.out / 'score' / 'runs' / f'{args.rescore}.manifest.json')}
    elif args.replay:
        sources = {run: files for run, files in replay_all(args.replay, args.out).items()}
    else:
        produced, errors = extract_all(items, args.out, args.parse_workers or args.workers, pdfs) if items else ({}, {})
        sources = {run: (file, None) for run, (file, _, _) in produced.items()}
        dumps = {run: (dump, witnesses) for run, (_, dump, witnesses) in produced.items() if dump and Path(dump).is_file()}
    parsed = time.time()
    results = score_sources(sources, args.out, args.workers)
    results += [{'run': run, 'error': error} for run, error in errors.items()]
    scored = [r for r in results if 'metrics' in r]
    summary = {'source': 'rescore' if args.rescore else 'replay' if args.replay else 'addon', 'runs': len(results),
               'errors': [r for r in results if 'error' in r], 'totals': aggregate(scored),
               'addon_sha256': None if args.rescore or args.replay else addon_sha256(),
               'frozen': str(args.frozen) if args.frozen else None, 'split': args.split,
               'per_run': [{'run': r['run'], 'parse_ms': TIMINGS.get(r['run']), **{key:r[key] for key in ('source_sha256','mode','gold_sha256','gold_state_sha256','alignment','text')},
                            'metrics': {k: {c: v[c] for c in ('expected', 'predicted', 'correct', 'f1')}
                                                          for k, v in r['metrics'].items()}} for r in scored]}
    destination = (args.out / 'score' / 'runs' / f'{args.tag}.json' if args.tag else
                   args.out / 'score' / ('subset.json' if (args.runs or args.mode) else 'latest.json'))
    write_json(destination, summary)
    if dumps:
        references = {row['run']: row for row in scored}
        write_json(destination.with_suffix('.manifest.json'),
                          [{'run': run, **reference_metadata({'run': run}, args.out),
                            **{key: references[run][key] for key in ('gold_sha256','gold_state_sha256') if run in references},
                            'candidate': sources[run][0], 'dump': dump, 'witnesses': witnesses}
                           for run, (dump, witnesses) in dumps.items()])
    print(f"{summary['runs']} runs, {len(summary['errors'])} errors -> {destination} "
          f"(parse {parsed - started:.0f}s, score {time.time() - parsed:.0f}s)")
    if TIMINGS:
        slowest = sorted(TIMINGS.items(), key=lambda item: -item[1])[:8]
        print(f"structure stage {sum(TIMINGS.values()) / 1000:.0f}s in all; slowest: " + ", ".join(f"{run.split(os.sep)[1][:12]} {ms / 1000:.1f}s" for run, ms in slowest))
    if args.against:
        compare(read_json(args.against), summary, set(args.layers.split(',')) if args.layers else None, args.out)
    else:
        print(f"{'layer':22} {'exp':>6} {'pred':>6} {'P':>6} {'R':>6} {'F1':>6}")
        for name, t in sorted(summary['totals'].items()):
            print(f"{name:22} {t['expected']:6} {t['predicted']:6} {t['precision']:6.3f} {t['recall']:6.3f} {t['f1']:6.3f}")
    if args.show:
        for row in summary['per_run']:
            print(row['run'], ' '.join(f"{k}={v['f1']:.2f}" for k, v in sorted(row['metrics'].items())))
    for error in summary['errors']: print('ERROR', error['run'], error['error'][-300:], file=sys.stderr)


def pdf_path(sha, pdfs):
    if sha in pdfs: return pdfs[sha]
    row = corpus_store.connect().execute('select path from files where sha256=?', (sha,)).fetchone()
    require(row is not None, f'Source PDF {sha} is in neither the manifest nor the corpus')
    return corpus_store.HOME / row[0]


if __name__ == '__main__': main()
