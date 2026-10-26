"""Heading consistency: a second stage over the heading editor. A document sets its headings of one
level in one look (font, size, bold, italic, capitals) and numbers them in one family, so each
candidate is read beside what the editor said of the document's other candidates in its look and its
family: their mean, top and count of p(heading), and whether it continues the run of a confident
heading in its family. A gradient-boosted model over those and the editor's own p gives the final
p(heading); trained on the editor's out-of-fold probabilities over train (`train_heading_edits.py
--folds`), thresholds chosen out of fold on train, applied to development. Test is never read.

  python heading_consistency.py ROWS_DIR --editor EDITOR_DIR --inputs DIR [DIR ...] [--base LABELS] --out OUT_DIR

Writes OUT_DIR/edits-development.jsonl for `grade --labels`.
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import cross_val_predict

from train_heading_edits import Candidates, choose, edited, enumerator, extraction_of, unit_f1, FAMILIES
from train_tagger import load


def consistency(raw, picked, p):
    """Per candidate: the editor's p, and what it said of the other candidates in the same look and family."""
    looks = raw["look"]
    texts = [t[0] for t in raw["text"]]
    by_look, by_family = defaultdict(list), defaultdict(list)
    families = []
    for i, k in enumerate(picked):
        family, value = enumerator(texts[k])
        families.append((family, value))
        by_look[looks[k]].append(i)
        if family < len(FAMILIES):
            by_family[family].append(i)
    rows = []
    for i, k in enumerate(picked):
        own = p[i, 0]

        def others(group):
            values = [p[j, 0] for j in group if j != i]
            if not values:
                return [0.0, 0.0, 0.0, 0.0]
            arr = np.asarray(values)
            return [float(arr.mean()), float(arr.max()), float((arr >= 0.5).mean()), min(len(values), 50) / 50]

        family, value = families[i]
        same_family = by_family.get(family, []) if family < len(FAMILIES) else []
        # A confident heading earlier in the family whose value is one less: this one continues its run.
        continues = 0.0
        for j in reversed([j for j in same_family if j < i]):
            if families[j][1] == value - 1 and p[j, 0] >= 0.5:
                continues = 1.0
                break
        rows.append([own, p[i, 1]] + others(by_look[looks[k]]) + others(same_family) + [continues, float(family < len(FAMILIES))])
    return np.asarray(rows, dtype=np.float32)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--editor", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, nargs="+", required=True)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    names = json.loads((args.rows / "features.json").read_text())
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    stacked = np.concatenate([np.asarray(d["features"], dtype=np.float32) for d in train_raw])
    mean, std = stacked.mean(axis=0), stacked.std(axis=0) + 1e-6
    kept = json.load(open(args.editor / "probabilities.json", encoding="utf-8"))
    bases = {}
    if args.base:
        for line in open(args.base, encoding="utf-8"):
            row = json.loads(line)
            bases[row["sha256"]] = row["labels"]
    train = [Candidates(d, names, mean, std, None, extraction_of(d["sha256"], args.inputs)) for d in train_raw]
    dev = [Candidates(d, names, mean, std, None, extraction_of(d["sha256"], args.inputs), bases.get(d["sha256"])) for d in dev_raw]

    def stage_one(docs, split):
        found = []
        for d in docs:
            entry = kept[split][d.raw["sha256"]]
            assert entry["picked"] == d.picked.tolist(), "candidates differ from the editor's"
            found.append(np.asarray(entry["p"], dtype=np.float32).reshape(len(d.picked), 2))
        return found

    p_train, p_dev = stage_one(train, "train"), stage_one(dev, "development")
    x_train = [consistency(d.raw, d.picked, p) for d, p in zip(train, p_train)]
    x_dev = [consistency(d.raw, d.picked, p) for d, p in zip(dev, p_dev)]
    X = np.concatenate(x_train)
    y = np.concatenate([d.gold[:, 0] for d in train]).astype(int)
    groups = np.concatenate([np.full(len(d.picked), n % 5) for n, d in enumerate(train)])
    model = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=31, random_state=7)
    # Out-of-fold second-stage p over train (folds by document), for its thresholds.
    oof = np.zeros(len(y), dtype=np.float32)
    for f in range(5):
        fit_rows, held_rows = groups != f, groups == f
        oof[held_rows] = model.fit(X[fit_rows], y[fit_rows]).predict_proba(X[held_rows])[:, 1]
    model.fit(X, y)
    # The second stage replaces p(heading start); p(goes on) stays the editor's.
    def replaced(ps, xs, flat):
        out, at = [], 0
        for p, x in zip(ps, xs):
            q = p.copy()
            q[:, 0] = flat[at:at + len(x)]
            at += len(x)
            out.append(q)
        return out

    s_train = replaced(p_train, x_train, oof)
    s_dev = replaced(p_dev, x_dev, model.predict_proba(np.concatenate(x_dev))[:, 1] if x_dev else np.zeros(0))
    coarse = [round(v, 2) for v in np.arange(0.1, 0.95, 0.1)]
    args.out.mkdir(parents=True, exist_ok=True)
    for name, ps_train, ps_dev in (("editor", p_train, p_dev), ("consistency", s_train, s_dev)):
        f, *thresholds = choose(train, ps_train, coarse, extents=False)
        held = unit_f1(dev, ps_dev, thresholds)
        given = unit_f1(dev, ps_dev, (0.0, 1.01))
        print(f"{name}: thresholds {[float(v) for v in thresholds]} chosen out of fold on train (F1 {f:.4f}); development {held:.4f} "
              f"against the labels as given {given:.4f}", flush=True)
        with open(args.out / f"edits-{name}-development.jsonl", "w", encoding="utf-8") as out:
            for d, p in zip(dev, ps_dev):
                out.write(json.dumps({"sha256": d.raw["sha256"], "ids": d.raw["ids"], "labels": edited(d, p, *thresholds).tolist()}) + "\n")


if __name__ == "__main__":
    main()
