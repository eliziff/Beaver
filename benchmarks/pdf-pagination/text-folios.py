"""Blind, independent text-layer folio readings for cached Canadian originals.

The reader sees page geometry and text, never citations or product predictions.
Unclear pages remain pending for image review; they are not scored as agreement.
"""
import hashlib
import json
import random
import re
import argparse
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tmp/pdf-pagination'
parser = argparse.ArgumentParser()
parser.add_argument('--manifest', default='publisher-cached.json')
args = parser.parse_args()
ROWS = json.loads((OUT / args.manifest).read_text(encoding='utf-8'))


def candidates(page):
    width, height = page.rect.width, page.rect.height
    found = []
    for block in page.get_text('dict')['blocks']:
        if 'lines' not in block:
            continue
        for line in block['lines']:
            text = ''.join(span['text'] for span in line['spans']).strip()
            if not text:
                continue
            x0, y0, x1, y1 = line['bbox']
            if y1 > height * .12 and y0 < height * .88:
                continue
            location = 'header' if y1 <= height * .12 else 'footer'
            bare = re.sub(r"^[\s\[({.,;:'\"_\-–—]+|[\s\])}.,;:'\"_\-–—]+$", '', text)
            numbers = set()
            if re.fullmatch(r'\d{1,5}', bare):
                numbers.add(bare)
            else:
                leading = re.match(r'^\s*(\d{1,5})(?!\d)', text)
                trailing = re.search(r'(?<!\d)(\d{1,5})[\s\])}.,;:\'\"_\-–—]*$', text)
                if leading and x0 <= width * .2:
                    numbers.add(leading[1])
                if trailing and x1 >= width * .8:
                    numbers.add(trailing[1])
            for number in numbers:
                found.append({'text': number, 'location': location,
                              'line': text, 'box': [round(n, 1) for n in (x0, y0, x1, y1)]})
    return found


summary = {'cached_originals': len(ROWS), 'existing_image_readings': 0,
           'new_text_readings': 0, 'pending_documents': 0, 'pending_pages': 0}
pending = []
for row in ROWS:
    sha = row['sha256']
    prior = OUT / f'{sha}.visual.json'
    if prior.exists() and json.loads(prior.read_text(encoding='utf-8')).get('batch') != 'blind-independent-text-layer':
        summary['existing_image_readings'] += 1
        continue
    data = Path(row['path']).read_bytes()
    if hashlib.sha256(data).hexdigest() != sha:
        raise ValueError(f'Cached PDF hash changed: {sha}')
    with fitz.open(stream=data, filetype='pdf') as doc:
        count = len(doc)
        rng = random.Random(int(sha[:16], 16))
        later = [rng.randint(max(1, count // 3), max(1, 2 * count // 3)),
                 rng.randint(max(1, 2 * count // 3 + 1), count)]
        opening = [1]
        if len({candidate['text'] for candidate in candidates(doc[0])}) != 1:
            opening += list(range(2, min(3, count) + 1))
        numbers = sorted(set(opening + later))
        readings = []
        for number in numbers:
            found = candidates(doc[number - 1])
            distinct = sorted({candidate['text'] for candidate in found})
            readings.append({'pdf_page': number,
                             'status': 'readable' if len(distinct) == 1 else 'needs_review',
                             'labels': [{'text': distinct[0], 'location': found[0]['location']}]
                                       if len(distinct) == 1 else [],
                             'candidates': found})
        (OUT / f'{sha}.folio-text.json').write_text(json.dumps({
            'reader': 'pymupdf-margin-text-blind-to-citation-and-product',
            'pages': readings}, indent=2), encoding='utf-8')
        if all(reading['status'] == 'readable' for reading in readings):
            (OUT / f'{sha}.visual.json').write_text(json.dumps({
                'pages': [{key: value for key, value in reading.items() if key != 'candidates'}
                          for reading in readings],
                'batch': 'blind-independent-text-layer'}, indent=2), encoding='utf-8')
            summary['new_text_readings'] += 1
        else:
            summary['pending_documents'] += 1
            summary['pending_pages'] += sum(reading['status'] != 'readable' for reading in readings)
            pending.append({'sha256': sha, 'pages': readings})
(OUT / 'canadian-text-folio-pending.json').write_text(json.dumps(pending, indent=2), encoding='utf-8')
print(json.dumps(summary))
