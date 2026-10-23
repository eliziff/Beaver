"""Hash and complete-body overlap audit for the private independent Canada review."""
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone

from second_canada_review_prepare import OUT, original
from second_canada_review_apply import JOB, RUN
from second_tribunals_sources import dump, sha
from data import accepted_gold, PRIVATE, BENCH, RECORDS


def grams(text):
    words = re.findall(r'\w+', text.casefold())
    return {hash(tuple(words[i:i + 8])) for i in range(max(0, len(words) - 7))}


def main():
    baseline_path = OUT.parent / 'baseline.json'
    baseline = json.loads(baseline_path.read_text(encoding='utf8'))
    prior_ids = {r['record_id'] for r in baseline['records']}
    frozen = json.loads((OUT / 'frozen-source-gold.json').read_text(encoding='utf8'))
    errors, records, sets, index = [], [], {}, defaultdict(list)
    for row in frozen['records']:
        rid = row['record_id']
        if sha(OUT / row['source_gold_path']) != row['source_gold_sha256']:
            errors.append([rid, 'Frozen author changed'])
    for receipt_path in sorted((OUT / 'review-peer').glob('*/receipt.json')):
        rid, directory = receipt_path.parent.name, OUT / 'records' / receipt_path.parent.name
        receipt = json.loads(receipt_path.read_text(encoding='utf8'))
        path = directory / 'reviewed-source-gold.json'
        gold = json.loads(path.read_text(encoding='utf8'))
        views_path = directory / 'model-views.json'
        views = json.loads(views_path.read_text(encoding='utf8'))
        if receipt['reviewed_gold_sha256'] != sha(path) or views['source_gold_sha256'] != sha(path):
            errors.append([rid, 'Stale reviewed Gold binding'])
        if receipt['model_views_sha256'] != sha(views_path): errors.append([rid, 'Changed model manifest'])
        if gold['country'] != 'CA' or rid in prior_ids: errors.append([rid, 'Country or repeated ID'])
        labels = [e['label'] for e in gold['exhibits']]
        if sorted(labels) != sorted(v['label'] for v in views['views']): errors.append([rid, 'Incomplete views inventory'])
        for view in views['views']:
            if view.get('text_file') and sha(directory / view['text_file']) != view['text_sha256']:
                errors.append([rid, view['label'], 'Text hash mismatch'])
        for e in gold['exhibits']:
            if e.get('source_pages'): original(e['source_sha256'])
            elif e.get('source_sha256'): errors.append([rid, e['label'], 'Unlocated target falsely bound'])
        body = (directory / gold['referring_document']['text_file']).read_text(encoding='utf8')
        if sha(directory / gold['referring_document']['text_file']) != gold['referring_document']['text_sha256']:
            errors.append([rid, 'Referring body changed'])
        normalize = lambda value: re.sub(r'\s+', ' ', value).strip()
        for event in gold['events']:
            source = '\n'.join((OUT / 'source-transcripts' / event['source_sha256'] / f'{n:04}.txt').read_text(encoding='utf8') for n in event['source_pages'])
            if normalize(event['quote']) not in normalize(source) and normalize(event['quote']) not in normalize(body):
                errors.append([rid, event['event_id'], 'Quote not in bound source or image-corrected body'])
        distractors_path = directory / 'distractors.json'
        distractors = json.loads(distractors_path.read_text(encoding='utf8'))
        if not isinstance(distractors, list): errors.append([rid, 'Noncanonical distractor manifest'])
        for item in distractors:
            original(item['source_sha256'])
            if sha(directory / item['text_file']) != item['text_sha256']: errors.append([rid, 'Changed counterpart text'])
            if item['same_proceeding'] is not True or item['review_status'] != 'accepted': errors.append([rid, 'Unreviewed counterpart'])
            for exhibit in gold['exhibits']:
                if item['source_sha256'] == exhibit.get('source_sha256') and set(item['source_pages']) & set(exhibit.get('source_pages', [])):
                    errors.append([rid, 'Counterpart overlaps a positive'])
        sets[rid] = grams(body)
        for gram in sets[rid]: index[gram].append(rid)
        records.append(dict(record_id=rid, author_gold_sha256=receipt['author_gold_sha256'], reviewed_gold_sha256=sha(path),
                            receipt_sha256=sha(receipt_path), model_views_sha256=sha(views_path), distractors_sha256=sha(distractors_path),
                            exhibits=len(labels), events=len(gold['events']), counterparts=len(distractors),
                            model_review_status=views['review_status']))
    directories = {}
    for root in [BENCH / 'records', RECORDS]:
        for path in root.glob('*/affidavit.txt'):
            if path.parent.name in prior_ids: directories[path.parent.name] = path.parent
    for rid, (_, directory) in accepted_gold(PRIVATE / 'expansion', 'source-gold.json', True).items():
        if rid in prior_ids: directories[rid] = directory
    nearest, duplicates, baseline_bodies = {}, [], []
    for rid, directory in sorted(directories.items()):
        path = directory / 'affidavit.txt'; prior = grams(path.read_text(encoding='utf-8-sig'))
        baseline_bodies.append(dict(record_id=rid, text_sha256=sha(path)))
        common = Counter()
        for gram in prior: common.update(index.get(gram, ()))
        for new_id, count in common.items():
            score = count / max(1, len(sets[new_id]))
            if score > nearest.get(new_id, {}).get('containment', 0):
                nearest[new_id] = dict(prior_record_id=rid, containment=score, common_eightgrams=count,
                                       new_eightgrams=len(sets[new_id]), prior_eightgrams=len(prior))
            if score == 1 and len(prior) == len(sets[new_id]): duplicates.append([new_id, rid])
    if duplicates: errors.append(['Exact normalized body duplicates', duplicates])
    report = dict(origin='machine_test', run_id=RUN, review_job=JOB, actual_method='codex_collaboration',
                  agent='/root/gold_us', runner_call=False, recorded_at_utc=datetime.now(timezone.utc).isoformat(),
                  baseline_sha256=sha(baseline_path), baseline_rows=len(baseline['records']), baseline_unique_ids=len(prior_ids),
                  baseline_bodies_read=len(directories), baseline_bodies_unavailable=sorted(prior_ids - directories.keys()),
                  baseline_body_hashes=baseline_bodies, records=records, errors=errors, exact_body_duplicates=duplicates,
                  nearest_prior_bodies=nearest,
                  duplicate_method='Complete referring bodies, casefolded word eight-gram containment. Process-local hashes count overlap; not document identity. Near overlap is a source-review lead, never automatic acceptance.')
    dump(OUT / 'review-peer/audit.json', report)
    print(json.dumps(dict(records=len(records), baseline_bodies=len(directories), errors=errors, duplicates=duplicates)))


if __name__ == '__main__':
    main()
