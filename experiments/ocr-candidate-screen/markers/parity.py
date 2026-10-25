"""Does a pypdfium2 144 dpi render read like the native Hayro render?

  parity.py render SPLIT          -> render/<split>/<sha>/page-N.png + <sha>.images.json
  parity.py run SPLIT OUT         -> legalocr Quality on each images.json (auto backend)
  parity.py compare SPLIT PDF_OUT IMG_OUT
"""
import json, subprocess, sys
from pathlib import Path

import pypdfium2 as pdfium
from rapidfuzz.distance import Levenshtein

HERE = Path(__file__).resolve().parent
LEGALOCR = r'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\dist\legal-ocr-runtime-windows-x64\legalocr.exe'


def render(split):
    for pdf in sorted((HERE / 'subset' / split).glob('*.pdf')):
        folder = HERE / 'render' / split / pdf.stem
        folder.mkdir(parents=True, exist_ok=True)
        doc = pdfium.PdfDocument(str(pdf))
        names = []
        for i in range(len(doc)):
            image = doc[i].render(scale=2, grayscale=True).to_pil()
            name = f'page-{i:04d}.png'
            image.save(folder / name)
            names.append(f'{pdf.stem}/{name}')
        (HERE / 'render' / split / f'{pdf.stem}.images.json').write_text(json.dumps(names))


def run(split, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for listing in sorted((HERE / 'render' / split).glob('*.images.json')):
        target = out / (listing.name.replace('.images.json', '.json'))
        if not target.exists():
            subprocess.run([LEGALOCR, str(listing), '--tier', 'quality', '--output', str(target)], check=True)


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def compare(split, pdf_out, img_out):
    lines = matched = edits = chars = same = 0
    for path in sorted(Path(pdf_out).glob('*.json')):
        a = json.loads(path.read_text(encoding='utf-8'))
        other = Path(img_out) / path.name
        if not other.exists():
            continue
        b = json.loads(other.read_text(encoding='utf-8'))
        for pa, pb in zip(a['pages'], b['pages']):
            for line in pa['lines']:
                lines += 1
                best, text = 0.0, None
                for cand in pb['lines']:
                    box = [v / 2 for v in cand['bbox']]
                    value = iou(line['bbox'], box)
                    if value > best:
                        best, text = value, cand['text']
                if best >= 0.7:
                    matched += 1
                    edits += Levenshtein.distance(line['text'], text)
                    chars += len(line['text'])
                    same += line['text'] == text
    print(json.dumps({'pdf_lines': lines, 'matched_iou_0_7': matched, 'identical_text': same,
                      'cer_between_renders': edits / max(1, chars)}))


if __name__ == '__main__':
    action = sys.argv[1]
    {'render': lambda: render(sys.argv[2]), 'run': lambda: run(sys.argv[2], sys.argv[3]),
     'compare': lambda: compare(sys.argv[2], sys.argv[3], sys.argv[4])}[action]()
