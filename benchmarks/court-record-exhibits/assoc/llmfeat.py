"""Turn llm_<tag>.npz (labels x files x [l2f, f2l] shortlist log-probs) into a feature set
feats_<tag>.npz for models.py: log-probs, probabilities, and in-shortlist flags.

Usage: python llmfeat.py <tag>
"""
import os, sys
import numpy as np
from common import HERE

tag = sys.argv[1]
z = np.load(os.path.join(HERE, f"llm_{tag}.npz"))
out = {}
for k in z.files:
    x = z[k]
    inl = (x > -11.99).astype(np.float32)
    lp = np.where(inl > 0, x, -8.0)
    out[k] = np.concatenate([lp, np.exp(lp) * inl, inl, (lp[:, :, :1] + lp[:, :, 1:])], axis=2).astype(np.float32)
np.savez_compressed(os.path.join(HERE, f"feats_{tag}.npz"), **out)
np.save(os.path.join(HERE, f"feats_{tag}_names.npy"), np.array(["l2f_lp", "f2l_lp", "l2f_p", "f2l_p", "l2f_in", "f2l_in", "lp_sum"]))
print(f"feats_{tag}.npz: {len(out)} records")
