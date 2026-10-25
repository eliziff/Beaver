"""Author economy splits for a structure-gold cohort, then flag candidates for correction."""
import argparse
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
import re
import threading
import time
from types import SimpleNamespace

from boundary_data import (DEFAULT_OUT, ROOT, annotation_decisions, atomic_json, corpus_home,
                           digest, fingerprint, read_json, source_path)
import annotate
from author import split
from codex_runner.transport import invoke


def source_home(source, args):
    return Path(source.get('home', args.home))


def selection(args):
    inventory = {r['sha256']: r for r in read_json(args.dataset)['sources']}
    sources, unresolved = [], []
    for row in read_json(args.manifest)['documents']:
        sha = row['sha256']
        source = inventory.get(sha)
        pdf = source_path(source, args.home) if source else Path(row['path'])
        if not pdf.is_file() and Path(row['path']).is_file():
            pdf, source = Path(row['path']), None
        if not pdf.is_file():
            unresolved.append({'sha256': sha, 'recorded_path': str(pdf), 'pages': row['pages']})
        pdf = pdf.resolve()
        owner = ROOT if pdf.is_relative_to(ROOT) else args.home if pdf.is_relative_to(args.home) else Path(pdf.anchor)
        if source is None:
            source = {'sha256': sha, 'family_id': sha, 'split': 'unassigned',
                      'kinds': ['structure'], 'labels': {}, 'within_page': []}
        sources.append({**source, 'storage': 'repository' if owner == ROOT else 'openlegaldata',
                        'home': str(owner), 'path': pdf.relative_to(owner).as_posix(),
                        'page_count': row['pages'], 'mode': row['mode'],
                        'review_gaps': list(range(2, row['pages'] + 1)),
                        'review_pages': list(range(1, row['pages'] + 1))})
    sources.sort(key=lambda s: (-s['page_count'], s['sha256']))
    value = {'schema_version': 'page-stream-dataset.v1', 'sources': sources}
    selected = args.out / 'dataset.json'
    if selected.exists():
        def identity(rows):
            return [{k: v for k, v in r.items() if k not in {'home', 'storage', 'path', 'local_pdf'}} for r in rows]
        if identity(read_json(selected)['sources']) != identity(sources):
            raise ValueError('Cohort selection changed; reconcile the retained selection before resuming')
    atomic_json(selected, value)
    atomic_json(args.out / 'selection.json', {'origin': 'machine_test', 'run_id': args.run_id,
        'manifest_sha256': digest(args.manifest), 'dataset_sha256': digest(args.dataset),
        'selected_pdfs': len(sources), 'selected_pages': sum(s['page_count'] for s in sources),
        'planned_batches': sum(len(annotate.windows(s['review_pages'], s['page_count'], batch_pages=8)) for s in sources),
        'pending_original_paths': unresolved})
    return sources


def prepare_source(source, args):
    pdf = source_path(source, source_home(source, args))
    if digest(pdf) != source['sha256']:
        raise ValueError('Original SHA differs from cohort selection')
    annotate.packet_lines(source, pdf, args.out / 'annotations' / source['sha256'], parsed=args.parsed)
    return source


def author_source(source, args, dispatch):
    count = len(annotate.windows(source['review_pages'], source['page_count'], batch_pages=8))
    options = SimpleNamespace(dataset=args.out / 'dataset.json', out=args.out, home=source_home(source, args),
        sources=[source['sha256']], extraction=None, parsed=args.parsed, batch_pages=8,
        execute=True, review=False, model='gpt-6-luna', effort='max', attempts=2,
        timeout=600, max_calls=count * 4, limit=1, windows=count)
    result = annotate.run(options, dispatch, report_path=args.out / 'annotations' / source['sha256'] / 'run.json')
    return {'sha256': source['sha256'], 'status': 'authored', **result}


def inspect_source(source, out):
    job = out / 'annotations' / source['sha256']
    gold = read_json(job / 'gold.json')
    frame = read_json(job / 'packet-extraction.json')
    labels = {p: v for part in gold['sources'] for p, v in annotation_decisions(part, source['page_count']).items()}
    lines = frame['lines']
    pages = {p: [] for p in range(1, source['page_count'] + 1)}
    for line in lines:
        pages[line['page']].append(line)
    flags = []
    for page, own in pages.items():
        starts = labels.get(page)
        if starts is None and page > 1:
            flags.append({'page': page, 'reason': 'unresolved-page'})
            continue
        anchors = [s for s in starts or [] if isinstance(s, dict)]
        if sum(len(l['text'].strip()) for l in own) < 40:
            flags.append({'page': page, 'reason': 'little-extracted-text'})
        opening = '\n'.join(l['text'] for l in own[:10])
        if page in (starts or []):
            if re.search(r'(?im)^(accepted and agreed|in witness whereof|signature page|signed (?:for|on)|execution page)', opening):
                flags.append({'page': page, 'reason': 'possible-detached-execution-page'})
            if re.search(r'(?i)proceeding commenced|lawyers? for', opening) and len(own) < 35:
                flags.append({'page': page, 'reason': 'possible-closing-backsheet'})
        elif page > 1 and re.search(r'(?im)^\s*(?:appendix|annex|schedule|exhibit|attachment|certificate of|special conditions)\b', opening):
            flags.append({'page': page, 'reason': 'possible-missed-attachment'})
        if page > 1 and str(page) in source.get('labels', {}) and starts is not None:
            if int(page in starts) != source['labels'][str(page)]:
                flags.append({'page': page, 'reason': 'differs-from-existing-page-edge-label'})
        for i, line in enumerate(own):
            if re.match(r'\s*From\s*:', line['text'], re.I) and i > 1:
                if not any(s['line_id'] == line['id'] for s in anchors):
                    flags.append({'page': page, 'line_id': line['id'], 'reason': 'possible-missed-email-start'})
    starts = [s for part in gold['sources'] for s in part['document_starts']]
    parts = split(lines, starts)
    assert [l['id'] for part in parts for l in part] == [l['id'] for l in lines]
    assert all(parts), 'A split produced an empty constituent'
    receipt = read_json(job / 'receipt.json')
    return gold['sources'], flags, receipt['status'] == 'complete', len(parts)


def export(sources, args, records):
    complete, flags, incomplete, constituents = [], [], [], 0
    documents = []
    for source in sources:
        job = args.out / 'annotations' / source['sha256']
        if not (job / 'gold.json').exists():
            incomplete.append(source['sha256'])
            continue
        try:
            scopes, review, ready, count = inspect_source(source, args.out)
            flags.extend({'sha256': source['sha256'], **f} for f in review)
            if ready:
                complete.extend(scopes)
                constituents += count
                documents.append({'path': str(source_path(source, source_home(source, args))),
                                  'sha256': source['sha256'], 'mode': source['mode'], 'pages': source['page_count']})
            else:
                incomplete.append(source['sha256'])
        except Exception as exc:
            incomplete.append(source['sha256'])
            flags.append({'sha256': source['sha256'], 'reason': 'split-validation-failed', 'error': str(exc)[:500]})
    atomic_json(args.out / 'gold.json', {'sources': complete})
    atomic_json(args.out / 'authoring-manifest.json', {'documents': documents})
    atomic_json(args.out / 'review.json', {'origin': 'machine_test', 'run_id': args.run_id,
        'policy': 'Flags propose review; no heuristic changes gold. A within-page start cuts only where a second blind pass returns it too.',
        'counts': dict(Counter(f['reason'] for f in flags)), 'flags': flags, 'incomplete_sources': incomplete})
    atomic_json(args.out / 'completion.json', {'origin': 'machine_test', 'run_id': args.run_id,
        'authoring_statuses': dict(Counter(r['status'] for r in records)),
        'complete_sources': len({s['sha256'] for s in complete}), 'incomplete_sources': len(incomplete),
        'draft_constituents': constituents, 'heuristic_flags': len(flags)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=ROOT / 'benchmarks/local-data/legal-structure-gold/cohort-manifest.json')
    parser.add_argument('--dataset', type=Path, default=DEFAULT_OUT / 'dataset.json')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT / 'structure-cohort')
    parser.add_argument('--home', type=Path, default=corpus_home())
    parser.add_argument('--parsed', type=Path, default=ROOT / 'benchmarks/local-data/legal-structure-gold')
    parser.add_argument('--workers', type=int, default=64)
    parser.add_argument('--max-calls', type=int, default=6000)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--export-only', action='store_true')
    args = parser.parse_args()
    args.out, args.home = args.out.resolve(), args.home.resolve()
    args.run_id = fingerprint(['structure-cohort-economy', digest(args.manifest)])
    if args.workers < 1 or args.max_calls < 1:
        parser.error('Worker and call limits must be positive')
    sources = selection(args)
    if not args.execute or args.export_only:
        if args.export_only:
            export(sources, args, [])
        summary = read_json(args.out / 'selection.json')
        print({**{k: v for k, v in summary.items() if k != 'pending_original_paths'},
               'pending_original_paths': len(summary['pending_original_paths'])})
        return
    lock = threading.Lock()
    spent = sum(len(read_json(p)['attempts']) for p in (args.out / 'annotations').glob('*/calls/*/*/receipt.json'))
    def dispatch(**kwargs):
        nonlocal spent
        with lock:
            if spent >= args.max_calls:
                raise RuntimeError('Cohort call limit reached')
            spent += 1
        return invoke(**kwargs)
    records = []
    with ThreadPoolExecutor(max_workers=4) as prep_pool, ThreadPoolExecutor(max_workers=args.workers) as model_pool:
        pending = {prep_pool.submit(prepare_source, s, args): ('prepare', s) for s in sources}
        while pending:
            done, _ = wait(pending, timeout=1, return_when=FIRST_COMPLETED)
            for future in done:
                stage, source = pending.pop(future)
                try:
                    value = future.result()
                    if stage == 'prepare':
                        pending[model_pool.submit(author_source, source, args, dispatch)] = ('author', source)
                        continue
                    records.append(value)
                except Exception as exc:
                    records.append({'sha256': source['sha256'], 'status': 'failed', 'stage': stage, 'error': str(exc)[-1200:]})
                progress = {'origin': 'machine_test', 'run_id': args.run_id, 'workers': args.workers,
                    'model_invocations': spent, 'finished_sources': len(records), 'selected_sources': len(sources),
                    'statuses': dict(Counter(r['status'] for r in records)), 'records': records}
                atomic_json(args.out / 'progress.json', progress)
                print({k: progress[k] for k in ['model_invocations','finished_sources','selected_sources','statuses']}, flush=True)
    export(sources, args, records)


if __name__ == '__main__':
    main()
