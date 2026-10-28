"""Samples of body pieces that open a gold unit but continue the parser's (merged), on one mode, with
the line before and the cues between them; and the reverse (split).

  python merged.py ROWS_DIR mode N
"""
import random
import sys

import lab
from lab import RI

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root, mode, n_show = sys.argv[1], sys.argv[2], int(sys.argv[3])
docs = [d for d in lab.load(root, "development") if d["mode"] == mode]
F = {name: k for k, name in enumerate(lab.NAMES)}
BODY = {RI["text"], RI["provision"], RI["list_item"]}
merged, split = [], []
for doc in docs:
    X, text, n = doc["X"], doc["text"], len(doc["text"])
    r0, s0, rg, sg, pages = doc["r0"], doc["s0"], doc["rg"], doc["sg"], doc["pages"]
    for k in range(1, n):
        if rg[k] not in BODY or rg[k - 1] not in BODY or pages[k] != pages[k - 1] or r0[k] not in BODY or r0[k - 1] not in BODY:
            continue
        g, p = sg[k] == 1, s0[k] == 1
        c = lambda name, j: X[j, F[name]]
        row = (doc["sha"][:8], pages[k] + 1,
               f"gap{c('gap_above', k):+.2f} ind{c('indent', k):+.3f} dx0{c('x0', k) - c('x0', k - 1):+.3f} prevw{c('width', k - 1):.2f} w{c('width', k):.2f} prev.{int(c('ends_period', k - 1))} up{int(c('starts_upper', k))}",
               text[k - 1][-60:], text[k][:60])
        if g and not p:
            merged.append(row)
        elif p and not g:
            split.append(row)
random.seed(5)
for name, items in (("MERGED (gold opens, parser continues)", merged), ("SPLIT (parser opens, gold continues)", split)):
    print(f"\n{name}: {len(items)}")
    for sha, page, cues, prev, cur in random.sample(items, min(n_show, len(items))):
        print(f"  {sha} p{page:<3} {cues}\n      ...{prev!r}\n      {cur!r}")
