"""The DOC reader's per-document stage times (LEGALPDF_TRANSITION_DOC_TIMES lines in a grade's stderr): each stage's
total, the median document's, and the slowest documents with their sizes. python doc_times.py STDERR_FILE"""
import re, sys
rows = []
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    m = re.search(r"doc times: (\d+) lines (\d+) regions (\d+) pairs; embed ([\d.]+)s detect ([\d.]+)s order ([\d.]+)s trees ([\d.]+)s decode ([\d.]+)s", line)
    if m:
        rows.append([int(m[1]), int(m[2]), int(m[3])] + [float(m[k]) for k in range(4, 9)])
names = ["embed", "detect", "order", "trees", "decode"]
print(f"{len(rows)} documents, {sum(r[0] for r in rows)} lines")
for k, name in enumerate(names):
    values = sorted(r[3 + k] for r in rows)
    print(f"  {name:7} total {sum(values):8.1f}s  median {values[len(values) // 2]:.4f}s  worst {values[-1]:.2f}s")
total = sorted(rows, key=lambda r: -sum(r[3:]))
print("slowest:")
for r in total[:6]:
    print(f"  {r[0]:6} lines {r[1]:6} regions {r[2]:9} pairs: " + " ".join(f"{n} {v:.2f}s" for n, v in zip(names, r[3:])))
