"""Scorers over cached pair-feature tensors, grouped 5-fold by record, one-to-one assignment.

Usage: python models.py <feature-set,...> [--model point|list|mlp] [--drop name,...] [--save tag] [--per]

Each feature set is feats_<name>.npz (record -> labels x files x k) with
feats_<name>_names.npy. Models:
  point  weighted pointwise logistic (fastmatch.fit), the old framing
  list   linear conditional logit: each label's softmax over the record's files plus
         each file's softmax over the labels (bidirectional listwise), L2
  mlp    the same listwise loss over a one-hidden-layer MLP
"""
import json, os, sys, time
import numpy as np
from scipy.optimize import minimize
from common import HERE, load, folds, truth, accuracy, top1

args = sys.argv[1:]
opt = lambda n, d=None: args[args.index(n) + 1] if n in args else d


def load_feats(sets, recs):
    X, names = {r["record"]: [] for r in recs}, []
    for s in sets:
        z = np.load(os.path.join(HERE, f"feats_{s}.npz"))
        names += [f"{s}:{n}" for n in np.load(os.path.join(HERE, f"feats_{s}_names.npy"))]
        for r in recs:
            X[r["record"]].append(z[r["record"]])
    X = {k: np.concatenate(v, axis=2) for k, v in X.items()}
    drop = set((opt("--drop") or "").split(",")) - {""}
    keep = [i for i, n in enumerate(names) if n not in drop and n.split(":")[1] not in drop]
    return {k: v[:, :, keep] for k, v in X.items()}, [names[i] for i in keep]


def fit_point(Xs, Ys, l2=0.1):
    import fastmatch as fm
    X = np.concatenate([x.reshape(-1, x.shape[2]) for x in Xs]); y = np.concatenate([y.ravel() for y in Ys])
    m = fm.fit(X, y, l2=l2)
    mu, sd, w, b = map(np.array, (m["mu"], m["sd"], m["w"], [m["b"]]))
    return lambda x: ((x - mu) / sd) @ w + b[0]


def fit_list(Xs, Ys, l2=1e-2, both=True):
    allx = np.concatenate([x.reshape(-1, x.shape[2]) for x in Xs])
    mu, sd = allx.mean(0), allx.std(0) + 1e-6
    Zs = [(x - mu) / sd for x in Xs]
    n = sum(len(y) for y in Ys)
    k = allx.shape[1]

    def f(w):
        loss, g = 0.0, np.zeros(k)
        for Z, Y in zip(Zs, Ys):
            s = Z @ w
            for axis in ((1, 0) if both else (1,)):
                m = s.max(axis=axis, keepdims=True)
                p = np.exp(s - m); p /= p.sum(axis=axis, keepdims=True)
                loss -= (np.log(p + 1e-12) * Y).sum()
                g -= np.einsum("ijk,ij->k", Z, Y - p)
        return loss / n + l2 * w @ w, g / n + 2 * l2 * w

    w = minimize(f, np.zeros(k), jac=True, method="L-BFGS-B", options={"maxiter": 500}).x
    return lambda x: ((x - mu) / sd) @ w, w


def fit_mlp(Xs, Ys, hidden=32, epochs=60, l2=1e-3, seed=0):
    import torch
    torch.manual_seed(seed)
    allx = np.concatenate([x.reshape(-1, x.shape[2]) for x in Xs])
    mu, sd = allx.mean(0), allx.std(0) + 1e-6
    Zs = [torch.tensor((x - mu) / sd, dtype=torch.float32) for x in Xs]
    Ts = [torch.tensor(y.argmax(1)) for y in Ys]
    Tc = [torch.tensor(y.argmax(0)) for y in Ys]
    net = torch.nn.Sequential(torch.nn.Linear(allx.shape[1], hidden), torch.nn.GELU(), torch.nn.Linear(hidden, 1))
    opt_ = torch.optim.AdamW(net.parameters(), lr=3e-3, weight_decay=l2)
    for ep in range(epochs):
        for i in np.random.RandomState(seed + ep).permutation(len(Zs)):
            s = net(Zs[i]).squeeze(-1)
            loss = torch.nn.functional.cross_entropy(s, Ts[i]) + torch.nn.functional.cross_entropy(s.T, Tc[i])
            opt_.zero_grad(); loss.backward(); opt_.step()
    net.eval()
    return lambda x: net(torch.tensor((x - mu) / sd, dtype=torch.float32)).squeeze(-1).detach().numpy()


def crossval(recs, X, model="list", **kw):
    fo = folds(recs)
    scores, weights = {}, []
    for k in sorted(set(fo.values())):
        tr = [r for r in recs if fo[r["record"]] != k]
        te = [r for r in recs if fo[r["record"]] == k]
        Xs, Ys = [X[r["record"]] for r in tr], [truth(r) for r in tr]
        if model == "point":
            f = fit_point(Xs, Ys)
        elif model == "mlp":
            f = fit_mlp(Xs, Ys, **kw)
        else:
            f, w = fit_list(Xs, Ys, **kw); weights.append(w)
        for r in te:
            scores[r["record"]] = f(X[r["record"]])
    return scores, (np.mean(weights, 0) if weights else None)


def main():
    recs = load()
    sets = args[0].split(",")
    X, names = load_feats(sets, recs)
    model = opt("--model", "list")
    t0 = time.time()
    scores, w = crossval(recs, X, model)
    acc, n, per = accuracy(recs, scores, per_record=True)
    print(f"{'+'.join(sets)} [{model}] {len(names)} feats: 5-fold assigned acc {acc:.3f} (n={n} files, {len(recs)} records); label top-1 {top1(recs, scores):.3f}; {time.time() - t0:.0f}s")
    if w is not None and "--weights" in args:
        for nm, v in sorted(zip(names, w), key=lambda t: -abs(t[1])):
            print(f"   {nm:28} {v:+.2f}")
    if "--per" in args:
        for rid, (k, m) in sorted(per.items(), key=lambda t: t[1][0] / t[1][1]):
            print(f"   {rid:34} {k}/{m}")
    if opt("--save"):
        np.savez_compressed(os.path.join(HERE, f"oof_{opt('--save')}.npz"), **scores)


if __name__ == "__main__":
    main()
