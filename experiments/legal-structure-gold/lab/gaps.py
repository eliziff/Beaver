"""Where the gold is thin: documents and gold units per genre and mode in train and development,
with tier 0's development unit F1 per genre, so the next cohort can be aimed.

  python gaps.py ROWS_DIR DOC_TYPES_JSON
"""
import collections
import json
import sys

import numpy as np

import lab
from lab import RI

root, types_path = sys.argv[1], sys.argv[2]
types = json.load(open(types_path, encoding="utf-8"))
genre = {}
for sha, parts in types.items():
    # The gold's own document types: the type holding most of the source's lines.
    by = collections.Counter()
    for kind, _, lines in parts:
        by[kind] += lines
    genre[sha] = by.most_common(1)[0][0] if by else "unknown"
rows = collections.defaultdict(lambda: {"train": 0, "dev": 0, "heads_train": 0, "heads_dev": 0, "pieces_train": 0})
dev_docs = collections.defaultdict(list)
for split in ("train", "development"):
    for doc in lab.load(root, split):
        key = (genre.get(doc["sha"], "unknown"), doc["mode"])
        r = rows[key]
        heads = int(((doc["rg"] == RI["heading"]) & (doc["sg"] == 1)).sum())
        if split == "train":
            r["train"] += 1; r["heads_train"] += heads; r["pieces_train"] += len(doc["text"])
        else:
            r["dev"] += 1; r["heads_dev"] += heads
            dev_docs[key].append(doc)
print(f"  {'genre':14} {'mode':12} {'train':>6} {'dev':>5} {'pieces':>8} {'heads tr':>9} {'heads dev':>9}   dev tier0 heading / body / quote / note F1")
for key in sorted(rows, key=lambda k: -(rows[k]["train"] + rows[k]["dev"])):
    r = rows[key]
    scores = ""
    if dev_docs[key]:
        t = lab.score(dev_docs[key], lab.tier0)
        scores = "   " + " / ".join(f"{lab.f1(t[(kind, 'all')])[0]:.2f}" for kind in ("heading", "body", "quote", "note"))
    print(f"  {key[0]:14} {key[1]:12} {r['train']:6} {r['dev']:5} {r['pieces_train']:8} {r['heads_train']:9} {r['heads_dev']:9}{scores}")
