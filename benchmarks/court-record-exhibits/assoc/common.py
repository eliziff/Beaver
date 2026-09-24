"""Shared harness for the exhibit-association experiments: data, grouped 5-fold split, scoring."""
import hashlib, json, os, sys
import numpy as np
from scipy.optimize import linear_sum_assignment

BENCH = r"C:\Users\elias\Desktop\MikeOSS Fork\benchmarks\court-record-exhibits"
sys.path.insert(0, BENCH)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(os.environ["LOCALAPPDATA"], "OpenLegalData", "benchmarks", "court-record-exhibits", "records")


def load(path=os.path.join(HERE, "inputs.json")):
    recs = json.load(open(path, encoding="utf-8"))
    for r in recs:
        g = json.load(open(os.path.join(ROOT, r["record"], "gold.json"), encoding="utf-8"))
        r["group"] = g.get("family") or g.get("court_file") or r["record"]
    return recs


def folds(recs, k=5):
    """Record -> fold. Records of one proceeding (family / court file) share a fold, so a
    sibling affidavit's duplicated exhibits never sit on both sides. Balanced by file count."""
    groups = {}
    for r in recs:
        groups.setdefault(r["group"], []).append(r)
    order = sorted(groups, key=lambda g: (-sum(len(r["files"]) for r in groups[g]), hashlib.sha1(g.encode()).hexdigest()))
    load_, out = [0] * k, {}
    for g in order:
        f = min(range(k), key=lambda i: (load_[i], i))
        for r in groups[g]:
            out[r["record"]] = f
        load_[f] += sum(len(r["files"]) for r in groups[g])
    return out


def truth(r):
    return np.array([[1.0 if r["truth"][f] == l else 0.0 for f in r["files"]] for l in r["labels"]])


def assign(s):
    rows, cols = linear_sum_assignment(-np.asarray(s))
    return dict(zip(rows, cols))


def accuracy(recs, scores, per_record=False):
    """scores: record -> (labels x files) matrix. One-to-one assignment accuracy over files."""
    ok = n = 0
    per = {}
    for r in recs:
        if r["record"] not in scores:
            continue
        t = truth(r)
        a = assign(scores[r["record"]])
        k = int(sum(t[i, j] for i, j in a.items()))
        per[r["record"]] = (k, len(r["files"]))
        ok += k; n += len(r["files"])
    return (ok / max(n, 1), n, per) if per_record else ok / max(n, 1)


def top1(recs, scores):
    """Label-wise argmax accuracy (no assignment), for diagnosing the raw scorer."""
    ok = n = 0
    for r in recs:
        if r["record"] in scores:
            t = truth(r)
            s = np.asarray(scores[r["record"]])
            ok += int(t[np.arange(len(t)), s.argmax(1)].sum()); n += len(t)
    return ok / max(n, 1)


def to_preds(recs, scores):
    out = {}
    for r in recs:
        if r["record"] in scores:
            a = assign(scores[r["record"]])
            out[r["record"]] = {r["files"][j]: r["labels"][i] for i, j in a.items()}
    return out
