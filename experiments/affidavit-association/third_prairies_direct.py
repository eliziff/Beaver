"""Materialize directly source-authored private proposals without inference calls."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
EXPANSION = ROOT / 'benchmarks/local-data/affidavit-association/expansion-3'
sys.path.insert(0, str(EXPANSION))
from source_tools import source, views_folder


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def full(item, pages):
    return '\f'.join((views_folder(item) / f'page-{n:04d}.txt').read_text(encoding='utf-8') for n in pages)


def quotes(value):
    if isinstance(value, dict):
        if all(k in value for k in ('quote', 'source_sha256', 'source_pages')):
            yield value
        for child in value.values():
            yield from quotes(child)
    elif isinstance(value, list):
        for child in value:
            yield from quotes(child)


def main(path):
    proposal = json.loads(Path(path).read_text(encoding='utf-8'))
    gold = proposal['gold']
    assert gold['country'] == 'CA'
    provenance = gold['author_provenance']
    assert provenance['method'] == 'codex_collaboration' and provenance['runner_call'] is False
    assert gold['independent_source_review']['status'] == 'pending'
    readings = {r['sha256']: r for r in proposal['source_reading']}
    originals = {sha: source(sha) for sha in readings}
    for sha, item in originals.items():
        assert digest(Path(item['original_path'])) == sha
    fold = lambda text: re.sub(r'\s+', ' ', text).strip()
    for evidence in quotes(gold):
        sha, pages = evidence['source_sha256'], evidence['source_pages']
        assert set(pages) <= set(readings[sha]['pages'])
        if fold(evidence['quote']) not in fold(full(originals[sha], pages)):
            assert evidence.get('quote_verification') == 'original_image', evidence
            assert set(pages) <= set(readings[sha].get('image_pages', [])), evidence
    labels = [e['label'] for e in gold['exhibits']]
    assert len(labels) == len(set(labels)) and all(labels)
    lane = EXPANSION / 'prairies-other'
    record = lane / 'records' / gold['record_id']
    record.mkdir(parents=True, exist_ok=True)
    target = record / 'source-gold.json'
    assert not target.exists(), 'Frozen author Gold already exists'
    body = gold['referring_document']['source_files']
    assert len(body) == 1
    body_part = body[0]
    assert set(body_part['pages']) <= set(readings[body_part['sha256']]['pages'])
    model = record / 'model-text'
    model.mkdir(exist_ok=True)
    views = []
    for n, exhibit in enumerate(gold['exhibits'], 1):
        parts = exhibit.get('source_files', [])
        if not parts:
            views.append({'label': exhibit['label'], 'eligible': False,
                          'reason': exhibit.get('unavailable_reason', 'Original instrument unavailable in this source packet.')})
            continue
        texts = []
        for part in parts:
            assert set(part['pages']) <= set(readings[part['sha256']]['pages'])
            texts.append(full(originals[part['sha256']], part['pages']))
        text_file = model / f'document-{n:03d}.txt'
        text_file.write_text('\f'.join(texts), encoding='utf-8')
        views.append({'label': exhibit['label'], 'file': f'document-{n:03d}.pdf',
                      'text_file': text_file.relative_to(record).as_posix(), 'text_sha256': digest(text_file),
                      'eligible': True, 'complete': True, 'source_files': parts,
                      'modality': 'complete_original_page_text', 'pdf_export_status': 'not_created_text_only_view',
                      'reason': 'Full declared original instrument pages; independent source and fidelity review pending.'})
    affidavit = record / 'affidavit.txt'
    affidavit.write_text(full(originals[body_part['sha256']], body_part['pages']), encoding='utf-8')
    dump(target, gold)
    dump(record / 'source.json', {**originals[body_part['sha256']], 'referring_document_pages': body_part['pages']})
    dump(record / 'model-views.json', {'review_status': 'pending_independent_review',
         'source_gold_sha256': digest(target), 'referring_document_view':
         {'text_file': 'affidavit.txt', 'text_sha256': digest(affidavit)}, 'views': views})
    evidence = []
    for sha, reading in readings.items():
        folder = views_folder(originals[sha])
        evidence.append({'source_sha256': sha,
            'text_pages': [{'physical_page': n, 'sha256': digest(folder / f'page-{n:04d}.txt')} for n in reading['pages']],
            'images_inspected': [{'physical_page': n, 'sha256': digest(folder / f'page-{n:04d}.png')}
                                 for n in reading.get('image_pages', [])]})
    dump(record / 'author_receipt.json', {**provenance,
         'finished_at_utc': datetime.now(timezone.utc).isoformat(), 'source_gold_sha256': digest(target),
         'direct_proposal_sha256': digest(Path(path)), 'source_views': evidence,
         'method_notes': 'Direct source annotations serialized and validated locally; no inference invocation or independent acceptance implied.'})
    print(gold['record_id'], len(gold['exhibits']), 'labels', len(gold['events']), 'events')


if __name__ == '__main__':
    main(sys.argv[1])
