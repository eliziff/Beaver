"""Write preds_<tag>.json from saved out-of-fold scores, for score.py exhibits.

Usage: python export.py <oof tag>
"""
import json, os, sys
import numpy as np
from common import HERE, load, to_preds

tag = sys.argv[1]
S = np.load(os.path.join(HERE, f"oof_{tag}.npz"))
recs = load()
preds = to_preds(recs, {k: S[k] for k in S.files})
path = os.path.join(HERE, f"preds_{tag}.json")
json.dump(preds, open(path, "w", encoding="utf-8"), indent=0)
print(path)
