"""Count the low-confidence v4 picks no pair reader can fix: gold mention in a list group with no item of its own, or an identical-text twin file."""
import sys, json, os
H = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, H)
sys.argv = ["x", "m", "t"]
import numpy as np, xenc
from common import assign
recs = json.load(open(os.path.join(H, "inputs2.json"), encoding="utf-8"))
B = np.load(os.path.join(H, "oof_" + os.environ.get("BASE", "v4") + ".npz"))
n = grp = twin = either = wrong = wgrp = wtwin = 0
for r in recs:
    s = B[r["record"]]; L, N = s.shape; k = min(5, L, N)
    T = np.array([[r["truth"][f] == l for f in r["files"]] for l in r["labels"]])
    e = np.exp(s - s.max(1, keepdims=True)); rp = e / e.sum(1, keepdims=True)
    e = np.exp(s - s.max(0, keepdims=True)); cp = e / e.sum(0, keepdims=True)
    ft = [xenc.file_text(t) for t in r["texts"]]
    for i, j in assign(s).items():
        if min(rp[i, j], cp[i, j]) >= 0.5: continue
        n += 1
        if not T[:, j].any(): continue
        g = int(T[:, j].argmax()); c = r["ctx"][r["labels"][g]]
        a = c["group_size"] > 1 and not c["item"]
        cand = np.argsort(-s[g])[:k]
        b = any(ft[x] == ft[j] and x != j for x in cand) or any(ft[x] == ft[j] for x in range(N) if x != j)
        grp += a; twin += b; either += a or b
        if not T[i, j]:
            wrong += 1; wgrp += a; wtwin += b
print(f"low-conf files {n}: gold mention in a list group without its own item {grp}; identical-text twin file {twin}; either {either}")
print(f"  of the {wrong} wrong low-conf picks: group {wgrp}, twin {wtwin}")
