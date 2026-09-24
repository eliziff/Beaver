"""Which date is the document's own date? A conditional-logit ranker over the day-dates in a
file's opening (trained on gold exhibit dates, grouped 5-fold by record, so every file's
distribution is out of fold), then pair features: the probability mass the file puts on
dates the affidavit's text for the label names, and the label-order gap using the predicted date.

Usage: python docdate.py -> feats_dd.npz (+ _names.npy); prints the ranker's top-1 accuracy
"""
import datetime as dt, json, math, os, re
import numpy as np
from scipy.optimize import minimize
from common import HERE, ROOT
import fields as F
from feats2 import lab_key, desc_of

CTX_BEFORE = {k: re.compile(p, re.I) for k, p in {
    "date_colon": r"\bdate[d]?\s*:?\s*$", "dated": r"\bdated\b[^.]{0,20}$", "sent": r"\bsent\s*:?\s*$|\bsent\b[^.]{0,15}$",
    "asof": r"\b(?:made|effective|entered into)?\s*as of\b[^.]{0,25}$", "dayof": r"\bday of\b\s*$", "on": r"\bon\s*$",
    "issued": r"\b(?:issued|signed|executed|approved|adopted|filed|received)\b[^.]{0,20}$",
    "accessed": r"\b(?:accessed|retrieved|printed|downloaded|visited)\b[^.]{0,25}$",
    "updated": r"\b(?:updated|modified|revised|published|posted)\b[^.]{0,25}$",
    "period": r"\b(?:from|between|to|until|ending|ended|through|expir\w*|due|deadline|by)\s*$",
    "birth": r"\b(?:birth|born|dob)\b[^.]{0,15}$"}.items()}
AFTER_TIME = re.compile(r"^[,\s]*(?:at\s+)?\d{1,2}:\d\d", re.I)
NAMES = ["rank0", "rank1", "rank_log", "off_log", "off_rel", "cnt_head", "cnt_all_log", "is_max", "is_min", "year_mode", "numeric",
         "after_time", "line_start"] + [f"ctx_{k}" for k in CTX_BEFORE]


def cands(t):
    h = t[:3000]
    ds = [(p, d) for p, d in F.dates(h) if len(d) == 10]
    if not ds:
        return [], None
    order = list(dict.fromkeys(d for _, d in ds))
    first_pos = {}
    for p, d in ds:
        first_pos.setdefault(d, p)
    allcnt = {}
    for _, d in F.dates(t):
        allcnt[d] = allcnt.get(d, 0) + 1
    years = [d[:4] for _, d in ds]
    ymode = max(set(years), key=years.count)
    X = []
    for k, d in enumerate(order):
        p = first_pos[d]
        before = h[max(0, p - 40):p]
        after = h[p:p + 40]
        seg = h[p:p + 25]
        X.append([k == 0, k == 1, math.log1p(k), math.log1p(p), p / max(1, len(h)), sum(1 for _, x in ds if x == d),
                  math.log1p(allcnt.get(d, 0)), d == max(order), d == min(order), d[:4] == ymode, bool(re.match(r"\d", seg)),
                  bool(AFTER_TIME.search(re.sub(r"^\S+\s*\S*\s*\S*", "", after))), bool(re.search(r"(?:^|\n)\s*$", before))]
                 + [bool(rx.search(before)) for rx in CTX_BEFORE.values()])
    return order, np.array(X, np.float32)


def fit(groups, l2=1e-2):
    allx = np.concatenate([x for x, _ in groups])
    mu, sd = allx.mean(0), allx.std(0) + 1e-6
    Z = [((x - mu) / sd, y) for x, y in groups]
    k = allx.shape[1]

    def f(w):
        loss, g = 0.0, np.zeros(k)
        for x, y in Z:
            s = x @ w; s -= s.max(); p = np.exp(s); p /= p.sum()
            loss -= math.log(p[y] + 1e-12); g -= x[y] - p @ x
        return loss / len(Z) + l2 * w @ w, g / len(Z) + 2 * l2 * w
    w = minimize(f, np.zeros(k), jac=True, method="L-BFGS-B").x
    return lambda x: ((x - mu) / sd) @ w


def todate(s):
    try:
        return dt.date(int(s[:4]), int(s[5:7]), int(s[8:10]))
    except ValueError:
        return None


def main():
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    fo = json.load(open(os.path.join(HERE, "folds.json")))
    gold = {}
    for r in recs:
        g = json.load(open(os.path.join(ROOT, r["record"], "gold.json"), encoding="utf-8"))
        gold[r["record"]] = {e["file"]: e["date"] for e in g["exhibits"]}
    C = {r["record"]: [cands(t) for t in r["texts"]] for r in recs}
    dist = {}
    ok = n = first = 0
    for k in sorted(set(fo.values())):
        groups = []
        for r in recs:
            if fo[r["record"]] == k:
                continue
            for f, (order, X) in zip(r["files"], C[r["record"]]):
                gd = gold[r["record"]][f]
                if order and gd in order:
                    groups.append((X, order.index(gd)))
        score = fit(groups)
        for r in recs:
            if fo[r["record"]] != k:
                continue
            dist[r["record"]] = []
            for f, (order, X) in zip(r["files"], C[r["record"]]):
                if not order:
                    dist[r["record"]].append({}); continue
                s = score(X); s -= s.max(); p = np.exp(s); p /= p.sum()
                dist[r["record"]].append(dict(zip(order, p)))
                gd = gold[r["record"]][f]
                if gd and len(gd) == 10:
                    n += 1; ok += order[int(p.argmax())] == gd; first += order[0] == gd
    print(f"document date top-1 {ok}/{n} = {ok / n:.3f} (first-date rule {first / n:.3f}) over day-dated gold exhibits")
    out = {}
    names = ["pdd_seg", "pdd_main", "pdd_ctx", "pdd_mon", "top_seg", "top_near", "dd_order_gap", "dd_dated"]
    for r in recs:
        labels = r["labels"]
        L, N = len(labels), len(r["files"])
        X = np.zeros((L, N, len(names)), np.float32)
        D = dist[r["record"]]
        top = [max(d, key=d.get) if d else None for d in D]
        dated = [j for j in range(N) if top[j]]
        drank = {j: q / max(1, len(dated) - 1) for q, j in enumerate(sorted(dated, key=lambda j: top[j]))}
        order = sorted(labels, key=lab_key)
        for i, l in enumerate(labels):
            c = r["ctx"][l]
            seg = F.dayset(F.dates(" ".join(c["seg"]) + " " + c["item"]))
            main = F.dayset(F.dates(desc_of(c)))
            ctx = F.dayset(F.dates(c["before"][-500:] + " " + c["main"] + " " + c["after"][:300]))
            mons = {d[:7] for d in seg | main}
            sd = [todate(d) for d in seg | main]
            for j in range(N):
                d = D[j]
                near = 0.0
                if top[j] and sd:
                    t = todate(top[j])
                    near = max((math.exp(-abs((x - t).days) / 30) for x in sd if x and t), default=0.0)
                X[i, j] = [sum(v for x, v in d.items() if x in seg), sum(v for x, v in d.items() if x in main),
                           sum(v for x, v in d.items() if x in ctx), sum(v for x, v in d.items() if x[:7] in mons),
                           bool(top[j] and top[j] in seg), near,
                           -abs(order.index(l) / max(1, L - 1) - drank[j]) if j in drank else 0.0, j in drank]
        out[r["record"]] = X
    np.savez_compressed(os.path.join(HERE, "feats_dd.npz"), **out)
    np.save(os.path.join(HERE, "feats_dd_names.npy"), np.array(names))


if __name__ == "__main__":
    main()
