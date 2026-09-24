"""Pair features v5: Model2Vec (potion-8m) cosine between each view of the affidavit text for a
label (owned text before/after the mention, description, paragraph) and the file's opening
and whole text, with row/column ranks.

Usage: python feats5.py -> feats_emb.npz (+ _names.npy)
"""
import json, os
import numpy as np
from common import HERE
import fastmatch as fm
from feats2 import desc_of, rrank

POTION = r"C:\Users\elias\AppData\Local\Temp\claude\C--Users-elias-Desktop-MikeOSS-Fork\1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c\scratchpad\embed-models\potion-8m"


def main():
    pot = fm.Potion(POTION)
    E = lambda ts: np.stack([pot.embed(t or " ") for t in ts])
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    out, names = {}, []
    for r in recs:
        C = r["ctx"]
        refs = {"segb": [C[l]["seg"][0][-600:] for l in r["labels"]], "sega": [C[l]["seg"][1][:400] for l in r["labels"]],
                "desc": [desc_of(C[l]) for l in r["labels"]], "para": [C[l]["paragraph"][:1500] for l in r["labels"]]}
        files = {"head": E([t[:1000] for t in r["texts"]]), "full": E([t[:20000] for t in r["texts"]])}
        blocks, names = [], []
        for rn, rt in refs.items():
            q = E(rt)
            for fn, f in files.items():
                m = q @ f.T
                blocks += [m, rrank(m, 1), rrank(m, 0)]
                names += [f"{rn}_{fn}", f"{rn}_{fn}_rrow", f"{rn}_{fn}_rcol"]
        out[r["record"]] = np.stack(blocks, axis=2).astype(np.float32)
    np.savez_compressed(os.path.join(HERE, "feats_emb.npz"), **out)
    np.save(os.path.join(HERE, "feats_emb_names.npy"), np.array(names))
    print(len(names), "feats")


if __name__ == "__main__":
    main()
