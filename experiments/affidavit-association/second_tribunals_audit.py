"""Audit private second-expansion author packets without deciding source acceptance."""
import hashlib
import json
import os
import re
from collections import Counter, defaultdict
from pathlib import Path

from second_tribunals_sources import OUT, dump, sha
from data import accepted_gold, PRIVATE, BENCH, RECORDS


def words(text):
    return re.findall(r'\w+', text.casefold())


def grams(text):
    tokens = words(text)
    return {hash(tuple(tokens[i:i + 8])) for i in range(max(0, len(tokens) - 7))}


def main():
    baseline = json.loads((OUT.parent / 'baseline.json').read_text(encoding='utf8'))
    prior_ids = {r['record_id'] for r in baseline['records']}
    directories = {}
    for root in [BENCH / 'records', RECORDS]:
        for p in root.glob('*/affidavit.txt'):
            if p.parent.name in prior_ids:
                directories[p.parent.name] = p.parent
    for rid, (_, directory) in accepted_gold(PRIVATE / 'expansion', 'source-gold.json', True).items():
        if rid in prior_ids:
            directories[rid] = directory
    records, errors, families = [], [], Counter()
    new_sets, index = {}, defaultdict(list)
    for path in sorted((OUT / 'records').glob('*/source-gold.json')):
        g = json.loads(path.read_text(encoding='utf8'))
        rid, directory = g['record_id'], path.parent
        body = (directory / 'affidavit.txt').read_text(encoding='utf8')
        if rid in prior_ids: errors.append([rid, 'Repeated prior record ID'])
        if g.get('country') != 'CA': errors.append([rid, 'Non-Canadian country'])
        families[g['family']] += 1
        views = json.loads((directory / 'model-views.json').read_text(encoding='utf8'))
        if views['source_gold_sha256'] != sha(path): errors.append([rid, 'Stale model-view Gold binding'])
        if len(views['views']) != len(g['exhibits']): errors.append([rid, 'Incomplete model-view inventory'])
        for view in views['views'] + views.get('same_proceeding_distractor_views', []):
            if view.get('eligible'):
                text = directory / view['text_file']
                if not text.exists() or sha(text) != view['text_sha256']: errors.append([rid, 'Missing or changed complete text', view.get('label')])
        if len(views.get('same_proceeding_distractor_views', [])) < 2: errors.append([rid, 'Fewer than two sourced counterparts'])
        ngrams = grams(body); new_sets[rid] = ngrams
        for gram in ngrams: index[gram].append(rid)
        records.append({'record_id': rid, 'source_gold_path': path.relative_to(OUT).as_posix(),
                        'source_gold_sha256': sha(path), 'referring_text_sha256': sha(directory / 'affidavit.txt'),
                        'exhibits': len(g['exhibits']), 'events': len(g['events']), 'family': g['family'],
                        'jurisdiction': g['jurisdiction'], 'status': 'author_ready_pending_independent_review'})
    nearest = {}
    exact = []
    for rid, directory in sorted(directories.items()):
        text = (directory / 'affidavit.txt').read_text(encoding='utf-8-sig')
        prior = grams(text); common = Counter()
        for gram in prior:
            common.update(index.get(gram, ()))
        for new_id, count in common.items():
            score = count / max(1, len(new_sets[new_id]))
            if score > nearest.get(new_id, {}).get('containment', 0):
                nearest[new_id] = {'prior_record_id': rid, 'containment': score, 'common_eightgrams': count,
                                   'new_eightgrams': len(new_sets[new_id]), 'prior_eightgrams': len(prior)}
            if score == 1 and len(prior) == len(new_sets[new_id]): exact.append([new_id, rid])
    for family, count in families.items():
        if count > 4: errors.append([family, 'More than four author packets', count])
    if len(families) < 10: errors.append(['Fewer than ten proceedings', len(families)])
    if len(records) != 33: errors.append(['Expected 33 author packets', len(records)])
    report = {'origin': 'machine_test', 'run_id': baseline['run_id'], 'status': 'mechanical_author_audit_only',
              'records': records, 'families': dict(families), 'errors': errors, 'exact_body_duplicates': exact,
              'baseline_unique_ids': len(prior_ids), 'baseline_bodies_read': len(directories),
              'baseline_bodies_unavailable': sorted(prior_ids - directories.keys()),
              'duplicate_method': 'Complete referring bodies; casefolded word eight-gram containment. Process-local hashes only count overlaps, never source identity. Similarity is a review lead, not acceptance.',
              'nearest_prior_bodies': nearest}
    dump(OUT / 'author-audit.json', report)
    print(json.dumps({'records': len(records), 'proceedings': len(families), 'baseline_bodies': len(directories),
                      'errors': errors, 'exact_duplicates': exact}))


if __name__ == '__main__':
    main()
