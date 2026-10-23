"""Materialize explicit private source-review decisions, preserving immutable author Gold."""
import copy
import json
import re
import sys
from datetime import datetime, timezone

from second_canada_review_prepare import OUT, original
from second_tribunals_sources import dump, sha

JOB = '02487035-331e-41d2-a106-a966e947ce56'
RUN = '7a71d3b5-b4a5-4f3e-a79e-9204111ce7d3'


def apply(rid):
    directory = OUT / 'records' / rid
    review = OUT / 'review-peer' / rid
    decision = json.loads((review / 'decision.json').read_text(encoding='utf8'))
    assert decision['status'] == 'accepted_source_review' and decision['source_review_notes']
    author = directory / 'source-gold.json'
    assert sha(author) == decision['author_gold_sha256']
    gold = json.loads(author.read_text(encoding='utf8'))
    before = copy.deepcopy(gold)
    gold.update(decision.get('gold_updates', {}))
    referring = gold['referring_document']
    if 'parts' in referring:
        referring['source_files'] = referring.pop('parts')
    referring['text_file'] = 'affidavit.txt'
    body = (directory / 'affidavit.txt').read_text(encoding='utf8')
    for old, new in decision.get('body_exact_replacements', []):
        assert old in body
        body = body.replace(old, new)
    if decision.get('body_exact_replacements'):
        target = directory / 'reviewed-text/affidavit.txt'
        target.parent.mkdir(exist_ok=True)
        target.write_text(body, encoding='utf8')
        referring['text_file'] = target.relative_to(directory).as_posix()
    referring['text_sha256'] = sha(directory / referring['text_file'])
    for item in gold['exhibits']:
        item.update(decision.get('exhibit_updates', {}).get(item['label'], {}))
        if 'document_date' in item:
            item['date'] = item.pop('document_date')
        if not item.get('source_pages'):
            for key in ['source_sha256', 'source_url', 'canonical_source_path']:
                item.pop(key, None)
    for item in gold['events']:
        item.update(decision.get('event_updates', {}).get(item.get('event_id', item.get('id')), {}))
        if 'exhibit_labels' in item:
            item['exhibits'] = item.pop('exhibit_labels')
        if 'event' in item:
            item['summary'] = item['event']
    for item in gold['events'] + [ref for item in gold['exhibits'] for ref in item.get('references', [])]:
        if 'quote' in item:
            for old, new in decision.get('quote_exact_replacements', []):
                item['quote'] = item['quote'].replace(old, new)
    gold['events'].extend(decision.get('extra_events', []))
    for key in ['source_exhibits', 'source_events']:
        gold.pop(key, None)
    evidence = []
    for part in referring['source_files']:
        original(part['sha256'])
        for number in part['pages']:
            path = OUT / 'source-transcripts' / part['sha256'] / f'{number:04}.txt'
            evidence.append(dict(source_sha256=part['sha256'], source_page=number, text_sha256=sha(path), role='complete_referring_body'))
    for item in gold['exhibits']:
        digest = item.get('source_sha256')
        if digest and item.get('source_pages'):
            original(digest)
            for number in item.get('source_cover_pages', []) + item['source_pages']:
                path = OUT / 'source-transcripts' / digest / f'{number:04}.txt'
                evidence.append(dict(source_sha256=digest, source_page=number, text_sha256=sha(path), role='complete_available_attachment'))
    inspection = json.loads((review / 'inspection.json').read_text(encoding='utf8'))
    reviewed_at = datetime.now(timezone.utc).isoformat()
    provenance = dict(status='accepted', origin='machine_test', method='codex_collaboration', agent='/root/gold_us', job_id=JOB, run_id=RUN, runner_call=False, author_gold_sha256=sha(author), reviewed_at_utc=reviewed_at, evidence_receipt=f'../../review-peer/{rid}/receipt.json')
    gold['independent_source_review'] = provenance
    gold['review_status'] = 'accepted'
    gold.setdefault('document_type', 'affidavit' if gold.get('deponent') else 'court_submission')
    output = directory / 'reviewed-source-gold.json'
    dump(output, gold)
    author_views = review / 'author-model-views.json'
    if not author_views.exists():
        author_views.write_bytes((directory / 'model-views.json').read_bytes())
    views = json.loads(author_views.read_text(encoding='utf8'))
    for view in views['views']:
        item = next(e for e in gold['exhibits'] if e['label'] == view['label'])
        if view['label'] in decision.get('rebuild_text_labels', []):
            target = directory / 'reviewed-text' / (view['file'].replace('.pdf', '.txt'))
            target.parent.mkdir(exist_ok=True)
            target.write_text('\n\n'.join((OUT / 'source-transcripts' / item['source_sha256'] / f'{n:04}.txt').read_text(encoding='utf8') for n in item['source_pages']), encoding='utf8')
            view.update(text_file=target.relative_to(directory).as_posix(), text_sha256=sha(target), source_pages=item['source_pages'])
        if view.get('eligible'):
            assert sha(directory / view['text_file']) == view['text_sha256']
        view.update(decision.get('view_updates', {}).get(view['label'], {}))
    views.update(review_status=decision.get('model_review_status', 'accepted'), source_gold_sha256=sha(output), referring_document_view=dict(text_file=referring['text_file'], text_sha256=referring['text_sha256']))
    dump(directory / 'model-views.json', views)
    peer_path = directory / 'peer-counterparts.json'
    counterparts = []
    if peer_path.exists():
        for index, item in enumerate(json.loads(peer_path.read_text(encoding='utf8'))['documents']):
            if item.get('record_id') in decision.get('exclude_counterpart_ids', []):
                continue
            assert sha(directory / item['file']) == item['text_sha256']
            original(item['source_sha256'])
            counterparts.append(dict(file=f'counterpart-{index+1:03}.pdf', text_file=item['file'], text_sha256=item['text_sha256'], source_sha256=item['source_sha256'], source_pages=item['source_pages'], source_url=item.get('source_url'), same_proceeding=True, review_status='accepted', published_extent='Complete peer referring body; peer attachments separately published are not represented by this body-only view.'))
    old_distractors = directory / 'distractors.json'
    if old_distractors.exists() and not (review / 'author-distractors.json').exists():
        (review / 'author-distractors.json').write_bytes(old_distractors.read_bytes())
    dump(old_distractors, counterparts)
    dump(review / 'receipt.json', dict(review_job=provenance, record_id=rid, author_gold_sha256=sha(author), reviewed_gold_sha256=sha(output), source_evidence=evidence, inspected_images=inspection['images'], actual_review_notes=decision['source_review_notes'], source_view_scope='Complete referring body read; full attached inventory, references, boundaries, title/date evidence checked. Complete originals and all interior text retained; no claim to adjudicate every expert proposition inside attachments.', decision_sha256=sha(review / 'decision.json'), model_views_sha256=sha(directory / 'model-views.json'), distractors_sha256=sha(old_distractors), corrections=dict(before=before, after=gold)))
    assert sha(author) == decision['author_gold_sha256']
    print(rid, 'SOURCE_ACCEPTED', sha(output))


def summary():
    root = json.loads((OUT / 'review-root/summary.json').read_text(encoding='utf8'))
    accepted = list(root['accepted'])
    for path in sorted((OUT / 'review-peer').glob('*/receipt.json')):
        receipt = json.loads(path.read_text(encoding='utf8'))
        if receipt['review_job']['status'] == 'accepted':
            accepted.append(receipt['record_id'])
    accepted = sorted(set(accepted))
    dump(OUT / 'summary.json', dict(origin='machine_test', run_id=RUN,
         status='independent_source_review_in_progress' if len(accepted) < 34 else 'source_gold_accepted',
         accepted=accepted, record_paths={rid: f'records/{rid}' for rid in accepted},
         source_gold_paths={rid: f'records/{rid}/reviewed-source-gold.json' for rid in accepted},
         review_jobs=[root['review_job'], JOB],
         root_review_summary_sha256=sha(OUT / 'review-root/summary.json'),
         counts=dict(accepted=len(accepted), expected=34)))


if __name__ == '__main__':
    for rid in sys.argv[1:]:
        apply(rid)
    summary()
