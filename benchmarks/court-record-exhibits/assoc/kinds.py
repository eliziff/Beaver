"""Learned document kind on both sides (schema-level record linkage): a multinomial logistic
classifier over hashed words of the file opening, and another over the affidavit's text for
the label, both trained on gold exhibit kinds under the grouped folds. Pair feature: the
probability the two sides name the same kind.

Usage: python kinds.py -> feats_kind.npz (+ _names.npy)
"""
import json, math, os, re, zlib
import numpy as np
import scipy.sparse as sp
from scipy.optimize import minimize
from common import HERE, ROOT
from feats2 import desc_of

MERGE = {"email_chain": "email", "contract": "agreement", "map": "picture", "photograph": "picture", "chart": "picture",
         "text_messages": "other", "spreadsheet": "financial_statement"}
D = 1 << 15


def bag(text):
    w = re.findall(r"[a-z]{2,}|\d+", text.lower())
    toks = w + [a + "_" + b for a, b in zip(w, w[1:])]
    cnt = {}
    for t in toks:
        h = zlib.crc32(t.encode()) & (D - 1)
        cnt[h] = cnt.get(h, 0) + 1
    return cnt


def matrix(texts):
    rows, cols, vals = [], [], []
    for i, t in enumerate(texts):
        b = bag(t)
        n = math.sqrt(sum((1 + math.log(c)) ** 2 for c in b.values())) or 1.0
        for h, c in b.items():
            rows.append(i); cols.append(h); vals.append((1 + math.log(c)) / n)
    return sp.csr_matrix((vals, (rows, cols)), shape=(len(texts), D))


def fit(X, y, K, l2=1e-4):
    Y = np.eye(K)[y]

    def f(w):
        W = w.reshape(D + 1, K)
        s = X @ W[:-1] + W[-1]
        s -= s.max(1, keepdims=True); p = np.exp(s); p /= p.sum(1, keepdims=True)
        loss = -np.log((p * Y).sum(1) + 1e-12).mean() + l2 * (W[:-1] ** 2).sum()
        g = np.vstack([X.T @ (p - Y) / X.shape[0] + 2 * l2 * W[:-1], (p - Y).mean(0)])
        return loss, g.ravel()
    w = minimize(f, np.zeros((D + 1) * K), jac=True, method="L-BFGS-B", options={"maxiter": 300}).x.reshape(D + 1, K)

    def predict(Xt):
        s = Xt @ w[:-1] + w[-1]; s -= s.max(1, keepdims=True); p = np.exp(s)
        return p / p.sum(1, keepdims=True)
    return predict


def main():
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    fo = json.load(open(os.path.join(HERE, "folds.json")))
    kind = {}
    for r in recs:
        g = json.load(open(os.path.join(ROOT, r["record"], "gold.json"), encoding="utf-8"))
        kind[r["record"]] = {e["label"]: MERGE.get(e["kind"], e["kind"]) for e in g["exhibits"]}
    kinds = sorted({k for v in kind.values() for k in v.values()})
    K = len(kinds)
    ftext = {r["record"]: [(t[:1500] if t.strip() else "notext notext") for t in r["texts"]] for r in recs}
    rtext = {r["record"]: [desc_of(r["ctx"][l]) + " " + " ".join(r["ctx"][l]["seg"])[-600:] for l in r["labels"]] for r in recs}
    pf, pr = {}, {}
    accf = accr = n = 0
    for k in sorted(set(fo.values())):
        tr = [r for r in recs if fo[r["record"]] != k]
        te = [r for r in recs if fo[r["record"]] == k]
        yf = [kinds.index(kind[r["record"]][r["truth"][f]]) for r in tr for f in r["files"]]
        yr = [kinds.index(kind[r["record"]][l]) for r in tr for l in r["labels"]]
        cf = fit(matrix([t for r in tr for t in ftext[r["record"]]]), np.array(yf), K)
        cr = fit(matrix([t for r in tr for t in rtext[r["record"]]]), np.array(yr), K)
        for r in te:
            pf[r["record"]] = cf(matrix(ftext[r["record"]]))
            pr[r["record"]] = cr(matrix(rtext[r["record"]]))
            for j, f in enumerate(r["files"]):
                accf += kinds[pf[r["record"]][j].argmax()] == kind[r["record"]][r["truth"][f]]
            for i, l in enumerate(r["labels"]):
                accr += kinds[pr[r["record"]][i].argmax()] == kind[r["record"]][l]
            n += len(r["files"])
    print(f"{K} kinds; out-of-fold kind accuracy: files {accf / n:.3f}, affidavit side {accr / n:.3f}")
    out = {}
    for r in recs:
        P, Q = pr[r["record"]], pf[r["record"]]
        same = P @ Q.T
        out[r["record"]] = np.stack([same, np.log(same + 1e-4), (P.argmax(1)[:, None] == Q.argmax(1)[None, :]).astype(float)], axis=2).astype(np.float32)
    np.savez_compressed(os.path.join(HERE, "feats_kind.npz"), **out)
    np.save(os.path.join(HERE, "feats_kind_names.npy"), np.array(["kind_same_p", "kind_same_logp", "kind_same_top"]))


if __name__ == "__main__":
    main()
