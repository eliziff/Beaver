"""The tier-1 tagger's tree baseline: gradient-boosted trees over each piece's evidence, its
tier-0 labels and those of the two pieces on each side, from `structure-gold rows` output.

  python train_trees.py ROWS_DIR --out OUT_DIR [--parents PREDICTIONS.jsonl]

Region, start, document and reference each get a LightGBM classifier with early stopping on
development (test is never read). Reports development accuracy beside tier 0 as
train_tagger.py does, and writes OUT_DIR/predictions-development-trees.jsonl for
`structure-gold grade --labels`. Trees choose no parents: with --parents, each unit start the
trees open takes its parent from that file's labels where it opens the same piece; otherwise
tier 0's.
"""
import argparse
import json
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np

from train_tagger import HEADS, REGIONS, Vocab, load

LAGS = (-2, -1, 1, 2)


def matrix(docs, vocabs):
    """Each piece's features, tier-0 labels and reader codes, with its neighbours' beside them."""
    blocks, golds = [], []
    for d in docs:
        tier0 = np.asarray(d["tier0"], dtype=np.float32)[:, [column for _, column, _ in HEADS]]
        own = np.concatenate([
            np.asarray(d["features"], dtype=np.float32), tier0,
            np.asarray([[vocab(t[k]) for k, vocab in zip((1, 2, 3), vocabs)] for t in d["text"]], dtype=np.float32),
        ], axis=1)
        n = len(own)
        parts = [own]
        for lag in LAGS:
            shifted = np.full_like(own, np.nan)
            if lag < 0:
                shifted[-lag:] = own[:n + lag]
            else:
                shifted[:n - lag] = own[lag:]
            parts.append(shifted)
        blocks.append(np.concatenate(parts, axis=1))
        golds.append(np.asarray([g if g is not None else [-1] * 7 for g in d["gold"]], dtype=np.int64))
    return np.concatenate(blocks), np.concatenate(golds)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--parents", type=Path)
    parser.add_argument("--jobs", type=int, default=-1)
    args = parser.parse_args()
    started = time.time()
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    vocabs = [Vocab(t[k] for d in train_raw for t in d["text"]) for k in (1, 2, 3)]
    x_train, g_train = matrix(train_raw, vocabs)
    x_dev, g_dev = matrix(dev_raw, vocabs)
    width = len(train_raw[0]["features"][0])
    own = width + len(HEADS) + 3
    categorical = [block * own + width + k for block in range(1 + len(LAGS)) for k in range(len(HEADS) + 3)]
    names = json.loads((args.rows / "features.json").read_text()) + [f"tier0_{name}" for name, _, _ in HEADS] + \
        ["region_type", "note_mode", "family"]
    columns = [f"{name}{'' if lag == 0 else f'@{lag:+d}'}" for lag in (0, *LAGS) for name in names]
    print(f"{x_train.shape[0]} train / {x_dev.shape[0]} development pieces, {x_train.shape[1]} columns, "
          f"loaded in {time.time() - started:.0f}s", flush=True)
    predictions, probabilities = {}, {}
    for k, (name, column, n) in enumerate(HEADS):
        keep_train, keep_dev = g_train[:, column] >= 0, g_dev[:, column] >= 0
        began = time.time()
        model = lgb.LGBMClassifier(objective="multiclass", num_class=n, n_estimators=2000, learning_rate=0.05,
                                   num_leaves=63, min_child_samples=20, subsample=0.8, subsample_freq=1,
                                   colsample_bytree=0.5, n_jobs=args.jobs, verbose=-1)
        labels_train, labels_dev = g_train[keep_train, column], g_dev[keep_dev, column]
        if len(np.unique(labels_train)) < n:
            # LightGBM's multiclass needs every class present; a missing one never wins.
            model.set_params(num_class=int(labels_train.max()) + 1)
        model.fit(x_train[keep_train], labels_train, eval_set=[(x_dev[keep_dev], labels_dev)],
                  categorical_feature=categorical, callbacks=[lgb.early_stopping(50, verbose=False)])
        predicted = model.predict(x_dev)
        predictions[column] = predicted
        # Each class in its own column, a class the trees never saw left at zero.
        full = np.zeros((len(x_dev), n), dtype=np.float32)
        full[:, model.classes_] = model.predict_proba(x_dev)
        probabilities[name] = full
        tier0 = x_dev[:, width + k].astype(np.int64)
        accuracy = lambda p: float(np.mean(p[keep_dev] == g_dev[keep_dev, column]))
        print(f"trees {name:9} n={int(keep_dev.sum()):7} accuracy tier0 {accuracy(tier0):.4f} model {accuracy(predicted):.4f}"
              f" ({model.best_iteration_} trees, {time.time() - began:.0f}s)", flush=True)
        gain = model.booster_.feature_importance(importance_type="gain")
        top = np.argsort(gain)[::-1][:16]
        print("  most gain: " + ", ".join(f"{columns[c]} {gain[c] / gain.sum():.3f}" for c in top), flush=True)
    parents = {}
    if args.parents:
        for line in open(args.parents, encoding="utf-8"):
            row = json.loads(line)
            parents[row["sha256"]] = np.asarray(row["labels"], dtype=np.int64)
    args.out.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(args.out / "probabilities-development-trees.npz", **probabilities)
    offset = 0
    with open(args.out / "predictions-development-trees.jsonl", "w", encoding="utf-8") as stream:
        for raw in dev_raw:
            n = len(raw["ids"])
            tier0 = np.asarray(raw["tier0"], dtype=np.int64)
            labels = tier0.copy()
            for column, predicted in predictions.items():
                labels[:, column] = predicted[offset:offset + n]
            labels[labels[:, 0] == 0, 1] = 0
            source = parents.get(raw["sha256"], tier0)
            starts = labels[:, 1] == 1
            # A parent stands only where it names a piece the trees open.
            labels[:, 5] = np.where(starts, source[:, 5], -1)
            pointed = labels[:, 5] >= 0
            targets = labels[pointed, 5]
            labels[pointed, 5] = np.where(labels[targets, 1] == 1, targets, -1)
            latest = {}
            labels[:, 6] = -1
            for r in range(n):
                if labels[r, 1] == 2:
                    labels[r, 6] = latest.get(int(labels[r, 0]), -1)
                    if labels[r, 6] < 0:
                        labels[r, 1] = 1
                if labels[r, 1] == 1:
                    latest[int(labels[r, 0])] = r
            stream.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": labels.tolist()}) + "\n")
            offset += n
    print(f"done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
