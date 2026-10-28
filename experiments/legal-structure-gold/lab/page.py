"""One document's pages as the rows carry them: each piece's parser label, gold label, evidence and
text, and the PDF page rendered to PNG from the catalogue's file.

  python page.py ROWS_DIR SHA_PREFIX PAGE [PAGE...] [--png OUT_DIR]
"""
import os
import sqlite3
import sys

import lab
from lab import R

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root, prefix = sys.argv[1], sys.argv[2]
pages = [int(a) for a in sys.argv[3:] if a.isdigit()]
png = sys.argv[sys.argv.index("--png") + 1] if "--png" in sys.argv else None
# --pred PREDICTIONS.jsonl: a tagger's labels as a third column.
pred = {}
if "--pred" in sys.argv:
    import json
    for line in open(sys.argv[sys.argv.index("--pred") + 1], encoding="utf-8"):
        d = json.loads(line)
        pred[d["sha256"]] = dict(zip(d["ids"], d["labels"]))
docs = [d for split in ("development", "train") if os.path.exists(rf"{root}\rows-{split}.jsonl") for d in lab.load(root, split) if d["sha"].startswith(prefix)]
doc = docs[0]
F = {name: k for k, name in enumerate(lab.NAMES)}
print(doc["sha"], doc["mode"], len(doc["text"]), "pieces")
for page in pages:
    print(f"\n=== page {page}")
    print(f"  {'parser':12} {'gold':12} {'x0':>5} {'x1':>5} {'wid':>5} {'ctr':>6} {'gapA':>5} {'gapB':>5} {'bold':>4} {'size':>5} {'up':>4} {'look':>5}  text")
    for k in range(len(doc["text"])):
        if doc["pages"][k] + 1 != page:
            continue
        v = doc["X"][k]
        parser = f"{R[doc['r0'][k]]}{'*' if doc['s0'][k] == 1 else '+' if doc['s0'][k] == 2 else ''}"
        gold = f"{R[doc['rg'][k]] if doc['rg'][k] >= 0 else '?'}{'*' if doc['sg'][k] == 1 else '+' if doc['sg'][k] == 2 else ''}"
        if pred:
            lab = pred.get(doc["sha"], {}).get(doc["ids"][k]) if "ids" in doc else None
            gold = f"{gold:12} {(R[lab[0]] + ('*' if lab[1] == 1 else '+' if lab[1] == 2 else '')) if lab else '?':12}"
        print(f"  {parser:12} {gold:12} {v[F['x0']]:5.2f} {v[F['x1']]:5.2f} {v[F['width']]:5.2f} {v[F['centre']]:+6.2f} {v[F['gap_above']]:5.1f} {v[F['gap_below']]:5.1f} {v[F['bold']]:4.1f} {v[F['size']]:5.2f} {v[F['upper']]:4.1f} {doc['look'][k]:5}  {doc['text'][k][:70]}")
if png:
    import fitz
    path = os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", "corpus", "corpus.sqlite")
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    row = db.execute("select path from files where sha256 = ?", (doc["sha"],)).fetchone()
    if not row:
        print("no catalogue path for", doc["sha"])
        sys.exit()
    pdf_path = row[0]
    if not os.path.isabs(pdf_path):
        pdf_path = os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", pdf_path)
    print("pdf:", pdf_path)
    pdf = fitz.open(pdf_path)
    os.makedirs(png, exist_ok=True)
    for page in pages:
        out = os.path.join(png, f"{prefix}-p{page}.png")
        pdf[page - 1].get_pixmap(dpi=80).save(out)
        print("wrote", out)
