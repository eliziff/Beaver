"""List-group mentions: which labels share a mention without an item of their own, and how many
of the wrong low-confidence v4 picks those are.

Usage: python listdiag.py [inputs json] [--show N]   (default inputs2.json; --show prints N groups)
"""
import json, os, re, sys
import numpy as np
from common import HERE, assign

args = sys.argv[1:]
path = os.path.join(HERE, args[0] if args and not args[0].startswith("--") else "inputs2.json")
show = int(args[args.index("--show") + 1]) if "--show" in args else 0
recs = json.load(open(path, encoding="utf-8"))
B = np.load(os.path.join(HERE, "oof_v4.npz"))
ws = lambda t: re.sub(r"\s+", " ", t or "").strip()
ft = lambda t: ws(re.sub(r"\[page \d+\]", " ", t or ""))[:2500]

grp_labels = noitem = 0
low = wrong = wgrp = 0
bad = []
for r in recs:
    C = r["ctx"]
    for l in r["labels"]:
        if C[l]["group_size"] > 1:
            grp_labels += 1
            noitem += not C[l]["item"]
    s = B[r["record"]]
    e = np.exp(s - s.max(1, keepdims=True)); rp = e / e.sum(1, keepdims=True)
    e = np.exp(s - s.max(0, keepdims=True)); cp = e / e.sum(0, keepdims=True)
    lab = {f: l for f, l in r["truth"].items()}
    for i, j in assign(s).items():
        if min(rp[i, j], cp[i, j]) >= 0.5:
            continue
        low += 1
        g = lab.get(r["files"][j])
        if g not in C or g == r["labels"][i]:
            continue
        wrong += 1
        c = C[g]
        if c["group_size"] > 1 and not c["item"]:
            wgrp += 1
            bad.append((r["record"], g, r["labels"][i], c["main"], ft(r["texts"][j])[:200]))
print(f"{path}: labels in list groups {grp_labels}, without an item {noitem}")
print(f"low-conf picks {low}, wrong {wrong}, wrong with gold in an itemless group {wgrp}")
seen = set()
for rid, g, p, m, h in bad:
    if show <= 0:
        break
    if (rid, m) in seen:
        print(f"   also {g} (picked {p}): {h[:140]}")
        continue
    seen.add((rid, m)); show -= 1
    print(f"\n[{rid}] gold {g} picked {p}\n  MENTION: {m[:600]}\n  FILE: {h[:140]}")
