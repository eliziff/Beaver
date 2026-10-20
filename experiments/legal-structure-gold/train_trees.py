"""The tier-1 tagger's tree baseline: gradient-boosted trees over each line's evidence, its
tier-0 labels and those of the two lines on each side, from `structure-gold rows` output.

  python train_trees.py ROWS_DIR --out OUT_DIR

Region, start and relation each get a LightGBM classifier with early stopping on development
(test is never read). Reports development accuracy beside tier 0 as train_tagger.py does, and
writes OUT_DIR/predictions-development-trees.jsonl for `structure-gold grade --labels`.
"""
import argparse
import json
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np

from train_tagger import HEADS, REGIONS, Vocab, load

LAGS = (-2, -1, 1, 2)


def matrix(docs, region_types, note_modes, families):
    """Each line's features, tier-0 labels and reader codes, with its neighbours' beside them."""
    blocks, golds = [], []
    for d in docs:
        own = np.concatenate([
            np.asarray(d["features"], dtype=np.float32),
            np.asarray(d["tier0"], dtype=np.float32),
            np.asarray([[region_types(t[1]), note_modes(t[2]), families(t[3] if len(t) > 3 else "")] for t in d["text"]],
                       dtype=np.float32),
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
        golds.append(np.asarray([g if g is not None else [-1] * 5 for g in d["gold"]], dtype=np.int64))
    return np.concatenate(blocks), np.concatenate(golds)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    started = time.time()
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    region_types = Vocab(t[1] for d in train_raw for t in d["text"])
    note_modes = Vocab(t[2] for d in train_raw for t in d["text"])
    families = Vocab(t[3] if len(t) > 3 else "" for d in train_raw for t in d["text"])
    x_train, g_train = matrix(train_raw, region_types, note_modes, families)
    x_dev, g_dev = matrix(dev_raw, region_types, note_modes, families)
    width = len(train_raw[0]["features"][0])
    categorical = [width + k for k in range(8)]
    categorical = [c + block * (width + 8) for block in range(1 + len(LAGS)) for c in categorical]
    print(f"{x_train.shape[0]} train / {x_dev.shape[0]} development lines, {x_train.shape[1]} columns, "
          f"loaded in {time.time() - started:.0f}s", flush=True)
    predictions = {}
    for k, (name, n) in enumerate(HEADS[:3]):
        keep_train, keep_dev = g_train[:, k] >= 0, g_dev[:, k] >= 0
        if name == "relation":
            keep_train &= (g_train[:, 1] == 1) & (g_train[:, k] > 0)
            keep_dev &= (g_dev[:, 1] == 1) & (g_dev[:, k] > 0)
        began = time.time()
        model = lgb.LGBMClassifier(objective="multiclass", num_class=n, n_estimators=2000, learning_rate=0.05,
                                   num_leaves=63, min_child_samples=20, subsample=0.8, subsample_freq=1,
                                   colsample_bytree=0.5, n_jobs=-1, verbose=-1)
        model.fit(x_train[keep_train], g_train[keep_train, k], eval_set=[(x_dev[keep_dev], g_dev[keep_dev, k])],
                  categorical_feature=categorical, callbacks=[lgb.early_stopping(50, verbose=False)])
        predicted = model.predict(x_dev)
        predictions[name] = predicted
        tier0 = x_dev[:, width + k].astype(np.int64)
        accuracy = lambda p: float(np.mean(p[keep_dev] == g_dev[keep_dev, k]))
        print(f"trees {name:9} n={int(keep_dev.sum()):7} accuracy tier0 {accuracy(tier0):.4f} model {accuracy(predicted):.4f}"
              f" ({model.best_iteration_} trees, {time.time() - began:.0f}s)", flush=True)
    args.out.mkdir(parents=True, exist_ok=True)
    offset = 0
    with open(args.out / "predictions-development-trees.jsonl", "w", encoding="utf-8") as stream:
        for raw in dev_raw:
            n = len(raw["ids"])
            tier0 = np.asarray(raw["tier0"], dtype=np.int64)
            labels = tier0.copy()
            for k, name in enumerate(("region", "start", "relation")):
                labels[:, k] = predictions[name][offset:offset + n]
            stream.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": labels.tolist()}) + "\n")
            offset += n
    print(f"done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
