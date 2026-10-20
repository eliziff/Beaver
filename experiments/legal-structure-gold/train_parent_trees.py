"""Parents by gradient-boosted ranking over each unit start's candidates, from `structure-gold rows`.

  python train_parent_trees.py ROWS_DIR LABELS.jsonl --out OUT.jsonl [--keep-parser-notes]

Each unit start's candidates are the unit starts before it in reach and none; each pair carries
the pointer tagger's pair evidence (train_tagger.Starts: indentation, type and its rank in the
document, numbering, distance, the parser's choice, closing, language) and the unit's own type.
LightGBM's lambdarank learns the gold's parent among them on train (the gold's own unit starts)
with early stopping on development; development accuracy over the gold's unit starts is reported
beside the parser's. Then each unit start of LABELS.jsonl (regions and starts, as train_trees.py
writes them) is pointed at its best candidate among that file's own unit starts, and the result
written to OUT.jsonl for `structure-gold grade --labels`. Test is never read.
"""
import argparse
import json
import random
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np

from train_tagger import REACH, REGIONS, Document, Starts, Vocab, gold_starts, load

QUERY = 12


def own(doc, queries):
    """The unit's own evidence, beside each of its pairs: tier-0 region, type, its rank, place."""
    q = np.asarray(queries)
    region = doc.tier0[q, 0]
    return np.stack([region == 1, region == 2, region == 3, region == 4, doc.pair[q, 2], doc.pair[q, 4], doc.pair[q, 1],
                     np.minimum(doc.loose_id[q], 10) / 10.0, doc.family_rank[q] >= 0, doc.pair[q, 7], doc.language[q],
                     doc.pair[q, 10] / max(float(doc.pair[:, 10].max()), 1.0)], axis=1).astype(np.float32)


def candidates(doc, rows, queries):
    """Per query: its pairs' evidence (reach + none) and their rows (-1 for none)."""
    starts = Starts(doc, rows, queries, "cpu")
    pair = starts.pair.numpy()
    q, w, f = pair.shape
    none = np.zeros((q, 1, f), dtype=np.float32)
    flags = np.concatenate([np.zeros((q, w, 1), np.float32), np.ones((q, 1, 1), np.float32)], axis=1)
    features = np.concatenate([np.concatenate([pair, none], axis=1), flags,
                               np.repeat(own(doc, queries)[:, None, :], w + 1, axis=1)], axis=2)
    columns = np.concatenate([starts.candidates, -np.ones((q, 1), np.int64)], axis=1)
    valid = np.concatenate([starts.candidates >= 0, np.ones((q, 1), bool)], axis=1)
    return features, columns, valid


def matrix(docs, rng, keep_negatives):
    """Ranking rows: per gold query, the gold parent, none, the nearest candidates and a sample."""
    xs, ys, groups = [], [], []
    for doc in docs:
        rows, queries = gold_starts(doc)
        for k in range(0, len(queries), 1024):
            chunk = queries[k:k + 1024]
            features, columns, valid = candidates(doc, rows, chunk)
            for i, query in enumerate(chunk):
                parent = int(doc.gold[query, 5])
                hit = np.nonzero(columns[i] == parent)[0] if parent >= 0 else np.asarray([REACH])
                if len(hit) == 0:
                    continue
                pick = np.nonzero(valid[i])[0]
                if keep_negatives is not None and len(pick) > keep_negatives:
                    near = pick[pick < 24]
                    rest = pick[pick >= 24]
                    sample = rng.sample(list(rest), min(len(rest), keep_negatives - len(near)))
                    pick = np.unique(np.concatenate([near, sample, hit, [REACH]]).astype(np.int64))
                xs.append(features[i, pick])
                ys.append((pick == hit[0]).astype(np.int64))
                groups.append(len(pick))
    return np.concatenate(xs), np.concatenate(ys), np.asarray(groups)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("labels", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--keep-parser-notes", action="store_true")
    parser.add_argument("--jobs", type=int, default=-1)
    args = parser.parse_args()
    started = time.time()
    names = json.loads((args.rows / "features.json").read_text())
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    vocabs = (Vocab(t[1] for d in train_raw for t in d["text"]), Vocab(t[2] for d in train_raw for t in d["text"]),
              Vocab(t[3] for d in train_raw for t in d["text"]))
    stacked = np.concatenate([np.asarray(d["features"], dtype=np.float32) for d in train_raw])
    mean, std = stacked.mean(axis=0), stacked.std(axis=0) + 1e-6
    train = [Document(d, names, vocabs, mean, std) for d in train_raw]
    dev = [Document(d, names, vocabs, mean, std) for d in dev_raw]
    rng = random.Random(7)
    x, y, groups = matrix(train, rng, 64)
    dx, dy, dgroups = matrix(dev, rng, 64)
    print(f"{len(groups)} train / {len(dgroups)} development queries, {len(y)} / {len(dy)} pairs, "
          f"{x.shape[1]} columns, in {time.time() - started:.0f}s", flush=True)
    model = lgb.LGBMRanker(objective="lambdarank", n_estimators=2000, learning_rate=0.05, num_leaves=63,
                           min_child_samples=50, subsample=0.8, subsample_freq=1, colsample_bytree=0.7,
                           lambdarank_truncation_level=8, n_jobs=args.jobs, verbose=-1)
    model.fit(x, y, group=groups, eval_set=[(dx, dy)], eval_group=[dgroups], eval_at=[1],
              callbacks=[lgb.early_stopping(50, verbose=False)])
    print(f"{model.best_iteration_} trees in {time.time() - started:.0f}s", flush=True)
    # Development over the gold's own unit starts, every candidate in reach.
    right = asked = parser_right = 0
    for doc in dev:
        rows, queries = gold_starts(doc)
        for k in range(0, len(queries), 1024):
            chunk = queries[k:k + 1024]
            features, columns, valid = candidates(doc, rows, chunk)
            scores = model.predict(features.reshape(-1, features.shape[2])).reshape(valid.shape)
            choice = np.where(valid, scores, -np.inf).argmax(axis=1)
            for i, query in enumerate(chunk):
                asked += 1
                right += int(columns[i, choice[i]]) == int(doc.gold[query, 5])
                parser_right += int(doc.tier0[query, 5]) == int(doc.gold[query, 5])
    print(f"development parents over the gold's unit starts: parser {parser_right / asked:.4f}, trees {right / asked:.4f} ({asked})",
          flush=True)
    given = {}
    for line in open(args.labels, encoding="utf-8"):
        row = json.loads(line)
        given[row["sha256"]] = np.asarray(row["labels"], dtype=np.int64)
    note = REGIONS.index("note")
    with open(args.out, "w", encoding="utf-8") as stream:
        for raw, doc in zip(dev_raw, dev):
            labels = given[raw["sha256"]].copy()
            if args.keep_parser_notes:
                notes = (doc.tier0[:, 0] == note) | (labels[:, 0] == note)
                labels[notes, :2] = doc.tier0[notes, :2]
                labels[:, 3] = doc.tier0[:, 3]
            labels[labels[:, 0] == 0, 1] = 0
            labels[:, 5:] = -1
            rows = np.nonzero((labels[:, 1] == 1) & (labels[:, 0] > 0))[0]
            for k in range(0, len(rows), 1024):
                chunk = [int(r) for r in rows[k:k + 1024]]
                features, columns, valid = candidates(doc, rows, chunk)
                scores = model.predict(features.reshape(-1, features.shape[2])).reshape(valid.shape)
                choice = np.where(valid, scores, -np.inf).argmax(axis=1)
                for i, query in enumerate(chunk):
                    labels[query, 5] = int(columns[i, choice[i]])
            latest = {}
            for n in range(doc.length):
                if labels[n, 1] == 2:
                    labels[n, 6] = latest.get(int(labels[n, 0]), -1)
                    if labels[n, 6] < 0:
                        labels[n, 1] = 1
                if labels[n, 1] == 1:
                    latest[int(labels[n, 0])] = n
            stream.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": labels.tolist()}) + "\n")
    print(f"done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
