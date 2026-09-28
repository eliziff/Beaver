"""Compare citation-only offsets with independent saved visual readings."""
import collections
import json
import re
import argparse
from pathlib import Path
from sampling import sample_pages

OUT = Path(__file__).resolve().parents[2] / 'tmp/pdf-pagination'
parser = argparse.ArgumentParser()
parser.add_argument('--manifest', default='canadian-authorities-manifest.json')
parser.add_argument('--output', default='canadian-citation-only')
args = parser.parse_args()
rows = json.loads((OUT / args.manifest).read_text(encoding='utf-8'))
if args.manifest.startswith('canadian-') and any(row.get('jurisdiction') != 'CA' for row in rows):
    raise ValueError('Non-Canadian document in Canadian validation cohort')
predictions = OUT / args.output
predictions.mkdir(exist_ok=True)
selected = {}
for row in rows:
    if row['origin'] == 'original' and row.get('starts'):
        selected.setdefault(row['sha256'], row)
counts = collections.Counter()
submitted_counts = collections.Counter()
groups = collections.defaultdict(collections.Counter)
exceptions = []
for row in selected.values():
    match = re.search(r'(\d+)\s*$', row['citation'])
    if not match or int(match[1]) not in row['starts']:
        raise ValueError(f"Submitted reporter citation has no unambiguous starting page: {row['citation']}")
    start = int(match[1])
    submitted_start = start
    prediction = {'anchor': 1, 'starts': row['starts'], 'method': 'citation-only',
                  'bindings': [{'pdfPage': i + 1, 'label': str(start + i)}
                               for i in range(row['page_count'])]}
    (predictions / (row['sha256'] + '.prediction.json')).write_text(json.dumps(prediction))
    visual = OUT / (row['sha256'] + '.visual.json')
    if not visual.exists():
        counts['awaiting_visual'] += 1
        continue
    counts['documents'] += 1
    group = groups[row.get('stratum', row['provider'])]
    group['documents'] += 1
    outcomes = []
    sampled = set(sample_pages(row['sha256'], row['page_count']))
    for page in json.loads(visual.read_text(encoding='utf-8'))['pages']:
        if page['pdf_page'] not in sampled:
            continue
        counts['sampled_pages'] += 1
        expected = str(start + page['pdf_page'] - 1)
        labels = [label['text'] for label in page['labels']]
        if submitted_start is not None and page['status'] == 'readable':
            submitted_counts['agreed' if str(submitted_start + page['pdf_page'] - 1) in labels
                             else 'disagreed'] += 1
        if page['status'] != 'readable':
            counts[page['status']] += 1
            outcome = page['status']
        elif expected in labels:
            counts['agreed'] += 1
            outcome = 'agreed'
        else:
            counts['disagreed'] += 1
            outcome = 'disagreed'
            exceptions.append({'citation': row['citation'], 'sha256': row['sha256'],
                               'pdf_page': page['pdf_page'], 'prediction': expected,
                               'visual': labels})
        group[outcome] += 1
        outcomes.append(outcome)
        if page['pdf_page'] == 1:
            counts['first_page_' + outcome] += 1
    counts['documents_all_sampled_labels_agree' if all(x == 'agreed' for x in outcomes)
           else 'documents_requiring_review'] += 1
(OUT / (args.output + '-manifest.json')).write_text(json.dumps(list(selected.values()), indent=2))
result = {'originals': len(selected), 'counts': dict(counts),
          'prediction_basis': 'submitted citation starting page on physical PDF page 1',
          'provider_groups': dict(groups),
          'submitted_citation_counts': dict(submitted_counts), 'exceptions': exceptions,
          'note': 'Independent blind image or text-layer readings, not fully adjudicated gold; no detector or OCR used for predictions.'}
(OUT / (args.output + '-scores.json')).write_text(json.dumps(result, indent=2))
print(json.dumps(result))
