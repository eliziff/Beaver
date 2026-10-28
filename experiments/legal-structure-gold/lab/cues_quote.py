"""Quotation cues in the lab: among body pieces of judgments, submissions and articles (the types
whose gold reads quotes), how each cue separates gold quote pieces from text, and what share of
gold quote pieces each cue holds; then the same for the piece that opens a quote unit.

  python cues_quote.py ROWS_DIR GOLD_TYPES
"""
import collections
import json
import re
import sys

import numpy as np

import lab
from lab import RI
from styles import columns

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root, types_path = sys.argv[1], sys.argv[2]
types = json.load(open(types_path, encoding="utf-8"))
F = {name: k for k, name in enumerate(lab.NAMES)}


def doc_type(d):
    by = collections.Counter()
    for kind, _, lines in types.get(d["sha"], []):
        by[kind] += lines
    return by.most_common(1)[0][0] if by else "other"


OPEN = re.compile(r'^\s*[\[(]?\d{0,4}[.)\]]?\s*["“‘«]')
docs = [d for d in lab.load(root, "train") if doc_type(d) in ("judgment", "submission", "article")]
BODY = {RI["text"], RI["quote"], RI["list_item"], RI["provision"]}
items = []
for doc in docs:
    X, n, text = doc["X"], len(doc["text"]), doc["text"]
    if n == 0:
        continue
    cols = columns(doc)
    x0, x1 = X[:, F["x0"]], X[:, F["x1"]]
    for k in range(n):
        if doc["rg"][k] not in BODY or doc["r0"][k] not in BODY:
            continue
        i, left, right, count = cols[k]
        width = max(right - left, 0.05)
        indent = (x0[k] - left) / width
        right_gap = (right - x1[k]) / width
        rel = (x1[k] - x0[k]) / width
        prev = text[k - 1].rstrip() if k > 0 and doc["pages"][k - 1] == doc["pages"][k] else ""
        quote = doc["rg"][k] == RI["quote"]
        opens = quote and doc["sg"][k] == 1
        cues = {
            "indent>0.03": indent > 0.03, "indent>0.06": indent > 0.06, "indent>0.1": indent > 0.1,
            "both_in>0.03": indent > 0.03 and right_gap > 0.03, "both_in>0.06": indent > 0.06 and right_gap > 0.06,
            "size<0.95": 0 < X[k, F["size"]] < 0.95, "italic": X[k, F["italic"]] > 0.5,
            "opens_mark": OPEN.match(text[k]) is not None, "prev_ends_colon": prev.endswith(":"),
            "indent>0.03&prev_colon": indent > 0.03 and prev.endswith(":"),
            "indent>0.03&(colon|mark|small)": indent > 0.03 and (prev.endswith(":") or OPEN.match(text[k]) is not None or 0 < X[k, F["size"]] < 0.95),
            "parser_quote": doc["r0"][k] == RI["quote"], "parser_list": doc["r0"][k] == RI["list_item"],
            "starts_digit": X[k, F["starts_digit"]] > 0, "ocr": X[k, F["ocr"]] > 0,
        }
        items.append((quote, opens, cues))
total = len(items)
quotes = sum(q for q, _, _ in items)
opens_n = sum(o for _, o, _ in items)
print(f"{len(docs)} train judgments/submissions/articles: {total} body pieces, {quotes} gold quote pieces ({quotes / total:.2f}), {opens_n} quote unit starts")
print(f"  {'cue':34} {'n':>7} {'P(quote|cue)':>13} {'share of quotes':>16} {'P(open|cue)':>12} {'share of opens':>15}")
for cue in items[0][2]:
    w = [(q, o) for q, o, c in items if c[cue]]
    print(f"  {cue:34} {len(w):7} {sum(q for q, _ in w) / max(len(w), 1):13.2f} {sum(q for q, _ in w) / max(quotes, 1):16.2f} {sum(o for _, o in w) / max(len(w), 1):12.2f} {sum(o for _, o in w) / max(opens_n, 1):15.2f}")
