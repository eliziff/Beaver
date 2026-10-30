"""Write the private OCR inventory and its canonical SQLite registration.

Gold and pixels remain at existing Git paths or verified private release members.
The SQLite file is a portable snapshot of the canonical catalogue's OCR table.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import zipfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent/'legal_pdf_corpus'))
import corpus_store
import gold_store
from gold_inventory import corrected_lines, digest, geometry, normalized, page_number, read
from pack_ocr_gold import json_bytes


def git_locator(root, path, signature):
    relative = path.resolve().relative_to(root.resolve()).as_posix()
    return {'repo': 'eliziff/benchmarks-private', 'git_path': relative, 'sha256': signature}


def recent_gold(root, manifest, pixels):
    rows = []
    for item in manifest:
        path = Path(item['path'])
        data = path.read_bytes()
        signature = digest(data)
        if signature != item['sha256']:
            raise ValueError('Gold changed since inventory: '+str(path))
        gold = json.loads(gzip.decompress(data))
        source = gold['source_sha256']
        projection, counts, pages = [], Counter(), set()
        for line, text, explicit, error in corrected_lines(gold):
            if error:
                counts[error] += 1
                continue
            if not text.strip():
                continue
            box, _ = geometry(line, gold, {})
            pages.add(page_number(line))
            counts['lines'] += 1
            counts['corrected'] += explicit
            counts['geometry'] += box is not None
            projection.append([line['id'], page_number(line), box, normalized(text)])
        rows.append({'artifact_sha256': signature,
            'ocr_sha256': digest(json_bytes({'source_sha256': source, 'lines': projection})),
            'source_sha256': source, 'collection': 'recent-'+item['owner'], 'kind': 'line_transcript',
            'authority': 'model_image_annotation', 'qualification': 'model_annotated',
            'text_contract': 'corrected_else_text', 'gold_locator': git_locator(root, path, signature),
            'geometry_locator': {'embedded_in_gold': True, 'units': 'pdf_points'},
            'pixel_locator': pixels.get(source, {'sha256': source, 'missing': True}),
            'partition': gold_store.source(source).get('partition', 'unassigned'),
            'page_count': len(pages), 'line_count': counts['lines'],
            'corrected_line_count': counts['corrected'], 'geometry_line_count': counts['geometry'],
            'notes': {'source_owner': item['owner'], 'geometry_status': 'inherited_proposals',
                      'crop_validation': 'pending', 'validation_counts': dict(counts)},
            'evidence_sha256': digest(json_bytes(item)), 'recorded_at': datetime.now(timezone.utc).isoformat()})
    return rows


def journal_gold(root):
    import pyarrow.ipc as ipc
    bundle = root/'olj-manual-gold/pagexml-661-20260810/remote_bundle'
    rows = []
    articles = {}
    import re
    for split in ['train', 'eval', 'test']:
        path = bundle/(split+'.lst')
        data = path.read_bytes()
        files = [Path(s.replace('\\', '/')).name for s in data.decode('utf-8-sig').splitlines() if s]
        ids = {re.search(r'article-(\d+)_', s).group(1) for s in files}
        if any(ids & other for other in articles.values()):
            raise ValueError('Journal article split overlap')
        articles[split] = ids
        if any(not (bundle/'data'/name).is_file() or not (bundle/'data'/name).with_suffix('.png').is_file() for name in files):
            raise ValueError('Journal source image or PageXML missing')
        arrow = bundle/'binary'/(split+'.arrow')
        with arrow.open('rb') as stream:
            reader = ipc.open_file(stream)
            count = sum(reader.get_batch(i).num_rows for i in range(reader.num_record_batches))
        with arrow.open('rb') as stream:
            arrow_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
        signature = digest(data)
        relative = bundle.relative_to(root).as_posix()
        rows.append({'artifact_sha256': signature, 'ocr_sha256': digest(json_bytes([signature, arrow_hash])),
            'source_sha256': None, 'collection': 'journal-human-661', 'kind': 'pagexml_split_manifest',
            'authority': 'human_corrected', 'qualification': 'human_gold',
            'text_contract': 'original_pagexml_and_derived_kraken_arrow',
            'gold_locator': git_locator(root, path, signature),
            'geometry_locator': {'git_prefix': relative+'/data', 'format': 'PageXML'},
            'pixel_locator': {'git_prefix': relative+'/data', 'format': 'PNG', 'storage': 'Git LFS'},
            'partition': 'development' if split == 'eval' else split, 'page_count': len(files),
            'line_count': count, 'corrected_line_count': None, 'geometry_line_count': count,
            'notes': {'articles': len(ids), 'article_ids': sorted(ids), 'arrow': git_locator(root, arrow, arrow_hash),
                      'authority_source': 'olj-manual-gold/README.md',
                      'overlap': 'Arrow and older eScriptorium exports are derivatives of the same manual pages; do not add their counts.'},
            'evidence_sha256': digest((root/'olj-manual-gold/README.md').read_bytes()),
            'recorded_at': datetime.now(timezone.utc).isoformat()})
    return rows


def journal_export_history(root):
    rows = []
    for path in sorted((root/'olj-manual-gold/escriptorium_exports').rglob('*.zip')):
        with path.open('rb') as stream:
            signature = hashlib.file_digest(stream, 'sha256').hexdigest()
        with zipfile.ZipFile(path) as archive:
            pages = sum(name.lower().endswith('.xml') for name in archive.namelist())
        rows.append({'artifact_sha256': signature, 'ocr_sha256': None, 'source_sha256': None,
            'collection': 'journal-export-history', 'kind': 'pagexml_export_archive',
            'authority': 'documented_manual_export', 'qualification': 'unreconciled_export',
            'text_contract': 'historical_pagexml_export', 'gold_locator': git_locator(root, path, signature),
            'geometry_locator': {'embedded_in_gold': True, 'format': 'PageXML'}, 'pixel_locator': None,
            'partition': None, 'page_count': pages, 'line_count': None, 'corrected_line_count': None,
            'geometry_line_count': None, 'notes': {'authority_source': 'olj-manual-gold/README.md',
                'additional_ocr_examples': 'not_established',
                'reuse': 'Preserve earlier corrections; reconcile image/page identity and partitions against the accepted 661-page bundle before sampling.'},
            'evidence_sha256': digest((root/'olj-manual-gold/README.md').read_bytes()),
            'recorded_at': datetime.now(timezone.utc).isoformat()})
    return rows


def footnote_gold(root, known):
    rows = []
    for path in sorted((root/'olj-footnote-gold/gold').glob('*/gold.json')):
        data = path.read_bytes()
        gold, signature = json.loads(data), digest(data)
        source = gold['source_sha256']
        rows.append({'artifact_sha256': signature, 'ocr_sha256': None, 'source_sha256': source,
            'collection': 'journal-footnote-annotations', 'kind': 'reference_annotation',
            'authority': 'locked_task_annotations', 'qualification': 'annotation_only',
            'text_contract': 'footnote_labels_and_reference_spans_only',
            'gold_locator': git_locator(root, path, signature), 'geometry_locator': None,
            'pixel_locator': {**known['pdfs'][source], 'sha256': source} if source in known.get('pdfs', {}) else None,
            'partition': None,
            'page_count': gold.get('pages'), 'line_count': None, 'corrected_line_count': None,
            'geometry_line_count': None, 'notes': {'article_id': gold.get('article_id'),
                'dataset': gold.get('dataset'), 'notes': len(gold.get('notes', [])),
                'verified_status': gold.get('verified_status'),
                'recognition_use': 'supplementary glyph targets only after alignment; not an additional full-line OCR corpus'},
            'evidence_sha256': signature, 'recorded_at': datetime.now(timezone.utc).isoformat()})
    for path in sorted((root/'olj-footnote-gold/gold').glob('*/receipt.json')):
        if path.with_name('gold.json').is_file():
            continue
        data = path.read_bytes()
        receipt, signature = json.loads(data), digest(data)
        source = receipt['source_sha256']
        rows.append({'artifact_sha256': signature, 'ocr_sha256': None, 'source_sha256': source,
            'collection': 'journal-footnote-annotations', 'kind': 'reference_annotation_receipt',
            'authority': 'historical_receipt', 'qualification': 'receipt_only',
            'text_contract': 'no_materialized_gold_file', 'gold_locator': git_locator(root, path, signature),
            'geometry_locator': None, 'pixel_locator': {**known['pdfs'][source], 'sha256': source}
                if source in known.get('pdfs', {}) else None,
            'partition': None, 'page_count': receipt.get('pages'), 'line_count': None,
            'corrected_line_count': None, 'geometry_line_count': None,
            'notes': {'expected_gold_sha256': receipt['gold_sha256'], 'historical_status': receipt['status'],
                      'materialization_status': 'receipt_present_gold_file_unlocated',
                      'additional_ocr_examples': 0,
                      'original_locked_marker_inputs_preserved': True},
            'evidence_sha256': signature, 'recorded_at': datetime.now(timezone.utc).isoformat()})
    return rows


def annotation_inputs(metadata, snapshot):
    reference = next(r['gold_locator'] for r in snapshot['rows'] if r['gold_locator'].get('tag'))
    archive = metadata['archive']
    rows = []
    for item in metadata['files']:
        markers = item['name'] == 'gold_markers.locked.jsonl'
        locator = {**item, 'repo': reference['repo'], 'tag': reference['tag'], 'asset_sha256': archive['sha256']}
        rows.append({'artifact_sha256': item['sha256'], 'ocr_sha256': None, 'source_sha256': None,
            'collection': 'journal-footnote-source-inputs',
            'kind': 'locked_marker_source' if markers else 'annotation_transcript_input',
            'authority': 'locked_mixed_authority_annotations' if markers else 'mixed_authority_input',
            'qualification': 'annotation_only' if markers else 'provenance_only',
            'text_contract': 'selected_text_labels_and_refs' if markers else 'gold_text_source_only_never_gold_markerized_text',
            'gold_locator': locator, 'geometry_locator': None, 'pixel_locator': None, 'partition': None,
            'page_count': None, 'line_count': None, 'corrected_line_count': None, 'geometry_line_count': None,
            'notes': {'original_frozen_input': True, 'additional_full_line_ocr_examples': 0,
                      'reuse': 'Original input to the journal annotation importer; reconcile each marker to its source pixels and split before OCR use.'},
            'evidence_sha256': item['sha256'], 'recorded_at': datetime.now(timezone.utc).isoformat()})
    return rows


def validate_rows(rows):
    for row in rows:
        if not row['gold_locator'] or row['qualification'] not in {'human_gold', 'model_annotated', 'annotation_only', 'excluded_derivative', 'unreconciled_export', 'receipt_only', 'provenance_only'}:
            raise ValueError('Unknown OCR qualification')
        for key in ['line_count', 'corrected_line_count', 'geometry_line_count', 'page_count']:
            if row.get(key) is not None and row[key] < 0:
                raise ValueError('Negative inventory count')
        if row.get('corrected_line_count') is not None and row['corrected_line_count'] > row['line_count']:
            raise ValueError('Correction count exceeds transcript count')


def write_database(path, rows, check=True):
    with sqlite3.connect(path) as db:
        if not check and not db.execute("select 1 from sqlite_master where name='gold_records'").fetchone():
            raise ValueError('Canonical target is not the existing corpus catalogue')
        db.executescript(corpus_store.OCR_GOLD_SCHEMA)
        before = None
        if not check:
            db.execute('begin immediate')
            before = db.execute('select dataset,sha256,status,run_id from gold_records order by dataset,sha256').fetchall()
        corpus_store.record_ocr_gold_inventory(db, rows)
        if before is not None:
            after = db.execute('select dataset,sha256,status,run_id from gold_records order by dataset,sha256').fetchall()
            if before != after:
                raise ValueError('OCR registration changed existing structure-gold selection')
        if check:
            result = db.execute('pragma integrity_check').fetchone()[0]
            if result != 'ok':
                raise ValueError('Inventory integrity check failed: '+result)


def export_canonical_metadata(canonical, destination):
    """Copy the existing gold metadata, without page text/FTS or unrelated app stores."""
    with sqlite3.connect(canonical.as_uri()+'?mode=ro', uri=True) as source, sqlite3.connect(destination) as target:
        source.execute('begin')
        tables = ['files', 'documents', 'gold_records', 'gold_runs', 'gold_artifacts',
                  'gold_memberships', 'gold_source_groups']
        chosen = ('select sha256 from gold_records union select sha256 from gold_runs '
                  'union select sha256 from gold_memberships union select owner_sha256 from gold_memberships '
                  'union select source_sha256 from ocr_gold_inventory where source_sha256 is not null')
        for table in tables:
            schema = source.execute('select sql from sqlite_master where type=\'table\' and name=?', (table,)).fetchone()
            if schema is None:
                continue
            if not target.execute('select 1 from sqlite_master where type=\'table\' and name=?', (table,)).fetchone():
                target.execute(schema[0])
            condition = ' where sha256 in ('+chosen+')' if table in {'files', 'documents'} else ''
            cursor = source.execute('select * from '+table+condition)
            columns = [d[0] for d in cursor.description]
            sql = 'insert or replace into '+table+' ('+','.join(columns)+') values ('+','.join('?' for _ in columns)+')'
            while batch := cursor.fetchmany(1000):
                target.executemany(sql, batch)
        target.commit()
        if target.execute('pragma integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Private catalogue snapshot failed integrity check')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-root', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--recent-artifacts', type=Path, required=True)
    parser.add_argument('--known-assets', type=Path, required=True)
    parser.add_argument('--annotation-inputs', type=Path)
    parser.add_argument('--canonical', type=Path)
    args = parser.parse_args()
    root = args.private_root.resolve()
    snapshot = read(args.snapshot)
    rows = snapshot['rows']
    pixels = {r['source_sha256']: r['pixel_locator'] for r in rows}
    with gzip.open(args.recent_artifacts, 'rt', encoding='utf-8') as stream:
        recent = [json.loads(s) for s in stream]
    journals = journal_gold(root)
    extra = recent_gold(root, recent, pixels) + journals + journal_export_history(root) + footnote_gold(root, read(args.known_assets))
    if args.annotation_inputs:
        inputs = read(args.annotation_inputs)
        extra.extend(annotation_inputs(inputs, snapshot))
        snapshot['archives'].append(inputs['archive'])
    by_hash = {r['artifact_sha256']: r for r in rows}
    for row in extra:
        previous = by_hash.get(row['artifact_sha256'])
        if previous:
            row['notes']['also_available_at'] = previous['gold_locator']
        by_hash[row['artifact_sha256']] = row
    rows = list(by_hash.values())
    journal_splits = {i: r['partition'] for r in journals for i in r['notes']['article_ids']}
    for row in rows:
        if row['kind'] == 'reference_annotation':
            row['partition'] = journal_splits.get(str(row['notes']['article_id']), 'unassigned')
    source_splits = {}
    for row in rows:
        if row['source_sha256'] and row['qualification'] != 'excluded_derivative' and row.get('partition') in {'train', 'development', 'test'}:
            source_splits.setdefault(row['source_sha256'], set()).add(row['partition'])
    for row in rows:
        if len(source_splits.get(row['source_sha256'], [])) > 1:
            row['notes']['declared_partition'] = row['partition']
            row['notes']['split_conflict'] = True
            row['partition'] = 'conflict'
    validate_rows(rows)
    if args.canonical:
        if not args.canonical.is_file():
            raise ValueError('Canonical catalogue does not exist')
        write_database(args.canonical, rows, check=False)
    output = root/'ocr-gold'
    output.mkdir(exist_ok=True)
    write_database(output/'inventory.sqlite', rows)
    if args.canonical:
        export_canonical_metadata(args.canonical.resolve(), output/'inventory.sqlite')
    with gzip.open(output/'inventory.jsonl.gz', 'wt', encoding='utf-8') as stream:
        for row in sorted(rows, key=lambda r: (r['collection'], r.get('source_sha256') or '', r['artifact_sha256'])):
            stream.write(json.dumps(row, ensure_ascii=False)+'\n')
    summary = {'artifact_records': len(rows), 'by_kind': dict(Counter(r['kind'] for r in rows)),
               'by_authority': dict(Counter(r['authority'] for r in rows)),
               'model_source_pdfs': len({r['source_sha256'] for r in rows if r['kind'] == 'line_transcript'}),
               'model_ocr_views': len({r['ocr_sha256'] for r in rows if r['kind'] == 'line_transcript'}),
               'human_journal_pages': sum(r['page_count'] for r in rows if r['kind'] == 'pagexml_split_manifest'),
               'human_journal_lines': sum(r['line_count'] for r in rows if r['kind'] == 'pagexml_split_manifest'),
               'desktop_snapshot': snapshot['counts'], 'archives': snapshot['archives'],
               'limits': ['Model-annotated text is not human gold.', 'Inherited geometry requires crop validation.',
                          'OCR-view deduplication does not replace line/crop deduplication across partly overlapping versions.',
                          'Reference annotations and display derivatives do not count as additional full-line OCR examples.']}
    (output/'summary.json').write_text(json.dumps(summary, indent=2)+'\n', encoding='utf-8')
    gaps = {'missing_model_source_pdfs': snapshot['missing_pixel_sources'],
            'receipt_only_annotations': [{'locator': r['gold_locator'], **r['notes']}
                                        for r in rows if r['qualification'] == 'receipt_only'],
            'split_conflict_sources': sorted({r['source_sha256'] for r in rows if r['partition'] == 'conflict'}),
            'geometry_status': 'Inherited model-gold boxes remain proposals and require crop validation.'}
    (output/'coverage.json').write_text(json.dumps(gaps, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in summary.items() if k not in {'archives', 'limits'}}), flush=True)


if __name__ == '__main__':
    main()
