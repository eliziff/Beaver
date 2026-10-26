"""Inventory OCR supervision without parsing PDFs or counting derivative exports as gold.

Config names explicit gold owners, cohort manifests, the original journal Arrow
split and an optional read-only catalogue export. All outputs contain private
locators/signatures and belong in the ignored OCR training data directory.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import re
import unicodedata


def read(path):
    path = Path(path)
    data = gzip.open(path).read() if path.suffix == '.gz' else path.read_bytes()
    return json.loads(data)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def normalized(text):
    return ' '.join(unicodedata.normalize('NFKC', text).split())


def corrected_lines(gold):
    """Resolve explicit text corrections; never use typed/markerized display text."""
    edits = defaultdict(list)
    for edit in gold.get('text_edits', []):
        edits[edit['line_id']].append(edit)
    for line in gold.get('lines', []):
        # Package v2 keeps pre-edit text in source_text; lines already contains
        # the corrected transcript, including inserted lines with boxes.
        source_text = gold.get('source_text', {})
        original = source_text.get(line['id'], line.get('text', ''))
        text = line.get('corrected', line.get('text', ''))
        explicit = 'corrected' in line or line['id'] in source_text
        error = None
        if edits[line['id']]:
            edited, end = original, len(original)
            for edit in sorted(edits[line['id']], key=lambda e: (e['start'], e['end']), reverse=True):
                a, b = edit['start'], edit['end']
                if not 0 <= a <= b <= end or original[a:b] != edit['old']:
                    error = 'invalid_text_edit'
                    break
                edited = edited[:a] + edit['text'] + edited[b:]
                end = a
            if not error:
                if explicit and text != edited:
                    error = 'inconsistent_correction_encodings'
                else:
                    text = edited
            explicit = True
        if gold.get('manuscript_edits', {}).get(line['id']):
            error = 'manuscript_edits_need_contract_review'
        if not isinstance(text, str) or '\ufffd' in text or re.search(r'\[\[(?:r|n):', text or ''):
            error = 'invalid_or_display_target'
        yield line, text, explicit, error


def page_number(line):
    return line.get('page', line.get('page_number'))


def geometry(line, gold, cached):
    """Package boxes are normalized to 1000; v4 boxes are PDF points."""
    box = line.get('bbox')
    kind = 'gold_inherited_points'
    if box is None and line.get('box') is not None:
        page = next((p for p in gold.get('pages', []) if p.get('page') == page_number(line)), None)
        if page is None:
            return None, 'missing_package_page_dimensions'
        box = [v * page['width_points' if i % 2 == 0 else 'height_points'] / 1000
               for i, v in enumerate(line['box'])]
        kind = 'gold_inherited_normalized_box'
    if box is None:
        item = cached.get(line['id'])
        if item and item.get('text') == line.get('text') and page_number(item) == page_number(line):
            box = item.get('bbox')
            kind = 'matching_authoring_cache_points'
    if not isinstance(box, list) or len(box) != 4 or not box[0] < box[2] or not box[1] < box[3]:
        return None, 'no_matched_geometry'
    return tuple(round(float(v), 2) for v in box), kind


def cache_lines(root, source):
    for name in ['inputs', 'inputs-r29']:
        path = root / name / (source + '.json.gz')
        if path.exists():
            value = read(path)
            pages = value.get('extraction', value).get('pages', [])
            return {line['id']: {**line, 'page': page['number']}
                    for page in pages for line in page['lines']}
    return {}


def inventory(config):
    files = {}
    for owner in config['owners']:
        root = Path(owner['root'])
        paths = set()
        for pattern in owner['patterns']:
            paths.update(root.glob(pattern))
        files[owner['name']] = (owner, sorted(p for p in paths if p.is_file()))
    source_paths = defaultdict(set)
    memberships = defaultdict(set)
    for path in config.get('manifests', []):
        for row in read(path)['documents']:
            source = row['sha256']
            if row.get('path'):
                source_paths[source].add(row['path'])
            if row.get('split'):
                memberships[source].add(row['split'])
    catalogue = read(config['catalogue']) if config.get('catalogue') else None
    catalogue_by_hash = defaultdict(list)
    if catalogue:
        for row in catalogue['runs']:
            catalogue_by_hash[row['artifact_sha256']].append(row)
            if row.get('source') and row['source'].get('path'):
                path = Path(row['source']['path'])
                if not path.is_absolute():
                    path = Path(config['corpus_home']) / path
                source_paths[row['sha256']].add(str(path))
    body = set()
    versions = defaultdict(set)
    label_sets = defaultdict(set)
    changed_label_sets = defaultdict(set)
    owners = {}
    artifacts = []
    errors = []
    pdf_exists = {}
    for name, (owner, paths) in files.items():
        counts = Counter(artifact_files=len(paths))
        sources, pages, identities, targets, explicit_targets = set(), set(), set(), set(), set()
        for index, path in enumerate(paths):
            if index % 100 == 0:
                print(json.dumps({'owner': name, 'files_read': index, 'files': len(paths)}), flush=True)
            data = path.read_bytes()
            signature = digest(data)
            body.add(signature)
            gold = read(path)
            source = gold.get('source_sha256')
            if not source or not isinstance(gold.get('lines'), list):
                errors.append({'path': str(path), 'reason': 'not_line_transcript_gold'})
                continue
            sources.add(source)
            versions[source].add(signature)
            mode = gold.get('mode', gold.get('metadata', {}).get('mode', 'unknown'))
            counts['artifacts_' + mode] += 1
            cache = cache_lines(Path(owner.get('cache_root', owner['root'])), source)
            row_counts = Counter()
            if source not in pdf_exists:
                pdf_exists[source] = any(Path(p).is_file() for p in source_paths[source])
            for line, text, explicit, error in corrected_lines(gold):
                row_counts['line_observations'] += 1
                if error:
                    row_counts[error] += 1
                    continue
                if not text.strip():
                    row_counts['blank_lines'] += 1
                    continue
                page = page_number(line)
                pages.add((source, page))
                box, geometry_kind = geometry(line, gold, cache)
                row_counts[geometry_kind] += 1
                row_counts['nonempty_lines'] += 1
                row_counts['explicit_correction_lines'] += explicit
                before = gold.get('source_text', {}).get(line['id'], line.get('text'))
                row_counts['explicit_changed_lines'] += explicit and text != before
                row_counts['lines_with_pdf_locator'] += pdf_exists[source]
                row_counts['lines_with_geometry_and_pdf_locator'] += box is not None and pdf_exists[source]
                # These are annotation identities, not proven identical pixel crops.
                identity = (source, page, box if box is not None else ('id', line['id']))
                text_signature = digest(normalized(text).encode())
                target = (identity, text_signature)
                identities.add(identity)
                targets.add(target)
                if explicit:
                    explicit_targets.add(target)
                    changed_label_sets[identity].add(text_signature)
                label_sets[identity].add(text_signature)
            counts.update(row_counts)
            artifacts.append({'owner': name, 'path': str(path), 'sha256': signature, 'source_sha256': source,
                              'schema': gold.get('schema_version'), 'mode': mode, 'counts': dict(row_counts),
                              'catalogue_runs': [r['run_id'] for r in catalogue_by_hash[signature]]})
        owners[name] = {'counts': dict(counts), 'sources': sorted(sources), 'pages': len(pages),
                        'unique_annotation_identities': len(identities), 'unique_text_targets': len(targets),
                        'unique_explicit_correction_targets': len(explicit_targets),
                        'unique_artifact_hashes': len({a['sha256'] for a in artifacts if a['owner'] == name})}
        print(json.dumps({'owner': name, 'sources': len(sources), 'files': len(paths),
                          'unique_text_targets': len(targets), 'explicit_corrections': len(explicit_targets)}), flush=True)
    owner_sets = {name: set(row['sources']) for name, row in owners.items()}
    union = set().union(*owner_sets.values()) if owner_sets else set()
    report = {'schema': 'ocr-gold-availability-audit.v1', 'owners': owners,
              'unique_source_identities': len(union), 'unique_artifact_hashes': len(body),
              'unique_annotation_identities': len(label_sets),
              'unique_annotation_text_targets': sum(map(len, label_sets.values())),
              'identities_with_conflicting_text': sum(len(s) > 1 for s in label_sets.values()),
              'identities_with_conflicting_explicit_corrections': sum(len(s) > 1 for s in changed_label_sets.values()),
              'sources_with_multiple_artifact_versions': sum(len(s) > 1 for s in versions.values()),
              'sources_with_existing_pdf_locator': sum(pdf_exists.values()),
              'split_conflict_sources': sorted(source for source, splits in memberships.items() if len(splits) > 1),
              'sources_without_split': sorted(union - memberships.keys()),
              'source_overlaps': [{'left': a, 'right': b, 'sources': len(owner_sets[a] & owner_sets[b])}
                                  for i, a in enumerate(owner_sets) for b in list(owner_sets)[i+1:]],
              'limits': ['Inherited boxes are proposals, not verified glyph geometry.',
                         'Existing PDF locators were checked; PDF bytes and crop pixels were not reread.',
                         'Annotation identities deduplicate matching source/page/box, not near-duplicate documents.',
                         'Unedited extraction text is counted separately from explicit transcription corrections.',
                         'No markerized display export or ordinary journal final-contract output is added as OCR gold.'],
              'errors': errors}
    if catalogue:
        present = {a['sha256'] for a in artifacts}
        report['catalogue'] = {}
        for dataset in sorted({r['dataset'] for r in catalogue['runs']}):
            rows = [r for r in catalogue['runs'] if r['dataset'] == dataset]
            report['catalogue'][dataset] = {'completed_runs': len(rows), 'unique_sources': len({r['sha256'] for r in rows}),
                'artifact_hash_found_in_scanned_stores': sum(r['artifact_sha256'] in present for r in rows),
                'artifact_path_present_on_catalogue_machine': sum(r.get('local_exists', False) for r in rows),
                'artifact_bound_in_private_backup_inventory': sum(r.get('backup_entry') is not None for r in rows)}
    return report, artifacts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    config = read(args.config)
    report, artifacts = inventory(config)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out/'report.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    with gzip.open(args.out/'artifacts.jsonl.gz', 'wt', encoding='utf-8') as stream:
        for row in artifacts:
            stream.write(json.dumps(row)+'\n')
    print(json.dumps({k: v for k, v in report.items() if k not in {'owners', 'sources_without_split', 'split_conflict_sources', 'errors'}}), flush=True)


if __name__ == '__main__':
    main()
