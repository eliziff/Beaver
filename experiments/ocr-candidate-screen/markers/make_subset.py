"""Per gold OCR document, a PDF holding only its recognized pages (pages copied, not re-rendered).

  make_subset.py LINES.jsonl.gz OUT_DIR SPLIT[,SPLIT]
Writes OUT_DIR/<split>/<sha>.pdf and OUT_DIR/<split>/<sha>.pages.json (subset index -> page number).
"""
import collections, gzip, json, sys
from pathlib import Path

import pypdfium2 as pdfium

lines_path, out, splits = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].split(',')
pages = collections.defaultdict(set)
paths, split_of = {}, {}
for raw in gzip.open(lines_path, 'rt', encoding='utf-8'):
    row = json.loads(raw)
    if row['split'] in splits:
        pages[row['sha']].add(row['page'])
        paths[row['sha']] = row['path']
        split_of[row['sha']] = row['split']
total = 0
for sha, numbers in pages.items():
    numbers = sorted(numbers)
    target = out / split_of[sha]
    target.mkdir(parents=True, exist_ok=True)
    source = pdfium.PdfDocument(paths[sha])
    subset = pdfium.PdfDocument.new()
    subset.import_pages(source, [n - 1 for n in numbers])
    subset.save(str(target / f'{sha}.pdf'))
    (target / f'{sha}.pages.json').write_text(json.dumps(numbers))
    total += len(numbers)
print(len(pages), 'documents', total, 'pages')
