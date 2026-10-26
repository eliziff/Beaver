"""Run only the split prerequisite for an existing structure-authoring queue.

Completed full-source split/structure gold is referenced, never authored twice.
New annotations remain a separate cohort until family/exposure reconciliation.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace


def select(rows, covered):
    unique = {}
    for row in rows:
        sha = row['sha256']
        if sha in unique and any(unique[sha].get(k) != row.get(k) for k in ('pages', 'mode', 'split')):
            raise ValueError('Conflicting queued source identities')
        unique.setdefault(sha, row)
    return list(unique.values()), [r for s, r in unique.items() if s not in covered]


def resolve_rows(rows, bases, locations):
    result=[]
    for row in rows:
        path=Path(row['path'])
        candidates=([path] if path.is_absolute() else [base/path for base in bases])
        candidates += [Path(p) for p in locations.get(row['sha256']+'.pdf',[])]
        found=next((p.resolve() for p in candidates if p.is_file()),None)
        result.append({**row,'path':str(found or path)})
    return result


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('--root', required=True, type=Path)
    p.add_argument('--manifest', required=True, type=Path)
    p.add_argument('--code-root', required=True, type=Path)
    p.add_argument('--parsed', required=True, type=Path)
    p.add_argument('--existing-split-root', required=True, type=Path)
    p.add_argument('--workers', type=int, default=8)
    p.add_argument('--max-calls', type=int, default=10000)
    p.add_argument('--execute', action='store_true')
    a = p.parse_args()
    if a.workers < 1 or a.max_calls < 1: p.error('Positive worker/call limits required')
    sys.path[:0] = [str(a.code_root/'experiments/page-stream-segmentation'),
                    str(a.code_root/'experiments/legal-structure-gold'), str(a.code_root/'tools')]
    import cohort
    import annotate
    from boundary_data import atomic_json, digest, fingerprint
    from codex_runner.transport import invoke
    out = a.root/'gold-expansion'
    out.mkdir(exist_ok=True)
    index = json.loads((a.root/'gold-store/page-stream-gold/index.json').read_bytes())
    authority = a.existing_split_root/'authoring-splits.json'
    if digest(authority) != index['existing_gold_sha256']:
        raise ValueError('Existing split gold differs from the private catalogue')
    full = json.loads(authority.read_bytes())['sources']
    documents = json.loads((authority.parent/'authoring-manifest-all.json').read_bytes())['documents']
    counts = {d['sha256']:d['pages'] for d in documents}
    reviewed = {}
    for s in full:
        reviewed.setdefault(s['sha256'],set()).update(s.get('pages',range(1,counts[s['sha256']]+1)))
    covered = {sha for sha,pages in reviewed.items() if pages == set(range(1,counts[sha]+1))}
    covered.update(r['sha256'] for r in index['structure_gold_sources'])
    resolution=out/'source-resolution.json'
    locations=json.loads(resolution.read_bytes())['matches'] if resolution.exists() else {}
    input_rows=resolve_rows(json.loads(a.manifest.read_bytes())['documents'],
        [a.manifest.parent,a.parsed,a.code_root],locations)
    rows, pending = select(input_rows, covered)
    available = [r for r in pending if Path(r['path']).is_file()]
    unavailable = [r for r in pending if not Path(r['path']).is_file()]
    manifest = out/'manifest.json'
    selected = {'documents': available}
    if manifest.exists() and any((out/'annotations').glob('*/gold.json')) and json.loads(manifest.read_bytes()) != selected:
        raise ValueError('Queued selection changed; reconcile the saved cohort first')
    atomic_json(manifest, selected)
    source_inventory = out/'empty-inventory.json'
    atomic_json(source_inventory, {'sources': []})
    options = SimpleNamespace(manifest=manifest, dataset=source_inventory, out=out,
        home=Path('C:/Users/elias/AppData/Local/OpenLegalData'), parsed=a.parsed,
        run_id=fingerprint(['queued-gold-splits', digest(a.manifest)]))
    sources = cohort.selection(options)
    plan = dict(origin='machine_test', run_id=options.run_id,
        manifest_sha256=digest(a.manifest), queued_unique=len(rows),
        reused_full_source_gold=len(rows)-len(pending), pending_available=len(available),
        pending_unavailable=len(unavailable), unavailable=unavailable,
        planned_pages=sum(r['pages'] for r in available),
        planned_windows=sum(len(annotate.windows(s['review_pages'],s['page_count'],batch_pages=8)) for s in sources),
        partitions=dict(Counter(r.get('split','unassigned') for r in available)),
        policy='Existing gold is referenced. New annotations require family/exposure reconciliation before training; final holdout stays excluded.')
    atomic_json(out/'queue-plan.json', plan)
    print(json.dumps({k:v for k,v in plan.items() if k != 'unavailable'}), flush=True)
    if not a.execute: return
    spent = sum(len(json.loads(f.read_bytes())['attempts']) for f in (out/'annotations').glob('*/calls/*/*/receipt.json'))
    lock = threading.Lock()
    def dispatch(**kwargs):
        nonlocal spent
        with lock:
            if spent >= a.max_calls: raise RuntimeError('Queued split call budget reached')
            spent += 1
        return invoke(**kwargs)
    records = []
    def process(source):
        cohort.prepare_source(source, options)
        return cohort.author_source(source, options, dispatch)
    try:
        with ThreadPoolExecutor(max_workers=a.workers) as pool:
            futures = {pool.submit(process, s):s for s in sources}
            for f in as_completed(futures):
                source=futures[f]
                try: records.append(f.result())
                except Exception as exc:
                    records.append(dict(sha256=source['sha256'],status='failed',error=str(exc)[-1200:]))
                atomic_json(out/'progress.json',dict(origin='machine_test',run_id=options.run_id,
                    model_invocations=spent,finished_sources=len(records),selected_sources=len(sources),
                    statuses=dict(Counter(r['status'] for r in records)),records=records))
                print(json.dumps(dict(finished=len(records),calls=spent,status=records[-1]['status'])),flush=True)
    finally:
        cohort.export(sources, options, records)


if __name__ == '__main__': main()
