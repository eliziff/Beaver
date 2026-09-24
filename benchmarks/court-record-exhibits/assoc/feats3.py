"""Pair features v3: the text each exhibit mention owns (between the neighbouring exhibit
mentions, before and after it), and field agreement weighted by rarity within the record
(Fellegi-Sunter u-probabilities: agreeing on a date only one file carries says more than
agreeing on a date every file carries).

Usage: python feats3.py -> feats_seg.npz (+ _names.npy)
"""
import json, math, os, re, time
import numpy as np
from common import HERE
import fields as F
from feats2 import tfidf_pair, chargram_pair, rrank

VIEWS = ("b", "a")  # segment before the mention, segment after it


def value_sets(texts):
    """Per file: field -> set of values, from the head (first 1500 chars) and the whole text."""
    out = []
    for t in texts:
        h = t[:1500]
        dh, da = F.dates(h), F.dates(t)
        out.append({"dayH": F.dayset(dh), "dayA": F.dayset(da), "mon": F.monthset(dh), "amt": F.amounts(t), "id": F.idents(t),
                    "nameH": F.names(h), "nameA": F.names(t), "num": set(re.findall(r"\b\d{2,}(?:/\d{2,4})?\b", h))})
    return out


def rarity(sets, key):
    n = len(sets)
    cnt = {}
    for s in sets:
        for v in s[key]:
            cnt[v] = cnt.get(v, 0) + 1
    return {v: math.log((n + 1) / c) for v, c in cnt.items()}


def ref_values(t):
    d = F.dates(t)
    return {"day": F.dayset(d), "mon": F.monthset(d), "amt": F.amounts(t), "id": F.idents(t), "name": F.names(t),
            "num": set(re.findall(r"\b\d{2,}(?:/\d{2,4})?\b", re.sub(r"\b(?:19|20)\d\d\b", " ", t)))}


PAIRS = [("day", "dayH"), ("day", "dayA"), ("mon", "mon"), ("amt", "amt"), ("id", "id"), ("name", "nameH"), ("name", "nameA"), ("num", "num")]


def record_feats(r):
    labels, texts = r["labels"], r["texts"]
    C = r["ctx"]
    L, N = len(labels), len(texts)
    fs = value_sets(texts)
    rar = {fk: rarity(fs, fk) for _, fk in PAIRS}
    names, blocks = [], []
    head = [t[:2000] for t in texts]
    for vi, view in enumerate(VIEWS):
        segs = [C[l]["seg"][vi] if C[l]["seg"] else "" for l in labels]
        for nm, m in (("tf_head", tfidf_pair([s or " " for s in segs], head)), ("tf_full", tfidf_pair([s or " " for s in segs], texts)),
                      ("cg_head", chargram_pair([s or " " for s in segs], [t[:1000] for t in texts]))):
            blocks += [m, rrank(m, 1), rrank(m, 0)]
            names += [f"{view}_{nm}", f"{view}_{nm}_rrow", f"{view}_{nm}_rcol"]
        rv = [ref_values(s) for s in segs]
        for rk, fk in PAIRS:
            M = np.zeros((L, N), np.float32); A = np.zeros((L, N), np.float32)
            for i in range(L):
                for j in range(N):
                    common = rv[i][rk] & fs[j][fk]
                    if common:
                        w = [rar[fk][v] for v in common]
                        M[i, j] = max(w); A[i, j] = 1.0
            # exclusive: the label's value is matched by this file and by no other file
            blocks += [M, A, rrank(M + 1e-3 * A, 0) * A]
            names += [f"{view}_{rk}_{fk}_rare", f"{view}_{rk}_{fk}_any", f"{view}_{rk}_{fk}_rcol"]
    X = np.stack(blocks, axis=2).astype(np.float32)
    return X, names


def main():
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    out, secs = {}, []
    for r in recs:
        t0 = time.time()
        out[r["record"]], names = record_feats(r)
        secs.append(time.time() - t0)
    np.savez_compressed(os.path.join(HERE, "feats_seg.npz"), **out)
    np.save(os.path.join(HERE, "feats_seg_names.npy"), np.array(names))
    s = np.array(secs)
    print(f"{len(recs)} records, {len(names)} feats: median {np.median(s):.2f}s max {s.max():.1f}s")


if __name__ == "__main__":
    main()
