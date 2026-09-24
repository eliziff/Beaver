"""Per-record CPU time of the v4 feature pipeline (fastmatch signals + feats2 + feats3 + kinds
inference + listwise score + Hungarian) and model sizes."""
import json, os, time
import numpy as np
from common import HERE, load, assign
import fastmatch as fm
import feats2, feats3, kinds
from feats2 import desc_of

POTION = r"C:\Users\elias\AppData\Local\Temp\claude\C--Users-elias-Desktop-MikeOSS-Fork\1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c\scratchpad\embed-models\potion-8m"
recs = load()
recs2 = {r["record"]: r for r in json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))}
t0 = time.time(); potion = fm.Potion(POTION); tload = time.time() - t0
W = np.random.randn(kinds.D, 17).astype(np.float32)  # stand-in weights: same shape and cost as the trained classifiers
w = np.random.randn(154).astype(np.float32)
secs = []
for r in recs:
    r2 = recs2[r["record"]]
    pc = feats2.page_counts(r["record"], r["files"])
    t0 = time.time()
    a = fm.pair_features(r, potion)
    S, Fx, O, *_ = feats2.record_feats(r2, pc)
    X3, _ = feats3.record_feats(r2)
    pf = kinds.matrix([t[:1500] for t in r2["texts"]]) @ W
    pr = kinds.matrix([desc_of(r2["ctx"][l]) + " " + " ".join(r2["ctx"][l]["seg"])[-600:] for l in r2["labels"]]) @ W
    X = np.concatenate([a, S, Fx, O, X3, np.zeros(S.shape[:2] + (3,), np.float32)], axis=2)
    assign(X @ w)
    secs.append(time.time() - t0)
s = np.array(secs)
size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(POTION) for f in fs)
print(f"potion-8m on disk {size / 1e6:.1f} MB, load {tload:.2f}s; kind classifiers 2 x {W.nbytes / 1e6:.1f} MB fp32; "
      f"per record median {np.median(s):.2f}s mean {s.mean():.2f}s p90 {np.percentile(s, 90):.2f}s max {s.max():.1f}s (Python, 1 core)")
