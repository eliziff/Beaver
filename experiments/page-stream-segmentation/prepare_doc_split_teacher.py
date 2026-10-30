"""Freeze actual reviewed page-stream teacher seams and their saved image contexts.

This deliberately does not use the general dataset.json gap labels or PDF pool.
The 199 corrected economy-reference seams and the separate 24-seam independently authored
panel take their sources' partitions in the gold store (source.json); the panel is test.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'experiments/legal_pdf_corpus'))
import gold_store  # noqa: E402
DEFAULT = ROOT / 'benchmarks/local-data/page-stream-segmentation'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build(root, out):
    inputs = {}

    def read(relative):
        path = root / relative
        inputs[relative] = digest(path)
        return json.loads(path.read_text(encoding='utf-8'))

    economy = read('call-economy/spec.json')
    adjudication = read('call-economy/adjudication/results.json')
    correction = read('call-economy/reference-corrections.json')
    fresh = read('council-adjudication/spec.json')
    fresh_gold = read('judge-context/fresh-gold/gold.json')
    reviewed = {c['case_id']: c['label'] for c in adjudication['cases']}
    corrected = {c['case_id']: c['corrected_page_edge_label'] for c in correction['corrections']}
    contexts = {}
    for assignment in economy['assignments']:
        if assignment['arm'] == 'eight-single':
            for case_id in assignment['focal_cases']:
                contexts[case_id] = economy['jobs'][assignment['key']]['images']
    cases, excluded = [], []
    for case in economy['cases']:
        key = case['case_id']
        label = corrected.get(key, reviewed.get(key, case['reference']))
        if case['excluded_unresolved'] or type(label) is not int or label not in (0, 1):
            excluded.append(key)
            continue
        cases.append({**{k: case[k] for k in ('case_id', 'sha256', 'family_id', 'right_page')},
                      'label': label, 'split': gold_store.source(case['sha256'])['partition'],
                      'teacher_images': contexts[key], 'gold_panel': 'corrected-economy-references'})
    for case in fresh['cases']:
        if case['panel'] != 'fresh':
            continue
        key = case['case_id']
        labels = set()
        for part in fresh_gold['sources']:
            if part['sha256'] == case['sha256'] and case['right_page'] in part['pages'] and case['right_page']-1 in part['pages']:
                labels.add(int(case['right_page'] in part['document_starts']))
        if labels != {case['expected']}:
            raise ValueError('Fresh reference is not backed by authored gold: ' + key)
        job = next(j for j in fresh['proposal_jobs'] if j['case_id'] == key and j['role'] == 'normal')
        cases.append({**{k: case[k] for k in ('case_id', 'sha256', 'family_id', 'right_page')},
                      'label': case['expected'], 'split': gold_store.source(case['sha256'])['partition'], 'teacher_images': job['images'],
                      'gold_panel': 'independent-fresh-sol-max'})
    family_splits, source_splits, seen, assets = {}, {}, set(), {}
    out.mkdir(parents=True, exist_ok=True)
    (out / 'images').mkdir(exist_ok=True)
    for case in cases:
        if (case['case_id'] in seen or family_splits.setdefault(case['family_id'], case['split']) != case['split']
                or source_splits.setdefault(case['sha256'], case['split']) != case['split']):
            raise ValueError('Teacher seam repeated or source family crosses partitions')
        seen.add(case['case_id'])
        images = []
        for relative in case.pop('teacher_images'):
            source = (ROOT / relative).resolve()
            if not source.is_relative_to(root.resolve()):
                raise ValueError('Teacher image escapes its owning experiment')
            match = re.fullmatch(r'page-(\d+)-\d+\.png', source.name)
            if not match:
                raise ValueError('Teacher image lacks original physical page identity')
            source_hash = digest(source)
            if source_hash not in assets:
                target = out / 'images' / (source_hash + '.png')
                with Image.open(source) as image:
                    image.convert('RGB').resize((512, 512)).save(target)
                assets[source_hash] = {'path': target.relative_to(out).as_posix(), 'sha256': digest(target),
                                       'teacher_image': relative, 'teacher_sha256': source_hash}
            images.append({**assets[source_hash], 'page': int(match.group(1))})
        pages = [image['page'] for image in images]
        if pages != list(range(pages[0], pages[-1]+1)) or case['right_page'] not in pages[1:]:
            raise ValueError('Teacher context does not span the original seam')
        case['images'] = images
    common = {'schema_version': 'doc-split-teacher.v1', 'origin': 'machine_test',
        'run_id': 'doc-split-teacher-student-v1', 'source_artifacts': inputs,
        'excluded_unresolved': excluded, 'image_preprocessing': 'saved teacher RGB images resized to 512x512',
        'report': {'partition_status': 'Teacher-reference experiment; the gold store\'s partitions (source.json). '
                   'Most reference agreements are model-authored and not independently visually audited.'}}
    for name, chosen in [('teacher-training.json', [c for c in cases if c['split'] != 'test']),
                         ('teacher-test.json', [c for c in cases if c['split'] == 'test'])]:
        (out / name).write_text(json.dumps({**common, 'cases': chosen}, indent=2) + '\n', encoding='utf-8')
    summary = {'cases': len(cases), 'families': len(family_splits), 'unique_images': len(assets),
               'splits': {s: {'seams': sum(c['split']==s for c in cases),
                             'labels': dict(Counter(c['label'] for c in cases if c['split']==s)),
                             'families': sum(v==s for v in family_splits.values())}
                          for s in ('train', 'development', 'test')}, 'source_artifacts': inputs,
               'excluded_unresolved': excluded, 'exporter_sha256': digest(Path(__file__))}
    (out / 'teacher-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT)
    parser.add_argument('--out', type=Path, default=DEFAULT / 'doc-split-v1/teacher-data')
    args = parser.parse_args()
    build(args.root, args.out)
