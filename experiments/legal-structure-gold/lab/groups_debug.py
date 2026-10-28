"""One document's style groups as styles_decide reads them: key, size, gold heading share, the
group evidence and the decision, with member samples and their gold regions.

  python groups_debug.py ROWS_DIR GOLD_TYPES SHA_PREFIX [min_members]
"""
import collections
import sys

import lab
from lab import R, RI
import styles_decide as sd

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root, prefix = sys.argv[1], sys.argv[3]
least = int(sys.argv[4]) if len(sys.argv) > 4 else 2
doc = [d for split in ("development", "train") for d in lab.load(root, split) if d["sha"].startswith(prefix)][0]
ev = sd.evidence(doc)
why = []
region, start = sd.decide(doc, why)
groups = collections.defaultdict(list)
for k in range(len(ev)):
    if ev[k]["candidate"]:
        groups[ev[k]["key"]].append(k)
print(doc["sha"][:8], sd.doc_type(doc), doc["mode"], len(ev), "pieces,", len(groups), "groups")
rows = []
for key, members in groups.items():
    m = len(members)
    if m < least:
        continue
    share = lambda name: sum(bool(ev[k][name]) for k in members) / m
    heads = sum(doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1 for k in members)
    decided = sum(region[k] == RI["heading"] and start[k] == 1 for k in members)
    rows.append((m, heads, decided, key, share("apart_above"), share("apart_below"), share("governs"), share("label"), share("bold"), share("larger"), members))
rows.sort(key=lambda r: -r[1] * 1000 - r[0])
print(f"  {'n':>4} {'gold':>4} {'mine':>4}  {'key (look,col,place,case,alone,family)':46} {'apartA':>6} {'apartB':>6} {'govern':>6} {'label':>5} {'bold':>4} {'large':>5}")
for m, heads, decided, key, aa, ab, gv, lb, bd, lg, members in rows[:40]:
    print(f"  {m:4} {heads:4} {decided:4}  {str(key):46} {aa:6.2f} {ab:6.2f} {gv:6.2f} {lb:5.2f} {bd:4.1f} {lg:5.1f}")
    shown = 0
    for k in members:
        g = R[doc["rg"][k]]
        p = "H" if region[k] == RI["heading"] and start[k] == 1 else "-"
        mark = "*" if doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1 else " "
        print(f"        {mark}{p} p{doc['pages'][k] + 1:<4} {g:13} gov{int(ev[k]['governs'])} up{int(ev[k]['apart_above'])} dn{int(ev[k]['apart_below'])} | {doc['text'][k][:60]!r}")
        shown += 1
        if shown >= 5:
            break
