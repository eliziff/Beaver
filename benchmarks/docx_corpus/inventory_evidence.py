"""Inventory saved evidence without executing parsers, models, compilers or corpus runs."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

from compare_versions import read, rows, sha, write, below_normal


def normalized(text):
    return ' '.join(str(text or '').split())


def main():
    below_normal()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--saved-documents', type=Path, required=True)
    parser.add_argument('--recorded-runs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    manifest = read(args.manifest)
    gold_dir = args.manifest.parent / 'gold'
    documents = {d['sha256']: d for d in manifest['documents']}
    gold_groups = defaultdict(list)
    for row in rows(gold_dir / 'supra_gold_candidates.jsonl'):
        gold_groups[row['source_doc']].append(row)
    matches = defaultdict(list)
    statuses = Counter()
    # Stream large receipts. Only one document's output occupies memory at a time.
    with args.saved_documents.open(encoding='utf-8') as stream:
        for line in stream:
            result = json.loads(line)
            statuses[result['status']] += 1
            if result['status'] != 'ok':
                continue
            digest = result['id'].removeprefix('docx:')
            output = result['output']
            notes = {str(output['display'][fid]): normalized(text) for fid, text in output['notes'].items()}
            for source, records in gold_groups.items():
                reference_ids, origin_ids = [], []
                for row in records:
                    if normalized(row['part_text']) in notes.get(str(row['footnote_number']), ''):
                        reference_ids.append(row['id'])
                    origin = row.get('expected_origin') or {}
                    if origin.get('verbatim') and normalized(origin['verbatim']) in notes.get(str(origin.get('footnote')), ''):
                        origin_ids.append(row['id'])
                if len(reference_ids) >= 5:
                    matches[source].append({'document_sha256': digest, 'path': documents[digest]['path'],
                        'reference_matches': len(reference_ids), 'origin_matches': len(origin_ids),
                        'matched_reference_ids': reference_ids, 'matched_origin_ids': origin_ids,
                        'unmatched_reference_ids': [r['id'] for r in records if r['id'] not in reference_ids]})
    sources = []
    for source, records in gold_groups.items():
        candidates = sorted(matches[source], key=lambda x: (-x['reference_matches'], -x['origin_matches'], x['document_sha256']))
        sources.append({'source_doc': source, 'references': len(records),
            'statuses': dict(Counter(r['status'] for r in records)),
            'provenance_flags': dict(Counter(f for r in records for f in r.get('flags', []) if 'adjudicat' in f or 'rechain' in f)),
            'document_candidates': candidates[:2],
            'policy': 'Text evidence identifies candidate revisions; unmatched references/origins are not scored by substitution.'})
    recorded = []
    for path in sorted(args.recorded_runs.glob('*.json')):
        data = read(path)
        digest = data.get('source_sha256')
        recorded.append({'path': str(path.resolve()), 'sha256': sha(path),
            'source_sha256': digest, 'source_available': digest in documents,
            'mode': data.get('mode'), 'supra_linking': data.get('supra_linking'),
            'execution': data.get('execution'), 'model': data.get('model'),
            'records': len(data.get('records', [])), 'output_rows': len(data.get('arm', {}).get('rows', [])),
            'code_revision': data.get('revision') or data.get('commit'),
            'limitation': 'Authentic recorded outputs, not gold. Exact request matching and source-code provenance still require verification.'})
    cache = [{'path': str(p.resolve()), 'sha256': sha(p),
              'kind': 'disambiguation' if p.name.startswith('refdisambig_') else 'split_response'}
             for p in sorted((args.recorded_runs / 'cache').rglob('*.json'))]
    inventories = {}
    for filename in ['fast_split_manual_gold.jsonl', 'fast_split_gold_all.jsonl',
                     'fast_split_review_gold.jsonl', 'field_gold_provisional.jsonl']:
        data = rows(gold_dir / filename)
        inventories[filename] = {'sha256': sha(gold_dir / filename), 'rows': len(data),
            'statuses': dict(Counter(r.get('status', r.get('field_gold_status', 'unspecified')) for r in data))}
    originals = {}
    for path in sorted((args.manifest.parent.parent / 'owners').glob('*.json')):
        info = read(path)
        originals[path.stem] = {k: info[k] for k in ['repository', 'revision', 'archive_sha256', 'path']}
    result = {'manifest_sha256': sha(args.manifest), 'saved_documents_sha256': sha(args.saved_documents),
        'saved_documents_status': dict(statuses), 'corpus': dict(Counter(d['kind'] for d in documents.values())),
        'collection_memberships': dict(Counter(c for d in documents.values() for c in d['collections'])),
        'original_source_archives': originals, 'gold_inventory': inventories,
        'supra_documents': sources, 'recorded_runs': recorded, 'recorded_cache': cache,
        'coverage_gaps': [
            'Gold source-text matches are not complete-document gold coverage or human adjudication.',
            'The historical eleven-document replay artifacts are absent from their documented paths; two Dylan runs survive elsewhere.',
            'The historical PDF extraction cache is absent from its documented .tmp path; all 750 PDF inputs remain available.',
            'Original source archives are recovered; cross-owner baseline-selection review and executable provenance are unfinished.',
            'Candidate DOCX run aborted on a Rust span panic; no complete paired document result exists.',
            'No complete native/WASM/Python consumer comparison or paired performance gate has run.'
        ]}
    write(args.output, result)
    print('Saved evidence inventory:', args.output)
    print('Corpus:', result['corpus'], '; gold document families:', len(sources), '; recorded runs:', len(recorded))


if __name__ == '__main__':
    main()
