"""Read numeric printed folios in cached Canadian originals, blind to citations.

This uses only embedded text in the page margins. Ambiguous or image-only pages
remain pending for visual review; no OCR or model is invoked.
"""

import argparse
import hashlib
import json
import random
import re
from collections import Counter
from pathlib import Path

import fitz


ROOT = Path(__file__).resolve().parents[2]
FOLDER = ROOT / 'tmp/pdf-pagination/canadian-diverse-originals'
parser = argparse.ArgumentParser()
parser.add_argument('--manifest', type=Path, default=FOLDER / 'manifest.json')
parser.add_argument('--output', type=Path, default=FOLDER / 'folio-assessment.json')
args = parser.parse_args()


def margin_numbers(page):
    found = []
    height = page.rect.height
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            value = ''.join(span['text'] for span in line['spans']).strip()
            x0, y0, x1, y1 = line['bbox']
            if y1 > height * .12 and y0 < height * .88:
                continue
            # A bare folio is safer than inferring one from a case title or citation.
            match = re.fullmatch(r'\s*(?:[-–—]\s*)?([0-9]{1,5})(?:\s*[-–—])?\s*', value)
            if match:
                found.append({'text': match[1], 'line': value,
                              'location': 'header' if y1 <= height * .12 else 'footer',
                              'box': [round(n, 1) for n in (x0, y0, x1, y1)]})
    return found


rows = json.loads(args.manifest.read_text(encoding='utf-8'))
originals = [row for row in rows if row.get('outcome') == 'original']
if len({row['sha256'] for row in originals}) != len(originals):
    raise ValueError('Manifest repeats an original PDF hash')

readings = []
for row in originals:
    data = Path(row['path']).read_bytes()
    if hashlib.sha256(data).hexdigest() != row['sha256']:
        raise ValueError(f"Original PDF hash changed: {row['sha256']}")
    record = {'sha256': row['sha256'], 'court': row['court'],
              'year': row.get('year') or int(row['citation'][:4]),
              'source_url': row.get('sourceUrl') or row['url'], 'pages': [], 'duplicate_labels': []}
    with fitz.open(stream=data, filetype='pdf') as pdf:
        if pdf.needs_pass and not pdf.authenticate(''):
            record['status'] = 'encrypted'
        else:
            if len(pdf) != row['page_count']:
                raise ValueError(f"PDF page count changed: {row['sha256']}")
            rng = random.Random(int(row['sha256'][:16], 16))
            count = len(pdf)
            sample = sorted({1, rng.randint(max(1, count // 3), max(1, 2 * count // 3)),
                             rng.randint(max(1, 2 * count // 3 + 1), count)})
            labels_by_page = {}
            for number in sample:
                page = pdf[number - 1]
                found = margin_numbers(page)
                distinct = sorted({candidate['text'] for candidate in found})
                labels_by_page[number] = distinct
                status = ('readable' if len(distinct) == 1 else
                          'ambiguous' if distinct else
                          'no_folio_in_text' if page.get_text('words') else 'image_only')
                record['pages'].append({'pdf_page': number, 'status': status,
                                        'label': distinct[0] if status == 'readable' else None,
                                        'candidates': found})
            offsets = {int(page['label']) - page['pdf_page'] for page in record['pages']
                       if page['status'] == 'readable'}
            readable = sum(page['status'] == 'readable' for page in record['pages'])
            record['status'] = ('consistent_offset' if readable >= 2 and len(offsets) == 1 else
                                'conflicting_offset' if len(offsets) > 1 else
                                'single_reading' if readable else 'pending')
            # Scan the same conservative text rule across the document so repeated
            # printed numbers can be checked against production navigation.
            all_labels = {}
            for number in range(1, count + 1):
                distinct = labels_by_page.get(number)
                if distinct is None:
                    distinct = sorted({candidate['text'] for candidate in margin_numbers(pdf[number - 1])})
                if len(distinct) == 1:
                    all_labels.setdefault(distinct[0], []).append(number)
            record['duplicate_labels'] = [
                {'label': label, 'pdf_pages': pages}
                for label, pages in sorted(all_labels.items(), key=lambda entry: int(entry[0]))
                if len(pages) > 1
            ]
    readings.append(record)

summary = {
    'unique_sha_verified_originals': len(originals),
    'courts': dict(sorted(Counter(row['court'] for row in originals).items())),
    'year_range': [min(row.get('year') or int(row['citation'][:4]) for row in originals),
                   max(row.get('year') or int(row['citation'][:4]) for row in originals)],
    'total_pdf_pages': sum(row['page_count'] for row in originals),
    'document_status': dict(sorted(Counter(row['status'] for row in readings).items())),
    'sampled_page_status': dict(sorted(Counter(page['status'] for row in readings
                                               for page in row['pages']).items())),
    'documents_with_duplicate_text_folios': sum(bool(row.get('duplicate_labels')) for row in readings),
    'reader': 'blind-bare-numeric-margin-text; no OCR, model or citation input',
}
args.output.write_text(json.dumps({'summary': summary, 'readings': readings}, indent=2), encoding='utf-8')
print(json.dumps(summary))
