"""Freeze the evaluation gold: completed pass-1 blocks with their hierarchy pass applied.

Reads the authoring runs without writing them. Each completed run whose hierarchy pass
(hierarchy-authoring/result.json) matches its gold is applied through hierarchy.apply and
saved once as frozen-eval/gold/<sha>.json.gz. The family split is frozen from
family-selection.json on the first run and never changes; a frozen source is never rewritten,
so later runs only add the sources that completed since. Pin LEGAL_STRUCTURE_ADDON so the
shared composition that validates each frozen gold is fixed.

  python experiments/legal-structure-gold/freeze_eval.py
"""
import argparse
import hashlib
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import hierarchy
import worker
from gold import require

ROOT = Path(__file__).resolve().parents[2]
HOME = ROOT / 'benchmarks/local-data/legal-structure-gold'
SALT = 'pdf-structure-gold-eval-split-v1'
TEST_SHARE = 0.2


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def frozen_split(out):
    """The family split, made once and bound by hash.

    Families exposed during earlier tuning stay in development, as the selection records. The
    rest are ordered by a salted hash of their identity and fill test to a fifth of all sources;
    the others train. A family over a fiftieth of the sources trains, so no one family dominates
    the test set. The selection's own 80/10/10 assignment left test at 72 sources once its 316
    exposed members were moved to development.
    """
    split = out / 'split.json'
    if not split.exists():
        selection = json.loads((HOME / 'family-selection.json').read_text(encoding='utf-8'))
        family = {m['sha256']: m['family_id'] for m in selection['members']}
        exposed = {family[sha] for sha in selection['exposed_sources'] if sha in family}
        sizes = {}
        for identity in family.values(): sizes[identity] = sizes.get(identity, 0) + 1
        total, target = len(family), round(len(family) * TEST_SHARE)
        assigned, tested = {identity: 'development' for identity in exposed}, 0
        for identity in sorted(set(sizes) - exposed, key=lambda f: hashlib.sha256((SALT + f).encode()).hexdigest()):
            fits = tested < target and sizes[identity] <= total // 50
            assigned[identity] = 'test' if fits else 'train'
            tested += sizes[identity] if fits else 0
        worker.write_json(split, {'source': 'family-selection.json', 'source_sha256': digest(HOME / 'family-selection.json'),
                                  'salt': SALT, 'test_share': TEST_SHARE, 'policy': frozen_split.__doc__.strip(),
                                  'members': {sha: {'split': assigned[identity], 'family_id': identity}
                                              for sha, identity in family.items()}})
    return json.loads(split.read_text(encoding='utf-8'))


def runs(home):
    """The newest completed run per source that carries a hierarchy pass over its own blocks."""
    chosen = {}
    # Reauthored sources keep theirs beside the catalogue's selected gold; new sources in their run.
    found = [*(home / 'current').glob('*/hierarchy-authoring/result.json'),
             *(path for mode in ('digitalborn', 'ocr') for path in (home / mode).glob('*/*/hierarchy-authoring/result.json'))]
    for result in sorted(found):
        job = result.parents[1]
        receipt = json.loads((job / 'receipt.json').read_text(encoding='utf-8'))
        if receipt.get('status') != 'complete' or not (job / 'gold.json.gz').exists(): continue
        if result.stat().st_mtime < (job / 'gold.json.gz').stat().st_mtime: continue
        sha = receipt['source_sha256']
        if sha not in chosen or receipt['finished_at'] > chosen[sha][1]['finished_at']:
            chosen[sha] = (job, receipt)
    return chosen


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, default=HOME / 'frozen-eval')
    parser.add_argument('--workers', type=int, default=3)
    args = parser.parse_args()
    out = args.out
    (out / 'gold').mkdir(parents=True, exist_ok=True)
    split = frozen_split(out)['members']
    manifest_path = out / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {'sources': {}}
    xfa = {row['sha256'] for row in json.loads((HOME / 'xfa-forms.json').read_text(encoding='utf-8')).get('forms', [])}
    added, skipped, pending = 0, {}, []
    for sha, (job, receipt) in sorted(runs(HOME).items()):
        if sha in manifest['sources']: continue
        reason = 'xfa' if sha in xfa else 'outside_split' if sha not in split else None
        if reason:
            skipped[reason] = skipped.get(reason, 0) + 1; continue
        pending.append((sha, job, receipt))
    with ProcessPoolExecutor(args.workers) as pool:
        results = pool.map(freeze_one, [(sha, job, out) for sha, job, _ in pending])
        for (sha, job, receipt), (target, value_pages, report, error) in zip(pending, results):
            if error:
                skipped['invalid'] = skipped.get('invalid', 0) + 1
                print('skip', sha[:12], error[:200]); continue
            add(manifest, sha, job, receipt, split, target, value_pages, report); added += 1
            if added % 20 == 0: worker.write_json(manifest_path, manifest)
    for sha, row in manifest['sources'].items(): row['split'] = split[sha]['split']
    manifest['rounds'] = manifest.get('rounds', 0) + bool(added)
    worker.write_json(manifest_path, manifest)
    counts = {}
    for row in manifest['sources'].values():
        key = f"{row['split']}/{row['mode']}"; counts[key] = counts.get(key, 0) + 1
    print(json.dumps({'added': added, 'skipped': skipped, 'frozen': len(manifest['sources']), 'by_split_mode': counts}))


def freeze_one(item):
    """Apply one hierarchy pass to its gold and save the result; never writes the run."""
    sha, job, out = item
    try:
        value = worker.read_json(job / 'gold.json.gz')
        result = json.loads((job / 'hierarchy-authoring/result.json').read_text(encoding='utf-8'))
        blocks = {block['id'] for block in value['layers']['legal_structure']['blocks']}
        scopes = [scope['rows'] for scope in result['scopes']]
        require(all(fragment in blocks for scope in scopes for row in scope for fragment in row['fragments']),
                'Hierarchy rows name blocks this gold lacks')
        # The validated layer with parents; parents leave the manuscript unchanged.
        layer, report = hierarchy.apply(value, scopes, [scope['parents'] for scope in result['scopes']])
    except (ValueError, KeyError) as error:
        return None, None, None, str(error)
    value['layers']['legal_structure'] = layer
    target = out / 'gold' / f'{sha}.json.gz'
    worker.write_json(target, value)
    return target, len(value['pages']), report, None


def add(manifest, sha, job, receipt, split, target, pages, report):
        manifest['sources'][sha] = {
            'mode': receipt['configuration']['mode'], 'split': split[sha]['split'], 'family_id': split[sha]['family_id'],
            'pages': pages, 'run': job.relative_to(HOME).as_posix(), 'receipt_sha256': digest(job / 'receipt.json'),
            'gold_sha256': digest(job / 'gold.json.gz'), 'hierarchy_sha256': digest(job / 'hierarchy-authoring/result.json'),
            'frozen_sha256': digest(target), 'hierarchy_report': report, 'round': manifest.get('rounds', 0) + 1}


if __name__ == '__main__':
    main()
