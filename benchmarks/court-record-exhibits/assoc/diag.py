"""Diagnostics for saved out-of-fold scores: top-k shortlist recall and an error dump.

Usage: python diag.py <oof tag> [--errors N] [--seed S]
"""
import json, os, re, sys, random
import numpy as np
from common import HERE, load, truth, assign

args = sys.argv[1:]
tag = args[0]
N = int(args[args.index("--errors") + 1]) if "--errors" in args else 0
recs = {r["record"]: r for r in json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))}
S = np.load(os.path.join(HERE, f"oof_{tag}.npz"))
ks = [1, 3, 5, 10]
hit = {k: 0 for k in ks}; hitf = {k: 0 for k in ks}; n = 0
errs = []
for rid in S.files:
    r, s = recs[rid], S[rid]
    t = truth(r)
    rank_l = (-s).argsort(1).argsort(1)[np.arange(len(t)), t.argmax(1)]  # rank of true file for each label
    rank_f = (-s).argsort(0).argsort(0)[t.argmax(0), np.arange(len(t))]  # rank of true label for each file
    for k in ks:
        hit[k] += int((rank_l < k).sum()); hitf[k] += int((rank_f < k).sum())
    n += len(t)
    a = assign(s)
    for i, j in a.items():
        if not t[i, j]:
            errs.append((rid, r["labels"][i], j, int(t[i].argmax()), int(rank_l[i]), len(t)))
print(f"{tag}: {n} labels; label->file recall@k " + " ".join(f"@{k} {hit[k] / n:.3f}" for k in ks))
print(f"{' ' * len(tag)}  file->label recall@k " + " ".join(f"@{k} {hitf[k] / n:.3f}" for k in ks))
by = {}
for e in errs:
    by[e[0]] = by.get(e[0], 0) + 1
print("errors", len(errs), "by record (top):", sorted(by.items(), key=lambda t: -t[1])[:12])
clip = lambda t, m=220: re.sub(r"\s+", " ", t)[:m].encode("ascii", "replace").decode()
random.Random(int(args[args.index("--seed") + 1]) if "--seed" in args else 0).shuffle(errs)
for rid, l, j, jt, rk, L in errs[:N]:
    r = recs[rid]; c = r["ctx"][l]
    print(f"\n[{rid} L={L}] {l} (true file rank {rk}) group={c['group_size']} found={c['found']}")
    print("  MAIN :", clip(c["main"], 300))
    print("  SEGB :", clip(c["seg"][0][-250:], 250)); print("  SEGA :", clip(c["seg"][1], 200))
    if c["item"]:
        print("  ITEM :", clip(c["item"]))
    print("  PREV :", clip(c["prev"][-200:], 200))
    print("  PICK :", clip(r["texts"][j]) or "(no text)")
    print("  TRUE :", clip(r["texts"][jt]) or "(no text)")
