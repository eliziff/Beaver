"""Heading detection alone: does a heading unit start on this piece? LightGBM over each piece's
evidence (the rows' features and the parser's witnesses), the same read against its own document
(how far its type sits from the document's body type, how common its style is there), and its
neighbours'. Early stopping on a tenth of the training documents; development is scored once, by
mode, as heading starts on the same piece as the gold's (parallel English-French documents left
out with --exclude).

  python train_headings.py ROWS_DIR --out OUT_DIR [--exclude FILE] [--text EMBEDDINGS.npz]
"""
import argparse
import json
import statistics
from pathlib import Path

import lightgbm as lgb
import numpy as np

LAGS = (-2, -1, 1, 2)
RELATIVE = ["size", "height", "bold", "italic", "upper", "indent", "centre", "length", "gap_above", "gap_below", "width",
            "w_style_lines", "w_style_rank", "w_own_font", "w_caps"]


def documents(path, exclude):
    for line in open(path, encoding="utf-8"):
        doc = json.loads(line)
        if doc["sha256"] not in exclude:
            yield doc


def matrix(doc, col, text):
    f = np.asarray(doc["features"], dtype=np.float32)
    n = len(f)
    # The document's own body: medians over its pieces; each piece's distance from them.
    rel = []
    for name in RELATIVE:
        if name in col:
            x = f[:, col[name]]
            rel.append(x - np.median(x))
    # How common the piece's style is in this document (a body style is common, a heading's rare).
    sig = np.round(f[:, col["size"]] * 20) * 8 + (f[:, col["bold"]] > 0.5) * 4 + (f[:, col["upper"]] > 0.6) * 2 + (f[:, col["italic"]] > 0.5)
    _, inverse, counts = np.unique(sig, return_inverse=True, return_counts=True)
    share = (counts[inverse] / n).astype(np.float32)
    own = np.concatenate([f, np.stack(rel, axis=1), share[:, None], np.log1p(counts[inverse])[:, None].astype(np.float32),
                          np.asarray([[float(t[0][:1].isupper()), float(t[0].rstrip().endswith((".", ";", ","))), len(t[0].split())] for t in doc["text"]], dtype=np.float32)], axis=1)
    if text is not None:
        own = np.concatenate([own, text[doc["sha256"]]], axis=1)
    parts = [own]
    for lag in LAGS:
        shifted = np.full_like(own, np.nan)
        if lag < 0:
            shifted[-lag:] = own[:n + lag]
        else:
            shifted[:n - lag] = own[lag:]
        parts.append(shifted)
    y = np.asarray([1 if g and g[0] == 3 and g[1] == 1 else 0 for g in doc["gold"]], dtype=np.int8)
    return np.concatenate(parts, axis=1), y


def score(docs, probabilities, threshold):
    out = {}
    for mode in ("digitalborn", "ocr"):
        g = p = c = 0
        per = []
        for doc, prob in zip(docs, probabilities):
            if doc["mode"] != mode:
                continue
            gold = {k for k, x in enumerate(doc["gold"]) if x and x[0] == 3 and x[1] == 1}
            pred = set(np.flatnonzero(prob >= threshold).tolist())
            hit = len(gold & pred)
            g, p, c = g + len(gold), p + len(pred), c + hit
            if len(gold) >= 3:
                per.append(2 * hit / max(len(gold) + len(pred), 1))
        if g:
            out[mode] = (c / max(p, 1), c / g, 2 * c / (g + p), statistics.median(per) if per else 0.0, len(per))
    return out


PARAMS = {"objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "min_data_in_leaf": 40, "feature_fraction": 0.5,
          "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1, "num_threads": 8}


def fit(train_mats, stop_mats):
    xf, yf = np.concatenate([x for x, _ in train_mats]), np.concatenate([y for _, y in train_mats])
    xs, ys = np.concatenate([x for x, _ in stop_mats]), np.concatenate([y for _, y in stop_mats])
    return lgb.train(PARAMS, lgb.Dataset(xf, yf), 3000, valid_sets=[lgb.Dataset(xs, ys)], callbacks=[lgb.early_stopping(100, verbose=False)])


def consistency(doc, col, prob):
    """What the first pass thinks of the document's other lines like this one: the same style, the
    same numbering family, the lines around it, and its standing on its page."""
    f = np.asarray(doc["features"], dtype=np.float32)
    n = len(f)
    sig = np.round(f[:, col["size"]] * 20) * 8 + (f[:, col["bold"]] > 0.5) * 4 + (f[:, col["upper"]] > 0.6) * 2 + (f[:, col["italic"]] > 0.5)
    out = np.zeros((n, 12), dtype=np.float32)
    for key in (sig, np.asarray([hash(t[3]) if t[3] else 0 for t in doc["text"]])):
        base = 0 if key is sig else 4
        for value in np.unique(key):
            at = np.flatnonzero(key == value)
            if key is not sig and value == 0:
                continue
            total, top = prob[at].sum(), prob[at].max()
            others = (total - prob[at]) / max(len(at) - 1, 1)
            out[at, base] = others
            out[at, base + 1] = (prob[at] >= 0.5).sum() - (prob[at] >= 0.5)
            out[at, base + 2] = len(at)
            out[at, base + 3] = top
    padded = np.r_[np.nan, np.nan, prob, np.nan, np.nan]
    out[:, 8:12] = np.stack([padded[0:n], padded[1:n + 1], padded[3:n + 3], padded[4:n + 4]], axis=1)
    return np.concatenate([out, prob[:, None]], axis=1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--exclude", type=Path)
    parser.add_argument("--text", help="npz files (comma-separated) of per-document piece embeddings: words, look")
    parser.add_argument("--stack", action="store_true", help="a second pass reading the first pass over the document")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    exclude = {l.split()[1] for l in open(args.exclude) if len(l.split()) > 1} if args.exclude else set()
    names = json.load(open(args.rows / "features.json"))
    col = {n: k for k, n in enumerate(names)}
    # One or more per-piece embedding files (comma-separated), joined side by side per document.
    text = None
    if args.text:
        parts = [np.load(p) for p in str(args.text).split(",")]
        text = {k: np.concatenate([p[k].astype(np.float32) for p in parts], axis=1) for k in parts[0].files}
    train = list(documents(args.rows / "rows-train.jsonl", set()))
    dev = list(documents(args.rows / "rows-development.jsonl", exclude))
    rng = np.random.default_rng(0)
    held = set(rng.choice(len(train), size=max(1, len(train) // 10), replace=False).tolist())
    mats = [matrix(d, col, text) for d in train]
    dev_mats = [matrix(d, col, text) for d in dev]
    fit_k = [k for k in range(len(train)) if k not in held]
    print(f"{len(fit_k)} training documents, {sum(len(mats[k][1]) for k in fit_k)} pieces, {mats[0][0].shape[1]} columns")
    model = fit([mats[k] for k in fit_k], [mats[k] for k in held])
    dev_prob = [model.predict(x, num_iteration=model.best_iteration) for x, _ in dev_mats]
    print(f"first pass: best iteration {model.best_iteration}")
    for mode, (p, r, f, med, n) in score(dev, dev_prob, 0.5).items():
        print(f"  development {mode:11} t=0.50: P {p:.3f} R {r:.3f} F1 {f:.3f}  median {med:.3f} over {n} docs")
    if args.stack:
        # Out-of-fold first-pass probabilities over training, so the second pass learns from honest ones.
        folds = np.arange(len(train)) % 5
        rng.shuffle(folds)
        oof = [None] * len(train)
        for fold in range(5):
            inside = [k for k in range(len(train)) if folds[k] != fold]
            stop_k = inside[:len(inside) // 10]
            m = fit([mats[k] for k in inside[len(inside) // 10:]], [mats[k] for k in stop_k])
            for k in np.flatnonzero(folds == fold):
                oof[k] = m.predict(mats[k][0], num_iteration=m.best_iteration)
        second = [(np.concatenate([mats[k][0], consistency(train[k], col, oof[k])], axis=1), mats[k][1]) for k in range(len(train))]
        model = fit([second[k] for k in fit_k], [second[k] for k in held])
        dev_mats = [(np.concatenate([x, consistency(d, col, p)], axis=1), y) for (x, y), d, p in zip(dev_mats, dev, dev_prob)]
        dev_prob = [model.predict(x, num_iteration=model.best_iteration) for x, _ in dev_mats]
        mats = second
        print(f"second pass: best iteration {model.best_iteration}")
    held_docs = [d for k, d in enumerate(train) if k in held]
    held_prob = [model.predict(mats[k][0], num_iteration=model.best_iteration) for k in sorted(held)]
    held_docs = [train[k] for k in sorted(held)]
    best = max((t / 20 for t in range(2, 17)), key=lambda t: sum(v[2] for v in score(held_docs, held_prob, t).values()))
    print(f"threshold {best:.2f} (chosen on held-out training documents)")
    for t in (0.1, 0.15, 0.2, 0.3):
        for mode, (p, r, f, med, n) in score(dev, dev_prob, t).items():
            print(f"  curve {mode:11} t={t:.2f}: P {p:.3f} R {r:.3f} F1 {f:.3f}")
    for threshold in (0.5, best):
        for mode, (p, r, f, med, n) in score(dev, dev_prob, threshold).items():
            print(f"  development {mode:11} t={threshold:.2f}: P {p:.3f} R {r:.3f} F1 {f:.3f}  median {med:.3f} over {n} docs")
    np.savez_compressed(args.out / "heading-probabilities-development.npz", **{d["sha256"]: p for d, p in zip(dev, dev_prob)})
    model.save_model(str(args.out / "headings.txt"), num_iteration=model.best_iteration)


if __name__ == "__main__":
    main()
