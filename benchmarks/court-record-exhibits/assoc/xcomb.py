"""Combine the v4 feature scores with a pair reranker (xenc.py's llm_<tag>.npz) and measure it.

Usage: python xcomb.py <tag> [--base v4] [--thr 0.5] [--save name]

Confidence of a file = min(row softmax, column softmax) of v4's score at its Hungarian pick;
"low" = below --thr (the calibration row's gate). Reports
  - shortlist top-1 on the low-confidence files (file -> its top-5 labels) and on the labels
    picked for them (label -> its top-5 files), v4 vs reranker, and the top-5 cap;
  - end to end: S = v4 + lam * (row lp + col lp) (lp floored at -8), Hungarian, with lam chosen
    per held-out fold on the other folds (nested), applied to every pair ("all") or only to the
    low-confidence labels' rows and files' columns ("low");
  - the fraction of files still flagged (combined-score confidence below --thr) and their accuracy.
--raw uses ce_<tag>.npz raw logits instead (for --resid models trained on top of v4: S = v4 + lam * z,
unscored cells get the record's lowest scored logit).
--save writes oof_<name>.npz with the chosen "low" composition's scores (for export.py).
"""
import os, sys
import numpy as np
from common import HERE, load, folds, truth, assign

args = sys.argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
TAG, BASE, THR = args[0], opt("--base", "v4"), float(opt("--thr", 0.5))
LAMS = [0.0, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0]
K = 5


def softmaxes(s):
    r = np.exp(s - s.max(1, keepdims=True)); r /= r.sum(1, keepdims=True)
    c = np.exp(s - s.max(0, keepdims=True)); c /= c.sum(0, keepdims=True)
    return r, c


def picks(s):
    a = assign(s); r, c = softmaxes(s)
    return {j: (i, min(r[i, j], c[i, j])) for i, j in a.items()}  # file -> (label, confidence)


recs = load()
fo = folds(recs)
B = np.load(os.path.join(HERE, f"oof_{BASE}.npz"))
Z = np.load(os.path.join(HERE, f"llm_{TAG}.npz"))
RAW = "--raw" in args
R = np.load(os.path.join(HERE, f"ce_{TAG}.npz")) if RAW else None
recs = [r for r in recs if r["record"] in Z.files]
data = []
for r in recs:
    s, t = B[r["record"]], truth(r)
    lp = np.maximum(Z[r["record"]], -8.0)
    if RAW:
        z = R[r["record"]]; z = np.where(np.isnan(z), np.nanmin(z), z)
        lp = np.stack([z, z], axis=2)  # both slots carry the raw logit; combined() counts it once
    pk = picks(s)
    lowf = np.array([pk[j][1] < THR for j in range(s.shape[1])])
    lowl = np.zeros(s.shape[0], bool)
    for j, (i, c) in pk.items():
        lowl[i] |= c < THR
    data.append((r, s, t, lp, lowf, lowl))

# shortlist top-1 on the low-confidence half
st = {"f2l_v4": 0, "f2l_ce": 0, "f2l_cap": 0, "nf": 0, "l2f_v4": 0, "l2f_ce": 0, "l2f_cap": 0, "nl": 0}
for r, s, t, lp, lowf, lowl in data:
    L, N = s.shape; k = min(K, L, N)
    for j in np.nonzero(lowf)[0]:
        c = np.argsort(-s[:, j])[:k]; g = t[:, j].argmax()
        st["nf"] += 1; st["f2l_cap"] += int(g in c)
        st["f2l_v4"] += int(c[0] == g); st["f2l_ce"] += int(c[np.argmax(lp[c, j, 1])] == g)
    for i in np.nonzero(lowl)[0]:
        c = np.argsort(-s[i])[:k]; g = t[i].argmax()
        st["nl"] += 1; st["l2f_cap"] += int(g in c)
        st["l2f_v4"] += int(c[0] == g); st["l2f_ce"] += int(c[np.argmax(lp[i, c, 0])] == g)
print(f"{TAG}: low-confidence files {st['nf']}/{sum(len(d[0]['files']) for d in data)} (thr {THR})")
print(f"  file->top-5 labels : v4 {st['f2l_v4'] / st['nf']:.3f}  reranker {st['f2l_ce'] / st['nf']:.3f}  cap {st['f2l_cap'] / st['nf']:.3f}")
print(f"  label->top-5 files : v4 {st['l2f_v4'] / st['nl']:.3f}  reranker {st['l2f_ce'] / st['nl']:.3f}  cap {st['l2f_cap'] / st['nl']:.3f}  (n={st['nl']} labels)")


def combined(s, lp, lowf, lowl, lam, mode):
    term = lp[:, :, 0] if RAW else lp[:, :, 0] + lp[:, :, 1]
    if mode == "low":
        m = lowl[:, None] | lowf[None, :]
        term = np.where(m, term, 0.0)
    return s + lam * term


def acc_of(items, lam, mode):
    ok = n = 0
    for r, s, t, lp, lowf, lowl in items:
        a = assign(combined(s, lp, lowf, lowl, lam, mode))
        ok += int(sum(t[i, j] for i, j in a.items())); n += s.shape[1]
    return ok, n


best = {}
for mode in ("all", "low"):
    sweep = {lam: acc_of(data, lam, mode) for lam in LAMS}
    ok = n = 0; chosen = []
    for k in sorted(set(fo.values())):
        tr = [d for d in data if fo[d[0]["record"]] != k]; te = [d for d in data if fo[d[0]["record"]] == k]
        lam = max(LAMS, key=lambda l: (acc_of(tr, l, mode)[0], -l))
        a, b = acc_of(te, lam, mode); ok += a; n += b; chosen.append(lam)
    best[mode] = (ok / n, chosen)
    print(f"  end to end [{mode}] nested {ok / n:.3f} (lams {chosen}); sweep " + " ".join(f"{l}:{sweep[l][0] / sweep[l][1]:.3f}" for l in LAMS))

# flagged fraction after the combination (median chosen lam, "low" mode)
lam = float(np.median(best["low"][1]))
fl = okf = okc = nf = 0
out = {}
for r, s, t, lp, lowf, lowl in data:
    S = combined(s, lp, lowf, lowl, lam, "low"); out[r["record"]] = S
    for j, (i, c) in picks(S).items():
        nf += 1
        if c < THR:
            fl += 1; okf += int(t[i, j])
        else:
            okc += int(t[i, j])
print(f"  after [low] lam {lam}: flagged {fl / nf:.3f} of files (acc {okf / max(fl, 1):.3f}); unflagged acc {okc / max(nf - fl, 1):.3f}")
if opt("--save", ""):
    np.savez_compressed(os.path.join(HERE, f"oof_{opt('--save', '')}.npz"), **out)
