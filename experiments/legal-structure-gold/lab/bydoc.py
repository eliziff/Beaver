"""Development documents of one gold type: tier 0's heading and body unit F1 per document, with the
document's heading count, so the worst and the typical can be read page by page.

  python bydoc.py ROWS_DIR GOLD_TYPES type [mode]
"""
import collections
import json
import sys

import lab

root, types_path, kind = sys.argv[1], sys.argv[2], sys.argv[3]
mode = sys.argv[4] if len(sys.argv) > 4 else None
types = json.load(open(types_path, encoding="utf-8"))
def doc_type(d):
    by = collections.Counter()
    for t, _, lines in types.get(d["sha"], []):
        by[t] += lines
    return by.most_common(1)[0][0] if by else "other"
docs = [d for d in lab.load(root, "development") if doc_type(d) == kind and (mode is None or d["mode"] == mode)]
print(f"{len(docs)} {kind} documents" + (f" ({mode})" if mode else ""))
rows = []
for d in docs:
    t = lab.score([d], lab.tier0, kinds=("heading", "body"))
    h, b = t[("heading", "all")], t[("body", "all")]
    rows.append((d["sha"][:8], d["mode"], len(d["pages"]), h[0], lab.f1(h)[0], b[0], lab.f1(b)[0]))
rows.sort(key=lambda r: -r[3])
print(f"  {'sha':8} {'mode':12} {'pieces':>6} {'heads':>6} {'head F1':>8} {'body':>6} {'body F1':>8}")
for sha, m, n, heads, hf, body, bf in rows:
    print(f"  {sha} {m:12} {n:6} {heads:6} {hf:8.2f} {body:6} {bf:8.2f}")
