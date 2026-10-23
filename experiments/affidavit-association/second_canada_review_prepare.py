"""Prepare hash-bound original evidence for independent Canada source review; no approval."""
import json
import os
import sqlite3
import sys
from pathlib import Path

import fitz
from PIL import Image, ImageDraw

from second_tribunals_sources import sha, dump

OUT = Path('benchmarks/local-data/affidavit-association/expansion-2/canada')
HOME = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalData'


def original(digest):
    db = sqlite3.connect((HOME / 'corpus/corpus.sqlite').as_uri() + '?mode=ro&immutable=1', uri=True)
    row = db.execute('select path from files where sha256=?', (digest,)).fetchone()
    db.close()
    path = HOME / row[0]
    assert sha(path) == digest
    return path


def prepare(rid):
    directory = OUT / 'records' / rid
    path = directory / 'source-gold.json'
    gold = json.loads(path.read_text(encoding='utf8'))
    sources = {}
    referring = gold.get('referring_document', {})
    body = referring.get('source_files') or referring.get('parts', [])
    for part in body:
        sources.setdefault(part['sha256'], set()).update([part['pages'][0], part['pages'][-1]])
    inventory = []
    for item in gold['exhibits']:
        digest, pages = item.get('source_sha256'), item.get('source_pages', [])
        cover = item.get('source_cover_pages', [])
        if digest and pages:
            sources.setdefault(digest, set()).update([pages[0], pages[-1]] + cover)
        inventory.append({key: item.get(key) for key in ['label', 'description', 'availability', 'document_date', 'date', 'source_sha256', 'source_pages', 'source_cover_pages', 'references']})
    folder = OUT / 'review-peer' / rid
    images = []
    for digest, pages in sources.items():
        selected = sorted(pages)
        with fitz.open(original(digest)) as pdf:
            for offset in range(0, len(selected), 8):
                group = selected[offset:offset + 8]
                sheet = Image.new('RGB', (1800, ((len(group) + 1) // 2) * 1200), '#bbb')
                draw = ImageDraw.Draw(sheet)
                for index, number in enumerate(group):
                    pix = pdf[number - 1].get_pixmap(dpi=110, alpha=False)
                    image = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
                    image.thumbnail((890, 1165))
                    x, y = index % 2 * 900, index // 2 * 1200
                    sheet.paste(image, (x, y + 30))
                    draw.text((x + 10, y + 8), f'{digest[:12]} original {number}', fill='black')
                target = folder / f'{digest[:12]}-{offset // 8}.png'
                target.parent.mkdir(parents=True, exist_ok=True)
                sheet.save(target)
                images.append(dict(file=target.relative_to(OUT).as_posix(), sha256=sha(target), source_sha256=digest, original_pages=group))
    dump(folder / 'inspection.json', dict(status='prepared_not_reviewed', record_id=rid, author_gold_sha256=sha(path), inventory=inventory, images=images))
    print(rid, len(images))


if __name__ == '__main__':
    for rid in sys.argv[1:]:
        prepare(rid)
