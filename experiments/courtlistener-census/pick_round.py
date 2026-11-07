"""Pick a reading round from the kept opinions: up to N per court, not already read, and pack them.

    python -I pick_round.py KEPT_DIR OUT_TAR N [ALREADY_READ_IDS_FILE]
    python -I pick_round.py KEPT_DIR OUT_PREFIX years [ALREADY_READ_IDS_FILE]   (writes OUT_PREFIX.json, a queue)

Within a court, opinions from rendition combinations and decades not yet picked come first, so a court's
first reads spread over its different sources and eras; ties go by a hash of the id (deterministic, not
file order). The chosen folders are packed into OUT_TAR (one folder per opinion), with OUT_TAR.json listing them.
"""
import hashlib
import json
import os
import sys
import tarfile
from collections import defaultdict

kept, out, n = sys.argv[1], sys.argv[2], sys.argv[3]
already = set(open(sys.argv[4], encoding="utf-8").read().split()) if len(sys.argv) > 4 and os.path.exists(sys.argv[4]) else set()
by_court = defaultdict(list)
index = os.path.join(os.path.dirname(os.path.abspath(kept)), "kept.tsv")  # cell_stream.py's id <tab> cell lines
if os.path.exists(index):
    cells = [l.rstrip("\n").split("\t") for l in open(index, encoding="utf-8") if l.count("\t") == 1]
else:
    cells = []
    for oid in os.listdir(kept):
        try:
            cells.append((oid, json.load(open(os.path.join(kept, oid, "fields.json"), encoding="utf-8"))["_cell"]))
        except (OSError, ValueError, KeyError):
            continue
for oid, cell in cells:
    if cell.count("|") != 3:
        continue
    court, year, source, rends = cell.split("|")
    by_court[court].append((oid, year, source, rends))

def bisect_order(years):
    """Ranks of sorted years read from opposite ends inwards: the first and last, then the middle, then the quarter
    points, and so on, so any prefix of the order spreads over the court's whole span."""
    if len(years) <= 2:
        return {y: i for i, y in enumerate(years)}
    rank, queue = {years[0]: 0, years[-1]: 1}, [(0, len(years) - 1)]
    while queue:
        lo, hi = queue.pop(0)
        mid = (lo + hi) // 2
        if lo < mid < hi:
            rank[years[mid]] = len(rank)
            queue += [(lo, mid), (mid, hi)]
    return rank


chosen = []
if sys.argv[3] == "years":
    # One opinion for every court-year not yet read, in bisection order within each court; every court's k-th
    # year comes before any court's (k+1)-th. Written as OUT_PREFIX.json, the folders in that order (a queue for
    # codex_read.py on the same machine).
    covered = {(c, r[1]) for c, rows in by_court.items() for r in rows if r[0] in already}
    picks = []
    for court, rows in by_court.items():
        by_year = {}
        for r in sorted(rows, key=lambda r: hashlib.sha1(r[0].encode()).hexdigest()):
            by_year.setdefault(r[1], r)
        rank = bisect_order(sorted(by_year, key=lambda y: (not y.isdigit(), int(y) if y.isdigit() else 0)))
        tie = hashlib.sha1(court.encode()).hexdigest()
        picks += [(rank[y], tie, r[0]) for y, r in by_year.items() if (court, y) not in covered]
    chosen = [p[2] for p in sorted(picks)]
    json.dump([os.path.join(os.path.abspath(kept), oid) for oid in chosen], open(f"{out}.json", "w"))
    print(json.dumps({"courts": len(by_court), "court_years": sum(len({r[1] for r in rows}) for rows in by_court.values()), "chosen": len(chosen)}))
    sys.exit()
n = int(n)
for court, rows in by_court.items():
    rows = [r for r in rows if r[0] not in already]
    rows.sort(key=lambda r: hashlib.sha1(r[0].encode()).hexdigest())
    seen_r, seen_d, picks = set(), set(), []
    while rows and len(picks) < n:
        rows.sort(key=lambda r: ((r[3] in seen_r) + (r[1][:3] in seen_d), hashlib.sha1(r[0].encode()).hexdigest()))
        r = rows.pop(0); picks.append(r[0]); seen_r.add(r[3]); seen_d.add(r[1][:3])
    chosen += picks
with tarfile.open(out, "w") as t:
    for oid in chosen:
        t.add(os.path.join(kept, oid), arcname=oid)
json.dump(chosen, open(out + ".json", "w"))
print(json.dumps({"courts": len(by_court), "chosen": len(chosen)}))
