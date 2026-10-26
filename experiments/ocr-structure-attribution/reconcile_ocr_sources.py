"""Resolve a frozen inventory's canonical PDFs and text-only structure variants."""
import argparse
import gzip
import json
from pathlib import Path

from gold_inventory import read


def reconcile(snapshot, recovery, verification, repository, tag):
    assets = {a['name']: a for a in recovery['archives']}
    pixels = recovery['pixels']
    for value in pixels.values():
        value.update({'repo': repository, 'tag': tag, 'asset_sha256': assets[value['asset']]['sha256']})
    rows = snapshot['rows']
    original_identities = len({r['source_sha256'] for r in rows})
    by_source = {}
    for row in rows:
        if row['collection'] == 'desktop-current-v4':
            by_source[row['source_sha256']] = row
        if row['source_sha256'] in pixels:
            row['pixel_locator'] = pixels[row['source_sha256']]
    by_artifact = {r['artifact_sha256']: r for r in rows}
    for check in verification['checks']:
        row = by_artifact[check['artifact_sha256']]
        parent = by_source[check['synthetic_of']]
        if not check['equal_corrected_targets'] or parent['artifact_sha256'] != check['parent_artifact_sha256']:
            raise ValueError('Synthetic duplicate verification is stale or contradictory')
        row.update({'kind': 'synthetic_structure_variant', 'qualification': 'excluded_derivative',
                    'authority': 'derived_structure_fixture', 'source_sha256': check['synthetic_of'],
                    'ocr_sha256': parent['ocr_sha256'], 'pixel_locator': parent['pixel_locator'],
                    'geometry_locator': parent['geometry_locator']})
        row['notes'].update({'synthetic_source_identity': check['source_identity'],
                             'synthetic_of': check['synthetic_of'], 'additional_ocr_examples': 0,
                             'corrected_targets_identical_to_parent': True})
    real = [r for r in rows if r['kind'] == 'line_transcript']
    missing = sorted({r['source_sha256'] for r in real if r['pixel_locator'].get('missing')})
    snapshot['archives'].extend(recovery['archives'])
    snapshot['missing_pixel_sources'] = missing
    snapshot['counts'].update({'raw_source_identities_before_reconciliation': original_identities,
        'unique_source_pdfs': len({r['source_sha256'] for r in real}),
        'unique_ocr_views': len({r['ocr_sha256'] for r in real}),
        'synthetic_structure_variants': len(verification['checks']), 'missing_pixel_sources': len(missing)})
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--recovery', type=Path, required=True)
    parser.add_argument('--verification', type=Path, required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    value = reconcile(read(args.snapshot), read(args.recovery), read(args.verification), args.repository, args.tag)
    with gzip.open(args.out, 'wt', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False)
    print(json.dumps(value['counts']))


if __name__ == '__main__':
    main()
