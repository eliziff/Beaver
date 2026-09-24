"""Joint decoding with a pairwise label-order prior: exhibits are usually lettered in the order
their documents were made. Maximise  sum_i s[i, a(i)] + lam * sum_{i<i'} sign(date(a(i')) - date(a(i)))
over dated files (labels in label order), by pairwise-swap local search from the Hungarian
assignment. lam is chosen on the other folds (nested), so the reported number is out of fold.

Usage: python decode.py <oof tag> [--lams 0,0.05,...]
"""
import json, os, sys
import numpy as np
from common import HERE, load, folds, truth, assign
import fields as F
from feats2 import lab_key, chargram_pair

args = sys.argv[1:]
THR = float(args[args.index("--thr") + 1]) if "--thr" in args else -1.0
tag = args[0]
LAMS = [float(x) for x in (args[args.index("--lams") + 1] if "--lams" in args else "0,0.02,0.05,0.1,0.2,0.3,0.5,0.8").split(",")]


def file_dates(texts):
    out = []
    for t in texts:
        d = [v for _, v in F.dates(t[:1500]) if len(v) == 10]
        out.append(d[0] if d else None)
    return out


def search(s, rank, dates, lam, W, iters=6):
    L, N = s.shape
    a = assign(s)
    cur = np.array([a[i] for i in range(L)])
    if lam == 0:
        return cur
    dnum = np.array([np.nan if d is None else int(d.replace("-", "")) for d in dates], float)
    ordl = np.argsort(rank)  # labels in label order

    def pair_term(cur):
        f = cur[ordl]
        d = dnum[f]
        ok = ~np.isnan(d)
        d, f = d[ok], f[ok]
        if len(d) < 2:
            return 0.0
        diff = np.sign(d[None, :] - d[:, None]) * W[np.ix_(f, f)]
        return np.triu(diff, 1).sum()

    def total(cur):
        return s[np.arange(L), cur].sum() + lam * pair_term(cur)

    best = total(cur)
    free = [j for j in range(N) if j not in set(cur)]
    for _ in range(iters):
        improved = False
        for i in range(L):
            for k in range(i + 1, L):
                cur[i], cur[k] = cur[k], cur[i]
                v = total(cur)
                if v > best + 1e-9:
                    best = v; improved = True
                else:
                    cur[i], cur[k] = cur[k], cur[i]
        if not improved:
            break
    return cur


def main():
    recs = load()
    S = np.load(os.path.join(HERE, f"oof_{tag}.npz"))
    fo = folds(recs)
    res = {}  # lam -> record -> (ok, n)
    for r in recs:
        s = S[r["record"]]
        rank = np.array([sorted(r["labels"], key=lab_key).index(l) for l in r["labels"]])
        dates = file_dates(r["texts"])
        cg = chargram_pair([t[:1500] for t in r["texts"]], [t[:1500] for t in r["texts"]])
        W = (cg > THR).astype(float)
        t = truth(r)
        for lam in LAMS:
            cur = search(s, rank, dates, lam, W)
            res.setdefault(lam, {})[r["record"]] = (int(t[np.arange(len(cur)), cur].sum()), len(r["files"]))
    for lam in LAMS:
        ok = sum(v[0] for v in res[lam].values()); n = sum(v[1] for v in res[lam].values())
        print(f"lam {lam:<5} acc {ok / n:.3f}")
    ok = n = 0
    for k in sorted(set(fo.values())):
        tr = [r["record"] for r in recs if fo[r["record"]] != k]
        te = [r["record"] for r in recs if fo[r["record"]] == k]
        lam = max(LAMS, key=lambda l: sum(res[l][x][0] for x in tr))
        ok += sum(res[lam][x][0] for x in te); n += sum(res[lam][x][1] for x in te)
        print(f"  fold {k}: lam {lam}")
    print(f"nested acc {ok / n:.3f}")


if __name__ == "__main__":
    main()
