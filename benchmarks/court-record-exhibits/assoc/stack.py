"""Second-stage features from first-stage out-of-fold scores: each pair's standing in its row
and column (softmax, margin to the best rival, rank, Hungarian pick), so the second listwise
fit can learn how much to trust a close call.

Usage: python stack.py <oof tag>  -> feats_stack.npz; then models.py <sets>,stack
"""
import os, sys
import numpy as np
from common import HERE, assign

tag = sys.argv[1]
S = np.load(os.path.join(HERE, f"oof_{tag}.npz"))
out = {}
for k in S.files:
    s = S[k]
    pr = np.exp(s - s.max(1, keepdims=True)); pr /= pr.sum(1, keepdims=True)
    pc = np.exp(s - s.max(0, keepdims=True)); pc /= pc.sum(0, keepdims=True)
    r1 = np.sort(s, 1)[:, ::-1]; c1 = np.sort(s, 0)[::-1]
    best_r = np.where(s >= r1[:, :1], r1[:, 1:2] if s.shape[1] > 1 else r1[:, :1], r1[:, :1])
    best_c = np.where(s >= c1[:1], c1[1:2] if s.shape[0] > 1 else c1[:1], c1[:1])
    a = assign(s)
    H = np.zeros_like(s)
    for i, j in a.items():
        H[i, j] = 1
    rr = (-s).argsort(1).argsort(1); rc = (-s).argsort(0).argsort(0)
    out[k] = np.stack([s, pr, pc, s - best_r, s - best_c, 1 / (1 + rr), 1 / (1 + rc), H], axis=2).astype(np.float32)
np.savez_compressed(os.path.join(HERE, "feats_stack.npz"), **out)
np.save(os.path.join(HERE, "feats_stack_names.npy"), np.array(["s", "p_row", "p_col", "margin_row", "margin_col", "rr_row", "rr_col", "hung"]))
print("ok")
