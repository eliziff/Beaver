"""Train the tree builder's parent ranker: LightGBM lambdarank over each unit's candidates on the
gold tree's open branch (`structure-gold tree ... --pairs`), stopped early on development, saved
as the JSON dump the Rust decoder reads.

  python train_tree_ranker.py PAIRS_TRAIN.csv PAIRS_DEV.csv MODEL.json [--rounds N] [--leaves N]
"""
import argparse
import json

import lightgbm as lgb
import numpy as np


def load(paths):
    """One or more pair files (comma-separated), their units kept apart."""
    parts, groups = [], []
    for path in paths.split(","):
        with open(path) as f:
            names = f.readline().strip().split(",")[2:]
        data = np.loadtxt(path, delimiter=",", skiprows=1, dtype=np.float64, ndmin=2)
        unit = data[:, 0].astype(np.int64)
        groups.append(np.diff(np.flatnonzero(np.r_[True, unit[1:] != unit[:-1], True])))
        parts.append(data)
    data = np.concatenate(parts)
    return data[:, 2:], data[:, 1], np.concatenate(groups), names


def top1(model, x, y, groups):
    scores = model.predict(x, num_iteration=model.best_iteration)
    right, at = 0, 0
    for size in groups:
        right += int(y[at + int(np.argmax(scores[at:at + size]))] == 1)
        at += size
    return right / len(groups)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("train")
    parser.add_argument("dev")
    parser.add_argument("out")
    parser.add_argument("--rounds", type=int, default=2000)
    parser.add_argument("--leaves", type=int, default=63)
    parser.add_argument("--drop", default="", help="Comma-separated feature-name prefixes held at zero (never split on)")
    args = parser.parse_args()
    xt, yt, gt, names = load(args.train)
    xd, yd, gd, _ = load(args.dev)
    dropped = [k for k, n in enumerate(names) if any(n.startswith(p) for p in args.drop.split(",") if p)]
    xt[:, dropped] = 0
    xd[:, dropped] = 0
    if dropped:
        print(f"held at zero: {len(dropped)} features ({args.drop})")
    print(f"train {len(gt)} units / {len(yt)} pairs; development {len(gd)} units / {len(yd)} pairs")
    params = {"objective": "lambdarank", "metric": "map", "eval_at": [1], "learning_rate": 0.05, "num_leaves": args.leaves,
              "min_data_in_leaf": 20, "feature_fraction": 0.9, "bagging_fraction": 0.9, "bagging_freq": 1,
              "lambdarank_truncation_level": 3, "verbose": -1, "num_threads": 8}
    train = lgb.Dataset(xt, yt, group=gt, feature_name=names)
    dev = lgb.Dataset(xd, yd, group=gd, reference=train)
    model = lgb.train(params, train, args.rounds, valid_sets=[dev], callbacks=[lgb.early_stopping(100), lgb.log_evaluation(100)])
    print(f"best iteration {model.best_iteration}; teacher-forced top-1: train {top1(model, xt, yt, gt):.3f}, "
          f"development {top1(model, xd, yd, gd):.3f}")
    gain = model.feature_importance("gain", iteration=model.best_iteration)
    for name, value in sorted(zip(names, gain), key=lambda p: -p[1])[:25]:
        print(f"  {name:20} {value / gain.sum():.3f}")
    with open(args.out, "w") as f:
        json.dump(model.dump_model(num_iteration=model.best_iteration), f)


if __name__ == "__main__":
    main()
