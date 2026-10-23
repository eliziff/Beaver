"""Freeze association inputs with proceeding-level splits and sourced distractors."""
import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / 'benchmarks/court-record-exhibits'
PRIVATE = ROOT / 'benchmarks/local-data/affidavit-association'
RECORDS = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalData/benchmarks/court-record-exhibits/records'
sys.path[:0] = [str(BENCH / 'assoc'), str(BENCH)]


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def accepted_gold(expansion, artifact='gold.json', with_directories=False, lanes=None):
    """A finalized lane inventory supersedes its retained historical shard summaries."""
    accepted = {}
    if not expansion.exists(): return accepted
    for lane in sorted(expansion.iterdir()):
        if not lane.is_dir(): continue
        if lanes is not None and lane.name not in lanes: continue
        summary = lane / 'summary.json'
        summaries = [summary] if summary.exists() else sorted(lane.rglob('summary.json'))
        for summary in summaries:
            inventory = read(summary)
            for identity in inventory.get('accepted', []):
                directory = summary.parent / inventory.get('record_paths', {}).get(identity, 'records/' + identity)
                if not directory.resolve().is_relative_to(expansion.resolve()):
                    raise ValueError('Accepted record escaped expansion: ' + identity)
                override = inventory.get('source_gold_paths', {}).get(identity) if artifact == 'source-gold.json' else None
                gold = summary.parent / override if override else directory / artifact
                if not gold.resolve().is_relative_to(expansion.resolve()):
                    raise ValueError('Accepted Gold escaped expansion: ' + identity)
                if not gold.exists(): raise ValueError('Accepted record missing Gold: ' + str(gold))
                previous = accepted.get(identity)
                if with_directories and previous: previous = previous[0]
                if previous and digest(previous) != digest(gold):
                    raise ValueError('Conflicting accepted Gold owners: ' + identity)
                accepted[identity] = (gold, directory) if with_directories else gold
    return accepted


def text_key(text):
    words = re.findall(r'\w+', re.sub(r'\[page \d+\]', '', text).casefold())
    return hashlib.sha256(' '.join(words).encode()).hexdigest() if len(words) >= 30 else None


def source_identity(exhibit):
    parts = exhibit.get('source_files') or [exhibit]
    identity = []
    for part in parts:
        pages = part.get('pages') or part.get('source_pages') or part.get('content_pages') or []
        covers = (part.get('cover_pages') or part.get('source_cover_pages') or []) + ([part.get('source_cover_page') or part['cover_page']] if part.get('source_cover_page') or part.get('cover_page') else [])
        identity.append((part.get('source_sha256') or part.get('sha256'), sorted(set(pages + covers))))
    if not all(sha and pages for sha, pages in identity):
        raise ValueError('No complete original-document identity for ' + exhibit['label'])
    return 'source:' + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def source_mapping(source, part):
    metadata = next((s for s in source.get('sources', []) if s.get('file') == part.get('file')), source)
    item = {'sha256': metadata.get('sha256') or metadata.get('source_sha256'), 'url': metadata.get('url'),
            'pages': list(part.get('pages') or part.get('source_pages') or [])}
    if part.get('cover_page') is not None:
        item['cover_pages'] = [part['cover_page']]
        item['pages'] = sorted(set(item['pages']) | {part['cover_page']})
    return item


def legacy_document_keys(directory, files, texts):
    source, split = read(directory / 'source.json'), read(directory / 'split.json')
    mappings = {e['file']: e for e in split['exhibits']}
    mappings['affidavit.pdf'] = {'pages': split.get('affidavit_pages', [])}
    result = {}
    for file, text in zip(files, texts):
        mapping = mappings.get(file, {})
        parts = [source_mapping(source, part) for part in (mapping.get('source_files') or [mapping])]
        if all(part['sha256'] and part['pages'] for part in parts):
            result[file] = source_identity({'label': file, 'source_files': parts})
        else:
            path = directory / ('affidavit.pdf' if file == 'affidavit.pdf' else 'files/' + file)
            result[file] = 'pdf:' + digest(path) if path.exists() else text_key(text)
    return result


def visible_text(text):
    text = re.sub(r'(?m)^\[(?:Source-image literal text transcription|Rotated image text transcription)\]\s*$', '', text)
    return re.sub(r'[ \t]+', ' ', re.sub(r'\[page \d+\]', '', text)).strip()


def order(value):
    return hashlib.sha256(('affidavit-hard-v1:' + value).encode()).hexdigest()


def assign_folds(records):
    groups = {}
    for r in records: groups.setdefault(r['group'], []).append(r)
    load_new, load_files = [0] * 5, [0] * 5
    assignments = {}
    for group in sorted(groups, key=lambda g: (-sum(r['new'] for r in groups[g]),
                                               -sum(len(r['files']) for r in groups[g]), order(g))):
        fold = min(range(5), key=lambda k: (load_new[k], load_files[k], k))
        assignments[group] = fold
        load_new[fold] += sum(r['new'] for r in groups[group])
        load_files[fold] += sum(len(r['files']) for r in groups[group])
    return assignments


def packets(records, sibling_limit=32, unrelated_limit=6):
    """Gold informs answers and duplicate exclusions, never reference text or ranking."""
    result = []
    pool = []
    for other in records:
        for document in list(zip(other['files'], other['texts'])) + other.get('other_documents', []):
            file, text = document[:2]
            same_proceeding = document[2] if len(document) > 2 else True
            text = visible_text(text)
            identity = other.get('document_keys', {}).get(file, text_key(text))
            pool.append((other, file, text, set(re.findall(r'\b\w{3,}\b', text.casefold())), same_proceeding, identity))
    for original in records:
        r = deepcopy(original)
        r['texts'] = [visible_text(t) for t in r['texts']]
        seen = {r.get('document_keys', {}).get(f, text_key(t)) for f, t in zip(r['files'], r['texts'])} - {None}
        positive_views = set(r['texts'])
        provenance = [{'record': r['record'], 'file': f, 'role': 'exhibit'} for f in r['files']]
        query_words = set(re.findall(r'\b\w{3,}\b', ' '.join(c['paragraph'] for c in r['ctx'].values()).casefold()))
        for same, limit in ((True, sibling_limit), (False, unrelated_limit)):
            candidates = [item for item in pool if (item[0]['record'] != r['record']
                          or item[1] not in r['files'] and item[1] != 'affidavit.pdf')
                          and (item[0]['group'] == r['group'] and item[4]) == same]
            # Mine topical near misses from source words, never from a candidate model's errors.
            candidates.sort(key=lambda item: (item[0]['record'] != r['record'],
                                              -len(query_words & item[3]) / max(1, len(item[3])) ** .5,
                                              order(r['record'] + ':' + item[0]['record'] + ':' + item[1])))
            added = 0
            for other, file, text, _, _, key in candidates:
                if key is not None and key in seen:
                    continue
                # Unknown identity cannot establish that two scanned documents differ.
                if key is None:
                    continue
                seen.add(key)
                name = 'candidate-' + order(other['record'] + ':' + file)[:20] + '.pdf'
                r['files'].append(name)
                r['texts'].append(text)
                provenance.append({'record': other['record'], 'file': file,
                                   'role': 'sibling' if same else 'other_matter',
                                   'same_text_view_as_target': text in positive_views})
                added += 1
                if added == limit:
                    break
        # Neither source, role nor input order is a signal made available to the model.
        permutation = sorted(range(len(r['files'])), key=lambda j: order(r['record'] + ':' + r['files'][j]))
        old_files = r['files']
        aliases = {file: 'item-' + order(r['record'] + ':' + file)[:20] + '.pdf' for file in old_files}
        r['files'] = [aliases[old_files[j]] for j in permutation]
        r['texts'] = [r['texts'][j] for j in permutation]
        r['candidate_provenance'] = [provenance[j] for j in permutation]
        r['truth'] = {aliases[f]: label for f, label in r['truth'].items()}
        r['acceptable'] = {aliases[f]: labels for f, labels in r.get('acceptable', {}).items()}
        r.pop('other_documents', None)
        r.pop('document_keys', None)
        result.append(r)
    return result


def targets(record):
    import numpy as np
    return np.asarray([[label in record.get('acceptable', {}).get(file, [record['truth'].get(file)])
                        for file in record['files']] for label in record['labels']], dtype=float)


def freeze_texts(records):
    """Store complete document text once; folders refer to content hashes."""
    documents = {}
    for record in records:
        keys = []
        for text in record.pop('texts'):
            key = hashlib.sha256(text.encode('utf-8')).hexdigest()
            documents.setdefault(key, text)
            keys.append(key)
        record['text_ids'] = keys
    return documents


def restore_texts(records, documents):
    for record in records:
        record['texts'] = [documents[key] for key in record['text_ids']]


def distractor_views(directory):
    manifest = directory / 'distractors.json'
    if not manifest.exists(): return []
    items = read(manifest)
    if not isinstance(items, list):
        raise ValueError('Distractors require a reviewed document inventory')
    result = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('file'), str) or not item['file']:
            raise ValueError('Distractor inventory is missing its document file identity')
        file = (directory / item['file']).resolve()
        text = (directory / item.get('text_file', str(Path(item['file']).with_suffix('.txt')))).resolve()
        if (not file.is_relative_to(directory.resolve()) or not text.is_relative_to(directory.resolve())
                or item.get('review_status') != 'accepted'):
            raise ValueError('Unreviewed or nonlocal distractor: ' + item['file'])
        if not item.get('source_sha256') or not item.get('source_url', '').startswith('https://'):
            raise ValueError('Missing distractor source provenance: ' + item['file'])
        if not isinstance(item.get('same_proceeding'), bool):
            raise ValueError('Missing distractor proceeding relationship: ' + item['file'])
        if item.get('text_sha256'):
            if digest(text) != item['text_sha256']:
                raise ValueError('Changed distractor text: ' + item['file'])
        elif not file.exists():
            raise ValueError('Text-only distractor lacks its reviewed text hash: ' + item['file'])
        identity = source_identity(dict(item, label=item['file']))
        result.append((item, text.read_text(encoding='utf-8-sig'), identity))
    return result


def load_record(directory, gold=None, views=None, referring_view=None):
    import refs
    g = gold if gold is not None else read(directory / 'gold.json')
    if views is None:
        views = [dict(label=e['label'], file=e['file'], text_file=str(Path('files') / Path(e['file']).with_suffix('.txt')))
                 for e in g['exhibits']]
    files = sorted(e['file'] for e in views)
    by_file = {e['file']: e for e in views}
    full_texts = [(directory / by_file[f]['text_file']).read_text(encoding='utf-8-sig') for f in files]
    r = {'record': g['record_id'], 'labels': sorted(e['label'] for e in views),
         'files': files, 'truth': {e['file']: e['label'] for e in views},
         'texts': [visible_text(t) for t in full_texts],
         'document_keys': {f: source_identity(next(e for e in g['exhibits'] if e['label'] == by_file[f]['label']))
                            for f in files} if gold is not None else legacy_document_keys(directory, files, full_texts)}
    affidavit = (directory / (referring_view['text_file'] if referring_view else 'affidavit.txt')).read_text(encoding='utf-8-sig')
    r['ctx'] = refs.build(r, affidavit)
    r['other_documents'] = [('affidavit.pdf', visible_text(affidavit))]
    r['document_keys'].update(legacy_document_keys(directory, ['affidavit.pdf'], [affidavit])
                              if (directory / 'split.json').exists() else {'affidavit.pdf': 'referring:' + digest(directory / 'source.json')})
    for item, text, identity in distractor_views(directory):
        r['other_documents'].append((item['file'], visible_text(text), item['same_proceeding']))
        r['document_keys'][item['file']] = identity
    return r, g


def association_views(directory, gold_path, gold):
    """Reviewed model coverage is a derived projection of complete source Gold."""
    labels = {e['label'] for e in gold['exhibits']}
    manifest = read(directory / 'model-views.json')
    if manifest.get('review_status') != 'accepted' or manifest.get('source_gold_sha256') != digest(gold_path):
        raise ValueError('Unreviewed or stale model projection: ' + gold['record_id'])
    if len(manifest['views']) != len(labels) or {e['label'] for e in manifest['views']} != labels:
        raise ValueError('Model coverage does not account for every source label: ' + gold['record_id'])
    eligible, unavailable = [], []
    for view in manifest['views']:
        if not view['eligible']:
            reason = view.get('omission_reason') or view.get('reason')
            if not reason: raise ValueError('Missing model-view omission reason')
            unavailable.append({'label': view['label'], 'reason': reason})
            continue
        path = (directory / view['text_file']).resolve()
        # Each lane owns shared OCR derivatives beside its records directory.
        if not path.is_relative_to(directory.parent.parent.resolve()) or digest(path) != view['text_sha256']:
            raise ValueError('Changed or nonlocal model text: ' + gold['record_id'])
        eligible.append(view)
    if len({e['file'] for e in eligible}) != len(eligible):
        raise ValueError('Model projection repeats a file: ' + gold['record_id'])
    referring = manifest.get('referring_document_view')
    if referring:
        path = (directory / referring['text_file']).resolve()
        if not path.is_relative_to(directory.parent.parent.resolve()) or digest(path) != referring['text_sha256']:
            raise ValueError('Changed or nonlocal referring text: ' + gold['record_id'])
    return eligible, unavailable, referring


def main():
    import refs
    import score
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=PRIVATE / 'inputs.json')
    parser.add_argument('--expansion', type=Path, default=PRIVATE / 'expansion')
    parser.add_argument('--expected-new', type=int, default=100)
    options = parser.parse_args()
    records = read(BENCH / 'assoc_all/inputs2.json')
    hard = set(read(BENCH / 'assoc_all/hard.json'))
    baseline_ids = {r['record'] for r in records}
    for p in sorted(RECORDS.glob('*/gold.json')):
        if p.parent.name not in baseline_ids:
            r, _ = load_record(p.parent)
            records.append(r); baseline_ids.add(r['record'])
    golds, sources = {}, {}
    for r in records:
        p = RECORDS / r['record'] / 'gold.json'
        golds[r['record']] = read(p)
        affidavit = (p.parent / 'affidavit.txt').read_text(encoding='utf-8')
        r['ctx'] = refs.build(r, affidavit)
        r['other_documents'] = [('affidavit.pdf', visible_text(affidavit))]
        texts = [(p.parent / 'files' / Path(f).with_suffix('.txt')).read_text(encoding='utf-8') for f in r['files']]
        r['texts'] = [visible_text(t) for t in texts]
        r['document_keys'] = legacy_document_keys(p.parent, r['files'] + ['affidavit.pdf'], texts + [affidavit])
        sources[r['record']] = {'gold_sha256': digest(p), 'source_metadata_sha256': digest(p.with_name('source.json')),
                                'split_sha256': digest(p.with_name('split.json')), 'root': str(p.parent)}
        assert r['truth'] == {e['file']: e['label'] for e in golds[r['record']]['exhibits']}, 'Saved gold changed; rebuild deliberately'
    new, coverage = [], {}
    accepted = accepted_gold(options.expansion, 'source-gold.json', with_directories=True)
    if len(accepted) != options.expected_new:
        raise ValueError(f'Expected {options.expected_new} independently reviewed new records; found {len(accepted)}')
    for rid, (p, directory) in sorted(accepted.items()):
        g = read(p)
        views, unavailable, referring = association_views(directory, p, g)
        r, _ = load_record(directory, g, views, referring)
        if r['record'] in golds:
            raise ValueError('Repeated record: ' + r['record'])
        if not (g.get('gold_provenance') or g.get('author_provenance')) or not g.get('events'):
            raise ValueError('Missing source annotation/provenance: ' + r['record'])
        golds[r['record']] = g
        sources[r['record']] = {'gold_sha256': digest(p), 'source_metadata_sha256': digest(directory / 'source.json'),
                                'gold_path': p.relative_to(options.expansion.parent).as_posix(),
                                'model_view_manifest_sha256': digest(directory / 'model-views.json'), 'root': str(directory)}
        if (directory / 'split.json').exists():
            sources[r['record']]['split_sha256'] = digest(directory / 'split.json')
        if (directory / 'distractors.json').exists():
            sources[r['record']]['distractor_manifest_sha256'] = digest(directory / 'distractors.json')
        coverage[rid] = {'source_labels': len(g['exhibits']), 'eligible_labels': len(views),
                         'unavailable_views': unavailable, 'source_events': len(g['events'])}
        records.append(r); new.append(r['record'])
    # Union all known proceeding names and normalized court-file identities.
    parent = {}
    def find(x):
        parent.setdefault(x, x)
        if parent[x] != x: parent[x] = find(parent[x])
        return parent[x]
    for r in records:
        g = golds[r['record']]
        source = read(Path(sources[r['record']]['root']) / 'source.json')
        keys = ['record:' + r['record']]
        for key in (r.get('group'), g.get('family'), score.association_groups().get(r['record'])):
            if key: keys.append('family:' + key.casefold())
        case = re.sub(r'[^a-z0-9]', '', (g.get('court_file') or '').casefold())
        if re.search(r'\d', case):
            keys.append('case:' + g['jurisdiction'].casefold() + ':' + case)
        urls = [source.get('url') or ''] + [part.get('url') or '' for part in source.get('sources', [])]
        for url in urls:
            recap = re.search(r'(gov\.uscourts\.[a-z0-9]+\.\d+)\.\d+\.\d+\.pdf', url)
            if recap: keys.append('recap:' + recap[1])
        for key in keys[1:]: parent[find(key)] = find(keys[0])
    for r in records:
        r['group'] = find('record:' + r['record'])
        g = golds[r['record']]
        annotations = {e['label']: e for e in g['exhibits']}
        r['acceptable'] = {file: [label] + [x for x in annotations[label].get('same_text_as', []) if x in r['labels']]
                           for file, label in r['truth'].items()}
        r['ambiguity_groups'] = [sorted(set(group) & set(r['labels'])) for group in g.get('indistinguishable_groups', [])
                                 if len(set(group) & set(r['labels'])) > 1]
        for group in r['ambiguity_groups']:
            if set(group) - set(r['labels']):
                raise ValueError('Unknown label in source ambiguity group: ' + r['record'])
            for file, label in r['truth'].items():
                if label in group:
                    r['acceptable'][file] = sorted(set(r['acceptable'][file]) | set(group))
        r['subject'] = g['subject']; r['jurisdiction'] = g['jurisdiction'].casefold()
        r['new'] = r['record'] in new
    assignments = assign_folds(records)
    test_groups = {group for group, fold in assignments.items() if fold == 0}
    train = [r for r in records if r['group'] not in test_groups]
    test = [r for r in records if r['group'] in test_groups]
    assert not {r['group'] for r in train} & {r['group'] for r in test}
    train, test = packets(train), packets(test)
    no_queries = [{'record': r['record'], 'group': r['group'], 'new': r['new'],
                   'reason': 'No eligible labelled association view; source Gold is retained independently'}
                  for r in train + test if not r['labels']]
    train, test = [r for r in train if r['labels']], [r for r in test if r['labels']]
    documents = freeze_texts(train + test)
    output = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'schema': 'affidavit-hard.v2',
              'baseline_records': len(baseline_ids), 'new_records': len(new), 'sources': sources,
              'saved_input_sha256': digest(BENCH / 'assoc_all/inputs2.json'),
              'proceeding_ledger_sha256': digest(BENCH / 'sources-ledger.jsonl'),
              'historical_hard_ids': sorted(hard), 'group_folds': assignments,
              'documents': documents, 'train': train, 'test': test,
              'new_source_gold_coverage': coverage,
              'new_records_with_association_queries': sum(bool(item['eligible_labels']) for item in coverage.values()),
              'new_source_exhibits': sum(item['source_labels'] for item in coverage.values()),
              'new_eligible_exhibits': sum(item['eligible_labels'] for item in coverage.values()),
              'records_without_association_queries': no_queries,
              'limitations': ['Text-only model; visually distinct targets and distractors can have identical or empty text',
                             'Available target label inventory supplied; missing-label detection not evaluated',
                             'Fresh proceeding-group split; scores are not comparable to the historical hard-tier split']}
    options.out.parent.mkdir(parents=True, exist_ok=True)
    options.out.write_text(json.dumps(output, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'train': len(train), 'test': len(test), 'new': len(new),
                      'new_subjects': dict(Counter(golds[r]['subject'] for r in new))}))


if __name__ == '__main__':
    main()
