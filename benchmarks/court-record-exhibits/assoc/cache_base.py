"""Cache fastmatch's cheap pair signals per record (potion-8m for the Model2Vec signal)."""
import os, sys, time
import numpy as np
from common import HERE, load
import fastmatch as fm

recs = load()
potion = fm.Potion(r"C:\Users\elias\AppData\Local\Temp\claude\C--Users-elias-Desktop-MikeOSS-Fork\1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c\scratchpad\embed-models\potion-8m")
out, secs = {}, {}
for r in recs:
    t0 = time.time()
    out[r["record"]] = fm.pair_features(r, potion)
    secs[r["record"]] = time.time() - t0
np.savez_compressed(os.path.join(HERE, "feats_base.npz"), **out)
np.save(os.path.join(HERE, "feats_base_names.npy"), np.array(fm.FEATURES))
s = np.array(list(secs.values()))
print(f"{len(recs)} records; signal time median {np.median(s):.2f}s max {s.max():.1f}s total {s.sum():.0f}s (Python, loaded machine)")
