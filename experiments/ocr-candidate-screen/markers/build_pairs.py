"""Training/evaluation crops on our own detector's boxes, labelled by the corrected gold line.

  build_pairs.py SPLIT LEGALOCR_OUT OUT.arrow

A native Quality line is paired with a usable gold line when it is the only recognized line
inside the gold box (IoU >= 0.5): target = corrected gold line. When the detector read a
line-start marker as its own narrow line beside the body (exactly two lines inside), the
marker crop takes the gold marker text and the body crop the rest, provided the body's stock
reading is within 0.6 CER of that rest. Pixels: pypdfium2 at 144 dpi, the box as the native
crop takes it; Adapter.prepare applies the ink box and margins.
"""
import collections, gzip, json, sys
from pathlib import Path

import cv2
import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
import pypdfium2 as pdfium
from rapidfuzz.distance import Levenshtein

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from ocr_ab import iou
from screen import normalized


def usable(row):
    gold = row['gold']
    if not gold.strip() or '�' in gold:
        return False
    g, o = normalized(gold), normalized(row['ocr'])
    return bool(g) and Levenshtein.distance(g, o) / len(g) <= 0.5


def inside(r, lines):
    x0, y0, x1, y1 = r['bbox']
    found = []
    for c in lines:
        c0, d0, c1, d1 = c['bbox']
        overlap = min(y1, d1) - max(y0, d0)
        if overlap >= 0.5 * min(y1 - y0, d1 - d0) and x0 - 2 <= (c0 + c1) / 2 <= x1 + 2:
            found.append(c)
    return sorted(found, key=lambda c: c['bbox'][0])


def main():
    split, out_dir, target = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    rows = [json.loads(x) for x in gzip.open(HERE / 'lines.jsonl.gz', 'rt', encoding='utf-8')]
    by_doc = collections.defaultdict(list)
    for r in rows:
        if r['split'] == split and usable(r):
            by_doc[r['sha']].append(r)
    stats = collections.Counter()
    records = []
    for sha, items in sorted(by_doc.items()):
        numbers = json.loads((HERE / 'subset' / split / f'{sha}.pages.json').read_text())
        doc = json.loads((out_dir / f'{sha}.json').read_text(encoding='utf-8'))
        pdf = pdfium.PdfDocument(str(HERE / 'subset' / split / f'{sha}.pdf'))
        page_of = {n: i for i, n in enumerate(numbers)}
        by_page = collections.defaultdict(list)
        for r in items:
            by_page[r['page']].append(r)
        for number, page_rows in by_page.items():
            index = page_of[number]
            native = doc['pages'][index]['lines']
            gray = pdf[index].render(scale=2, grayscale=True).to_numpy()
            if gray.ndim == 3:
                gray = gray[:, :, 0]
            H, W = gray.shape

            def crop(box):
                l, t = max(0, int(box[0] * 2)), max(0, int(box[1] * 2))
                r_, b = min(W, int(np.ceil(box[2] * 2))), min(H, int(np.ceil(box[3] * 2)))
                if r_ - l < 2 or b - t < 2:
                    return None
                ok, png = cv2.imencode('.png', gray[t:b, l:r_])
                return png.tobytes()

            def emit(box, text, stock, markers, refs, authoring, tag):
                image = crop(box)
                if image is None or not text.strip():
                    stats['empty_crop'] += 1
                    return
                records.append({'im': image, 'im_pad': image, 'text': text, 'ocr': authoring, 'stock': stock,
                                'sha': sha, 'page': number, 'id': tag, 'markers': json.dumps(markers),
                                'refs': json.dumps(refs)})
            for r in page_rows:
                found = inside(r, native)
                gold = r['gold']
                start_marker = [m for m in r['markers'] if m[0] == 0]
                if len(found) == 1 and iou(r['bbox'], found[0]['bbox']) >= 0.5:
                    emit(found[0]['bbox'], gold, found[0]['text'], r['markers'], r['refs'], r['ocr'], r['id'])
                    stats['whole'] += 1
                elif len(found) == 2 and start_marker:
                    b = start_marker[0][1]
                    head, rest = gold[:b].strip(), gold[b:]
                    k = len(rest) - len(rest.lstrip())
                    body = rest.strip()
                    width = r['bbox'][2] - r['bbox'][0]
                    first, second = found
                    narrow = (first['bbox'][2] - first['bbox'][0]) < 0.3 * width
                    aligned = body and Levenshtein.distance(normalized(body), normalized(second['text'])) / len(normalized(body)) <= 0.6
                    if head and narrow and aligned:
                        emit(first['bbox'], head, first['text'], [[0, len(head)]], [], head, r['id'] + '#marker')
                        refs = [[a - b - k, e - b - k] for a, e in r['refs'] if a >= b + k]
                        emit(second['bbox'], body, second['text'], [], refs, body, r['id'] + '#body')
                        stats['split_marker'] += 1
                    else:
                        stats['split_rejected'] += 1
                else:
                    stats[f'unpaired_{min(len(found), 3)}'] += 1
    table = pa.table({'lines': pa.array(records)})
    with ipc.new_file(str(target), table.schema) as writer:
        writer.write_table(table)
    print(split, len(records), json.dumps(stats))


if __name__ == '__main__':
    main()
