"""One document's gold heading starts with the parser's reading, their evidence and the line
before and after each; the first N.

  python heads.py ROWS_DIR SHA_PREFIX N
"""
import sys

import lab
from lab import R, RI

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root, prefix, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
doc = [d for split in ("development", "train") for d in lab.load(root, split) if d["sha"].startswith(prefix)][0]
F = {name: k for k, name in enumerate(lab.NAMES)}
shown = 0
for k in range(len(doc["text"])):
    if not (doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1):
        continue
    v = doc["X"][k]
    parser = f"{R[doc['r0'][k]]}{'*' if doc['s0'][k] == 1 else ''}"
    print(f"p{doc['pages'][k] + 1:<4} {parser:12} x0 {v[F['x0']]:.2f} x1 {v[F['x1']]:.2f} ctr {v[F['centre']]:+.2f} gap {v[F['gap_above']]:+.1f}/{v[F['gap_below']]:+.1f} bold {v[F['bold']]:.1f} size {v[F['size']]:.2f} up {v[F['upper']]:.1f} look {doc['look'][k]:3} trail {doc['trail'][k] or '-':14} | {doc['text'][k][:60]!r}")
    for j in (k - 1, k + 1):
        if 0 <= j < len(doc["text"]) and doc["pages"][j] == doc["pages"][k]:
            print(f"      {'before' if j < k else 'after':6} {R[doc['r0'][j]]:10} -> {R[doc['rg'][j]] if doc['rg'][j] >= 0 else '?':10} {doc['text'][j][:60]!r}")
    shown += 1
    if shown >= limit:
        break
