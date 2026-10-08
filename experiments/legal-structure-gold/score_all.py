"""Score the current native addon against every completed gold run, per layer.

Each gold PDF is parsed again by the most recently built addon (extract.mjs) and
compared with its gold. Totals are micro-averaged over all runs. `--saved`
scores each run's saved baseline instead. The latest summary is written to
<out>/score/latest.json; `--against` prints the change from an earlier summary.
"""
import argparse
import hashlib
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import worker
import evaluate
import corpus_store

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


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


def candidate(pdf, mode, cache, request):
    # Parse with the request the gold was made from, so source lines stay comparable.
    # Its Tesseract timeout only bounds the wait, so a loaded machine may wait longer.
    if request.get('ocr', {}).get('provider') == 'tesseract':
        request = {**request, 'ocr': {**request['ocr'], 'settings': {**request['ocr'].get('settings', {}), 'timeout_seconds': 1200}}}
    cache.mkdir(parents=True, exist_ok=True)
    # Copy an earlier build's recognition forward (its cache key names the OCR code), so a
    # new build reruns extraction and structure but not OCR.
    sha, binary = worker.digest(pdf), addon_sha256()
    for previous in sorted((cache / sha).glob('*/*/parse-v1/recognition'), key=lambda p: p.stat().st_mtime, reverse=True):
        target = cache / sha / binary / previous.parents[1].name / 'parse-v1' / 'recognition'
        if previous.parents[2].name != binary and not target.exists():
            shutil.copytree(previous, target)
    saved = cache / f'request-{worker.fingerprint(request)[:16]}.json'
    saved.write_text(json.dumps(request), encoding='utf-8')
    process = subprocess.run(['node', str(HERE / 'extract.mjs'), str(pdf), str(cache), mode, str(saved)],
        capture_output=True, text=True, encoding='utf-8',
        creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS if sys.platform == 'win32' else 0)
    if process.returncode: raise RuntimeError(process.stderr[-1500:])
    return Path(process.stdout.strip().splitlines()[-1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'benchmarks/local-data/legal-structure-gold')
    parser.add_argument('--saved', action='store_true', help="Score each run's saved baseline")
    parser.add_argument('--against', type=Path, help='Earlier summary to compare with')
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--show', action='store_true', help='Print per-run F1 for each layer')
    parser.add_argument('--runs', nargs='*', default=[], help='Score only runs whose source SHA256 starts with one of these')
    args = parser.parse_args()
    runs = [r for r in completed(args.out) if not args.runs or any(r[1].parent.name.startswith(p) for p in args.runs)]
    earlier = {row['run']: row for row in worker.read_json(args.against)['per_run'] if 'metrics' in row} if args.against else {}
    cache = args.out / 'score' / 'candidates'

    def score(item):
        mode, job, receipt = item
        try:
            path = job / 'baseline.json.gz'
            expected = worker.read_json(job / 'gold.json.gz')
            if not args.saved:
                path = candidate(pdf_path(receipt['source_sha256']), mode, cache,
                                 # The earliest golds predate recording it; they read native text only.
                                 expected['provenance']['configuration'].get('parser', {}).get('request', {}))
            result = evaluate.compare(expected, worker.read_json(path))
            return {'run': str(job.relative_to(args.out)), 'pages': receipt.get('pages'), **result}
        except Exception as error:
            return {'run': str(job.relative_to(args.out)), 'error': str(error)[-600:]}

    with ThreadPoolExecutor(args.workers) as pool: results = list(pool.map(score, runs))
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
    scored = [r for r in results if 'metrics' in r]
    totals = aggregate(scored)
    summary = {'source': 'saved' if args.saved else 'addon', 'runs': len(results),
               'pages': sum(r.get('pages') or 0 for r in results),
               'errors': [r for r in results if 'error' in r], 'totals': totals,
               'per_run': [{'run': r['run'], 'metrics': {k: {c: v[c] for c in ('expected', 'predicted', 'correct', 'f1')}
                                                          for k, v in r['metrics'].items()}} for r in scored]}
    destination = args.out / 'score' / ('saved.json' if args.saved else 'subset.json' if args.runs else 'latest.json')
    worker.write_json(destination, summary)
    # Compare only the runs both summaries scored, so new gold does not move the deltas.
    before = {}
    if args.against:
        common = [row for row in scored if row['run'] in earlier]
        before, now = aggregate([earlier[row['run']] for row in common]), aggregate(common)
        print(f"{len(common)} runs in common with {args.against.name}")
    print(f"{summary['runs']} runs, {summary['pages']} pages, {len(summary['errors'])} errors -> {destination}")
    print(f"{'layer':22} {'exp':>6} {'pred':>6} {'P':>6} {'R':>6} {'F1':>6}" + ('   dF1' if before else ''))
    for name, t in sorted(totals.items()):
        delta = f"{now[name]['f1'] - before[name]['f1']:+6.3f}" if name in before else ''
        print(f"{name:22} {t['expected']:6} {t['predicted']:6} {t['precision']:6.3f} {t['recall']:6.3f} {t['f1']:6.3f} {delta}")
    if args.show:
        for row in summary['per_run']:
            print(row['run'], ' '.join(f"{k}={v['f1']:.2f}" for k, v in sorted(row['metrics'].items())))
    for error in summary['errors']: print('ERROR', error['run'], error['error'], file=sys.stderr)


def pdf_path(sha):
    row = corpus_store.connect().execute('select path from files where sha256=?', (sha,)).fetchone()
    return corpus_store.HOME / row[0]


if __name__ == '__main__': main()
