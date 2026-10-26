"""Combine page-stream references with the desktop's reviewed legal-structure splits.

Run on the desktop. Uses saved teacher images, never arbitrary corpus PDFs.
Keep separate contiguous runs of complete documents with page-edge boundaries.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil

from PIL import Image


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def page_edge_runs(part, count):
    scope = set(part['pages'])
    starts = sorted({1, count + 1} | {s for s in part['document_starts'] if type(s) is int})
    mixed = {s['page'] for s in part['document_starts'] if isinstance(s, dict)}
    runs = []
    for first, after in zip(starts, starts[1:]):
        pages = set(range(first, after))
        if not pages <= scope or pages & mixed:
            continue
        if runs and runs[-1][1] == first - 1:
            runs[-1][1] = after - 1
        else:
            runs.append([first, after - 1])
    targets = {page: int(page in starts) for first, last in runs for page in range(first + 1, last + 1)}
    return targets, runs


def merge(base, split_root):
    inputs = {}

    def read(path):
        inputs[str(path)] = digest(path)
        return json.loads(path.read_text(encoding='utf-8'))

    legacy = read(base / 'teacher-training.json')
    test = read(base / 'teacher-test.json')
    family_map = read(base / 'family-map.json')
    final = read(split_root / 'authoring-splits.json')
    manifest = read(split_root / 'authoring-manifest-all.json')
    review = read(split_root / 'reviewed.json')
    rows = {r['sha256']: r for r in manifest['documents']}
    reviewed = {r['sha256'] for r in review['decisions']}
    parent = {}

    def find(key):
        parent.setdefault(key, key)
        if parent[key] != key:
            parent[key] = find(parent[key])
        return parent[key]

    def link(left, right):
        left, right = find(left), find(right)
        parent[max(left, right)] = min(left, right)

    for sha, family in sorted(family_map.items()):
        link(sha, family)
    for case in legacy['cases'] + test['cases']:
        link(case['sha256'], case['family_id'])
    heldout = {find(c['sha256']) for c in test['cases']}
    legacy_targets = {(c['sha256'], c['right_page']): c['label'] for c in legacy['cases']}
    proposed, sources = {}, {}
    within_count = 0
    partition_families = {find(c['sha256']) for c in legacy['cases'] if find(c['sha256']) not in heldout}
    for part in final['sources']:
        sha = part['sha256']
        row = rows[sha]
        count = row['pages']
        if 'pages' not in part and sha not in reviewed:
            raise ValueError('A missing reviewed scope cannot imply whole-packet gold')
        scope = part.get('pages', list(range(1, count+1)))
        if scope != sorted(set(scope)) or any(not 1 <= p <= count for p in scope):
            raise ValueError('Invalid reviewed original-page inventory')
        targets, runs = page_edge_runs({**part, 'pages': scope}, count)
        if any(p > 1 and p - 1 in scope for p in scope) and find(sha) not in heldout:
            partition_families.add(find(sha))
        within_count += sum(isinstance(s, dict) for s in part['document_starts'])
        sources[sha] = {'sha256': sha, 'page_count': count, 'runs': runs, 'family_id': find(sha)}
        proposed.update({(sha, page): label for page, label in targets.items()})
    conflicts = sorted(key for key, label in proposed.items() if key in legacy_targets and legacy_targets[key] != label)
    conflict_set = set(conflicts)
    cases = []
    for old in legacy['cases'] + test['cases']:
        key = old['sha256'], old['right_page']
        source = sources.get(old['sha256'])
        run = next((r for r in source['runs'] if r[0] < old['right_page'] <= r[1]), None) if source else None
        if ((source is not None and run is None)
                or key in conflict_set or (old['split'] != 'test' and key in proposed)):
            continue
        images = [image for image in old['images'] if run is None or run[0] <= image['page'] <= run[1]]
        cases.append({'case_id': old['case_id'], 'sha256': old['sha256'],
            'family_id': find(old['sha256']), 'split': old['split'],
            'targets': {str(old['right_page']): old['label']}, 'images': images,
            'gold_panel': old['gold_panel']})
    assets = {}
    for position, (sha, source) in enumerate(sources.items(), 1):
        own = {page: label for (s, page), label in proposed.items() if s == sha and (s, page) not in conflict_set}
        if find(sha) in heldout:
            continue  # Keep every relative of the fixed final panel out of fitting.
        for first, last in source['runs']:
            targets = {str(p): own[p] for p in range(first+1, last+1) if p in own}
            if not targets:
                continue
            images = []
            for page in range(first, last+1):
                key = sha, page
                if key not in assets:
                    matches = list((split_root / 'annotations' / sha / 'pages').glob(f'page-{page:06d}-*.png'))
                    if len(matches) != 1:
                        raise ValueError('Saved teacher page is absent or ambiguous: ' + sha + ':' + str(page))
                    image_path = matches[0]
                    original_hash = digest(image_path)
                    target = base / 'images' / (original_hash + '.png')
                    if not target.exists():
                        with Image.open(image_path) as image:
                            image.convert('RGB').resize((512, 512)).save(target)
                    assets[key] = {'path': target.relative_to(base).as_posix(), 'sha256': digest(target),
                        'teacher_image': str(image_path), 'teacher_sha256': original_hash, 'page': page}
                images.append(assets[key])
            sequence_id = sha + '-pages-' + str(first) + '-' + str(last)
            cases.append({'case_id': sequence_id, 'sequence_id': sequence_id, 'sha256': sha,
                'family_id': find(sha), 'split': 'pending', 'targets': targets, 'images': images,
                'gold_panel': 'reviewed-legal-structure-splits'})
        if position % 10 == 0:
            print(json.dumps({'legal_sources_staged': position, 'of': len(sources), 'images': len(assets)}), flush=True)
    fitting_families = sorted(partition_families,
        key=lambda f: hashlib.sha256(('doc-split-combined-v1:' + f).encode()).hexdigest())
    development = set(fitting_families[:max(1, len(fitting_families)//5)])
    cases = [c for c in cases if c['split'] == 'test' or c['family_id'] not in heldout]
    for case in cases:
        if case['split'] != 'test':
            case['split'] = 'development' if case['family_id'] in development else 'train'
    common = {'schema_version': 'doc-split-teacher.v2', 'origin': 'machine_test',
        'run_id': 'doc-split-combined-teacher-v1', 'source_artifacts': inputs,
        'excluded_conflicting_seams': conflicts,
        'target_scope': 'Separate contiguous runs of complete documents; documents containing within-page starts omitted.',
        'valid_page_runs': {sha: source['runs'] for sha, source in sources.items()},
        'report': {'partition_status': 'Frozen source-family-separated teacher-label experiment; not human-certified gold.'}}
    for name, chosen in [('training.json', [c for c in cases if c['split'] != 'test']),
                         ('test.json', [c for c in cases if c['split'] == 'test'])]:
        (base / name).write_text(json.dumps({**common, 'cases': chosen}, indent=2) + '\n', encoding='utf-8')
    summary = {'legal_structure_sources': len(sources), 'legal_structure_pages': sum(s['page_count'] for s in sources.values()),
        'within_page_starts_excluded': within_count,
        'retained_legal_structure_pages': sum(last-first+1 for s in sources.values() for first,last in s['runs']),
        'valid_runs': sum(len(s['runs']) for s in sources.values()),
        'conflicting_seams_excluded': conflicts,
        'duplicate_seams_merged': sum(key in legacy_targets for key in proposed if key not in conflict_set),
        'splits': {s: {'contexts': sum(c['split']==s for c in cases),
            'seams': sum(len(c['targets']) for c in cases if c['split']==s),
            'labels': dict(Counter(v for c in cases if c['split']==s for v in c['targets'].values())),
            'families': len({c['family_id'] for c in cases if c['split']==s})} for s in ('train','development','test')},
        'source_artifacts': inputs, 'merger_sha256': digest(Path(__file__))}
    (base / 'combined-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    snapshots = base / 'legal-split-receipts'
    snapshots.mkdir(exist_ok=True)
    for name in ('authoring-splits.json', 'authoring-manifest-all.json', 'reviewed.json'):
        shutil.copyfile(split_root / name, snapshots / name)
    print(json.dumps({k: v for k,v in summary.items() if k != 'source_artifacts'}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--teacher-data', type=Path, required=True)
    parser.add_argument('--legal-split-root', type=Path, required=True)
    args = parser.parse_args()
    merge(args.teacher_data, args.legal_split_root)
