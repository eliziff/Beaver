"""Render gold OCR pages at the native 144 dpi and cut each recognized line's own box.

Writes one Arrow IPC file per split with a `lines` struct column (im = PNG of the raw box crop,
im_pad = the box padded vertically by 30% of its height, text = corrected gold line, plus
provenance and marker/reference spans). Adapter.prepare applies the native ink-box margins.
"""
import collections, gzip, json, sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc

DPI = 144


def render_doc(job):
    import pypdfium2 as pdfium
    path, items = job
    out = []
    try:
        pdf = pdfium.PdfDocument(path)
    except Exception as error:  # a missing PDF is reported, never silently dropped
        return [], [f'{path}: {error}']
    by_page = collections.defaultdict(list)
    for item in items:
        by_page[item['page']].append(item)
    problems = []
    for number, lines in by_page.items():
        page = pdf[number - 1]
        w, h = page.get_size()
        if abs(w - lines[0]['page_w']) > 1 or abs(h - lines[0]['page_h']) > 1:
            problems.append(f'{path} p{number}: size {w:.1f}x{h:.1f} != {lines[0]["page_w"]}x{lines[0]["page_h"]}')
            continue
        bitmap = page.render(scale=DPI / 72, grayscale=True)
        gray = bitmap.to_numpy()
        if gray.ndim == 3:
            gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY) if gray.shape[2] == 3 else gray[:, :, 0]
        H, W = gray.shape
        s = DPI / 72
        for item in lines:
            x0, y0, x1, y1 = item['bbox']
            l, t, r, b = int(x0 * s), int(y0 * s), int(np.ceil(x1 * s)), int(np.ceil(y1 * s))
            l, t, r, b = max(0, l), max(0, t), min(W, r), min(H, b)
            if r - l < 2 or b - t < 2:
                continue
            pad = int(round(0.3 * (b - t)))
            crop = gray[t:b, l:r]
            padded = gray[max(0, t - pad):min(H, b + pad), l:r]
            ok1, png = cv2.imencode('.png', crop)
            ok2, png_pad = cv2.imencode('.png', padded)
            item = dict(item)
            item['im'], item['im_pad'] = png.tobytes(), png_pad.tobytes()
            out.append(item)
    return out, problems


def main():
    lines_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    by_doc = collections.defaultdict(list)
    for raw in gzip.open(lines_path, 'rt', encoding='utf-8'):
        row = json.loads(raw)
        by_doc[row['path']].append(row)
    results = collections.defaultdict(list)
    problems = []
    with ProcessPoolExecutor(4) as pool:
        for items, issues in pool.map(render_doc, list(by_doc.items())):
            problems.extend(issues)
            for item in items:
                results[item['split']].append(item)
    for split, items in results.items():
        items.sort(key=lambda x: (x['sha'], x['page'], x['id']))
        struct = pa.array([{
            'im': x['im'], 'im_pad': x['im_pad'], 'text': x['gold'], 'ocr': x['ocr'], 'sha': x['sha'],
            'page': x['page'], 'id': x['id'], 'markers': json.dumps(x['markers']), 'refs': json.dumps(x['refs']),
        } for x in items])
        table = pa.table({'lines': struct})
        with ipc.new_file(str(out_dir / f'{split}.arrow'), table.schema) as writer:
            writer.write_table(table)
        print(split, len(items))
    print('problems', len(problems))
    for p in problems[:20]:
        print(p)


if __name__ == '__main__':
    main()
