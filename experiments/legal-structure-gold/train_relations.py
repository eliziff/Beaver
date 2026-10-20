"""Unit relations read against the tagger's own ancestor chain, from `structure-gold rows` output.

  python train_relations.py ROWS_DIR LABELS.jsonl --out OUT_DIR

Each ranked unit is compared with the unit before it and that unit's ancestors: indentation,
type, region, and, through the numbering grammar's family and ordinal the rows carry, whether it
continues a family with the next number. Training walks the gold's units with the chain its
relations make; development walks the units LABELS.jsonl (a tagger's labels) start, with the
chain this model's own relations make, and writes those labels with its relations to
OUT_DIR/<LABELS stem>-relations.jsonl. Test is never read.
"""
import argparse
import json
import math
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np

from train_tagger import RELATIONS, load

UNRANKED = {0, 5, 7, 10, 11, 12}
CHAIN = 4
F = None


def column(name):
    return F.index(name)


def unit_values(doc, n, region):
    """The witnesses a unit is compared by: its line's place, type and marker."""
    f = doc["features"][n]
    family = doc["text"][n][3] if len(doc["text"][n]) > 3 else ""
    ordinal = round(math.exp(f[column("ordinal")] * 5.0) - 1.0) if f[column("marker")] else -1
    return {
        "x": f[column("x0")], "size": f[column("size")], "bold": f[column("bold")] > 0.5, "italic": f[column("italic")] > 0.5,
        "upper": f[column("upper")], "family": family if f[column("marker")] else "", "ordinal": ordinal,
        "depth": f[column("prefix_depth")], "region": region, "page": doc["pages"][n],
    }


def pair_features(u, a, distance):
    if a is None:
        return [0.0] * 11
    family = (u["family"] == a["family"]) if u["family"] and a["family"] else -1.0
    return [1.0, u["x"] - a["x"], (u["size"] / a["size"]) if a["size"] else 1.0, float(u["bold"] == a["bold"]),
            float(u["italic"] == a["italic"]), float(family),
            float(bool(u["family"]) and u["family"] == a["family"] and u["ordinal"] == a["ordinal"] + 1),
            float(u["region"] == a["region"]), float(a["region"] == 3), u["depth"] - a["depth"], math.log1p(distance) / 8]


def walk(doc, starts, regions, decide):
    """Each ranked unit in reading order, compared with the chain of the relations decided so far.
    Returns {line: relation} and the rows (unit line, features) the decisions were made on."""
    parent, chain_units, rows = {}, [], []
    previous, decided = None, {}
    for n in range(len(doc["ids"])):
        if starts[n] != 1 or regions[n] in UNRANKED:
            continue
        u = unit_values(doc, n, regions[n])
        chain, at = [], previous
        while at is not None and len(chain) < CHAIN:
            chain.append(at); at = parent.get(at)
        features = [regions[n], float(bool(u["family"])), u["depth"], u["x"], u["size"], float(u["bold"])]
        for k in range(CHAIN):
            a = chain[k] if k < len(chain) else None
            features += pair_features(u, unit_values(doc, a, regions[a]) if a is not None else None, (n - a) if a is not None else 0)
        relation = decide(n, features)
        rows.append((n, features))
        decided[n] = relation
        # The relation's parent, as the decoder resolves it.
        if previous is None or relation in (1, 9):
            parent[n] = None
        elif relation == 2:
            parent[n] = previous
        elif 4 <= relation <= 8:
            at = previous
            for _ in range(relation - 3):
                at = parent.get(at) if at is not None else None
            parent[n] = parent.get(at) if at is not None else None
        else:
            parent[n] = parent.get(previous)
        previous = n
    return decided, rows


def main():
    global F
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("labels", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    started = time.time()
    train, dev = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    F = json.loads((args.rows / "features.json").read_text())
    # Training: the gold's units and the chain its own relations make.
    xs, ys = [], []
    for doc in train:
        gold = [g if g is not None else [0, 0, 0, 0, 0] for g in doc["gold"]]
        starts, regions = [g[1] for g in gold], [g[0] for g in gold]
        relation = {n: g[2] for n, g in enumerate(gold)}
        _, rows = walk(doc, starts, regions, lambda n, f: relation[n] or 3)
        for n, features in rows:
            if relation[n] > 0:
                xs.append(features); ys.append(relation[n])
    x, y = np.asarray(xs, dtype=np.float32), np.asarray(ys)
    # Development, teacher-forced, for early stopping only.
    dx, dy = [], []
    for doc in dev:
        gold = [g if g is not None else [0, 0, 0, 0, 0] for g in doc["gold"]]
        relation = {n: g[2] for n, g in enumerate(gold)}
        _, rows = walk(doc, [g[1] for g in gold], [g[0] for g in gold], lambda n, f: relation[n] or 3)
        for n, features in rows:
            if relation[n] > 0:
                dx.append(features); dy.append(relation[n])
    model = lgb.LGBMClassifier(objective="multiclass", num_class=len(RELATIONS), n_estimators=2000, learning_rate=0.05,
                               num_leaves=63, min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.7,
                               n_jobs=-1, verbose=-1)
    model.fit(x, y, eval_set=[(np.asarray(dx, dtype=np.float32), np.asarray(dy))], categorical_feature=[0],
              callbacks=[lgb.early_stopping(50, verbose=False)])
    teacher = float(np.mean(model.predict(np.asarray(dx, dtype=np.float32)) == np.asarray(dy)))
    print(f"{len(y)} training units; teacher-forced development accuracy {teacher:.4f} ({model.best_iteration_} trees)", flush=True)
    # Development, end to end: the tagger's units, this model's own chain.
    labelled = {}
    for line in open(args.labels, encoding="utf-8"):
        row = json.loads(line); labelled[row["sha256"]] = row
    out = args.out / (args.labels.stem + "-relations.jsonl")
    correct = total = 0
    with open(out, "w", encoding="utf-8") as stream:
        for doc in dev:
            row = labelled[doc["sha256"]]
            labels = [list(l) for l in row["labels"]]
            decided, _ = walk(doc, [l[1] for l in labels], [l[0] for l in labels],
                              lambda n, f: int(model.predict(np.asarray([f], dtype=np.float32))[0]))
            for n, relation in decided.items():
                labels[n][2] = relation
                g = doc["gold"][n]
                if g is not None and g[1] == 1 and g[2] > 0:
                    total += 1; correct += relation == g[2]
            stream.write(json.dumps({"sha256": row["sha256"], "ids": row["ids"], "labels": labels}) + "\n")
    print(f"end-to-end development accuracy on gold unit starts the tagger also starts: {correct / max(total, 1):.4f} "
          f"({total}); wrote {out} in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
