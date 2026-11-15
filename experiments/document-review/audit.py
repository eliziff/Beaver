"""Offline release checks. Missing independent gold or probes are reported, never silently passed."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import benchmark as b
from pypdf import PdfReader


def audit(item, *, verify_bytes=True):
    folder = b.PRIVATE / 'sets' / item['id']
    path = folder / 'inventory.json'
    if not path.exists():
        return {'set': item['id'], 'ready': False, 'blockers': ['inputs_not_materialized']}
    inv = b.read(path)
    rows = inv['documents']
    by_id = {r['document_id']: r for r in rows}
    scan_review_path = folder / 'scan-review.json'
    scan_reviews = b.read(scan_review_path) if scan_review_path.exists() else {}
    errors, blockers = [], []
    if len(rows) != item['size'] or len(by_id) != len(rows):
        errors.append('size_or_document_identity')
    for row in rows:
        source = row['provenance']
        if row['level'] == 1 and (row['role'] != 'same_filing' or source['record'] != item['seed']):
            errors.append('level_1_scope:' + row['document_id'])
        if row['level'] == 2 and (row['role'] != 'same_litigation' or
                source['group'] != inv['group'] or source['record']==item['seed'] or
                source['record'] not in inv['level_2_source_records']):
            errors.append('level_2_scope:' + row['document_id'])
        asset = b.PRIVATE / row['file']
        if verify_bytes and b.digest(asset) != row['file_sha256']:
            errors.append('asset_changed:' + row['document_id'])
        reader = PdfReader(asset)
        information = json.dumps(dict(reader.metadata or {})).casefold()
        if any(s in information for s in ('orgsmith', 'synthetic', 'benchmark', 'document-review')) or reader.xmp_metadata:
            errors.append('metadata_origin_marker:' + row['document_id'])
        if row['role'] == 'exact_duplicate' and row['file_sha256'] != by_id[row['inherits']]['file_sha256']:
            errors.append('copy_not_byte_identical:' + row['document_id'])
        if row['role'].startswith('scan_'):
            if not row['images']:
                errors.append('scan_missing_images:' + row['document_id'])
            if scan_reviews.get(row['file_sha256'], {}).get('status') != 'accepted':
                blockers.append('scan_legibility_review:' + row['document_id'])
        projection=row.get('projection',{})
        parsed=b.PRIVATE/projection.get('output_file','missing')
        if projection.get('input_sha256')!=row['file_sha256'] or not parsed.exists():
            errors.append('missing_observed_projection:'+row['document_id'])
        elif verify_bytes and b.digest(parsed)!=projection.get('output_sha256'):
            errors.append('observed_projection_changed:'+row['document_id'])
        if row['components']:
            pages = [p for c in row['components'] for p in c['pages']]
            if pages != list(range(1, len(reader.pages) + 1)):
                errors.append('bundle_page_coverage:' + row['document_id'])
        for level in (1, 2, 3):
            model = folder / 'inputs' / f'level-{level}'
            candidate = model / (row['document_id'] + '.pdf')
            if candidate.exists() != (row['level'] <= level):
                errors.append('nested_membership:' + row['document_id'])
            if row['level'] <= level and verify_bytes and b.digest(candidate) != row['file_sha256']:
                errors.append('input_differs_from_inventory:' + row['document_id'])
            if row['level']<=level and candidate.exists() and candidate.stat().st_nlink!=1:
                errors.append('filesystem_link_count_leak:'+row['document_id'])
            if row['level']<=level:
                sidecar=candidate.with_suffix('.txt')
                if not sidecar.exists() or sidecar.read_text('utf-8')!=row['text']:
                    errors.append('input_text_differs_from_observed_projection:'+row['document_id'])
    for level in (1, 2, 3):
        model = folder / 'inputs' / f'level-{level}'
        allowed = {'brief.txt', 'documents.json'} | {r['document_id'] + suffix for r in rows if r['level'] <= level for suffix in ('.pdf', '.txt')}
        if any(p.name not in allowed for p in model.iterdir()):
            errors.append('unexpected_model_visible_file')
    roles = b.Counter(r['role'] for r in rows)
    if any(not roles[r] for r in ('exact_duplicate', 'scan_good', 'scan_poor', 'bundle', 'fictional_record')):
        errors.append('missing_messy_document_type')
    gold_path = folder / 'gold.json'
    if not gold_path.exists():
        blockers.append('independent_gold_not_completed')
    else:
        gold = b.read(gold_path)
        if gold.get('inventory_sha256') != b.digest(path):
            blockers.append('gold_bound_to_different_inputs')
        if gold.get('status') != 'accepted':
            blockers.append('gold_disagreements_not_adjudicated')
        if {r['document_id'] for r in gold['documents']} != by_id.keys():
            errors.append('gold_coverage_differs')
        for level in (1, 2, 3):
            classes = {r['relevance'] for r in gold['documents'] if r['level'] <= level}
            if not {'relevant', 'irrelevant'} <= classes:
                blockers.append(f'level_{level}_missing_relevance_class')
    probes=[]
    held_out=[]
    for receipt in (b.PRIVATE/'blindbox').glob('*/run.json'):
        probe=b.read(receipt)
        truth_path=receipt.parent/'truth.json'
        if not truth_path.exists() or probe.get('status')!='completed':
            continue
        truth=b.read(truth_path)
        if not probe.get('command_count'):
            continue  # A packet-only diagnostic is not a filesystem-agent test.
        if truth['inventories'].get(item['id'])==b.digest(path):
            probes.append(probe)
            if truth.get('partition')=='held_out':
                held_out.append(probe)
    if not probes:
        blockers.append('filesystem_blind_origin_test_not_completed')
    for probe in probes:
        if abs(probe['metrics']['balanced_accuracy']-.5)>.15 or abs(probe['metrics']['roc_auc']-.5)>.15:
            blockers.append('filesystem_blind_origin_shortcut_detected')
    if len(probes)<2:
        blockers.append('repeat_origin_test_not_completed')
    if not held_out:
        blockers.append('held_out_origin_test_not_completed')
    # Threshold is an exploratory alarm; human calibration and held-out repetitions remain required.
    return {'set': item['id'], 'documents': len(rows), 'levels': [sum(r['level'] <= n for r in rows) for n in (1, 2, 3)],
        'roles': dict(roles), 'errors': sorted(set(errors)), 'blockers': sorted(set(blockers)),
        'ready': not errors and not blockers, 'inventory_sha256': b.digest(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sets', nargs='+')
    args = parser.parse_args()
    report = [audit(item) for item in b.spec() if not args.sets or item['id'] in args.sets]
    result = {'origin': 'machine_test', 'run_id': b.RUN, 'sets': report,
              'ready_sets': sum(r['ready'] for r in report), 'target_sets': len(b.spec())}
    b.dump(b.PRIVATE / 'audit-latest.json', result)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
