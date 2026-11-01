"""The whole reading's heads (transition/whole.rs), fitted on its dumps (LEGALPDF_TRANSITION_WHOLE_DUMP): a number's
role (multiclass: no number, or the opening of a paragraph, a provision, a list item, a quotation, a heading,
another unit), a link between two numbers and a reference mark's pair with a note label (binary, log-odds), and a heading's level given
the open heading's (multiclass, levels 1 to 9), a body unit's depth given the open depth
(multiclass, depths 1 to 9) and a line's opening a constituent document (binary), each over
the features the whole document's candidates give. Train's documents by the gold store's partition, a tenth of them
(CRC-32 of the sha256 mod 10 is 0) held out for the fit's stopping; development's, where dumped, reported. Each forest is
LightGBM text, as the parser reads it (number.txt, link.txt, pair.txt, outline.txt, start.txt, depth.txt).
With FOLDS=k, also k fold heads in OUT_DIR/fold<i>, each fitted on train's documents but those of its fold
(CRC-32 of the sha256 mod k), which the problems' dump reads them by, so the weights train on scores the heads
give documents they never saw.
python fit_whole.py GOLD_STORE OUT_DIR DUMP_DIR [DUMP_DIR...]"""
import json, os, sys, zlib
import numpy as np
import lightgbm as lgb

store, out, folders = sys.argv[1], sys.argv[2], sys.argv[3:]
PARAMS = dict(learning_rate=0.05, num_leaves=31, min_data_in_leaf=20, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1,
              lambda_l2=1.0, num_threads=8, verbose=-1)
HEADS = [("number", "numbers", "number_gold", 7), ("link", "links", "link_gold", 2), ("pair", "pairs", "pair_gold", 2), ("outline", "outline", "outline_gold", 10),
         ("start", "starts", "start_gold", 2), ("depth", "depths", "depth_gold", 10)]


def partition(sha):
    try:
        return json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))["partition"]
    except (OSError, KeyError, ValueError):
        return None


FOLDS = int(os.environ.get("FOLDS", "0"))
sets = {head: {"train": ([], []), "held out": ([], []), "development": ([], [])} for head, *_ in HEADS}
fold_of = {head: {"train": [], "held out": []} for head, *_ in HEADS}
for folder in folders:
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".whole.json"):
            continue
        doc = json.load(open(os.path.join(folder, name), encoding="utf-8"))
        split = partition(doc["sha256"])
        which = "development" if split == "development" else ("held out" if zlib.crc32(doc["sha256"].encode()) % 10 == 0 else "train") if split == "train" else None
        if which is None:
            continue
        for head, rows, gold, _ in HEADS:
            for row, answer in zip(doc[rows], doc[gold]):
                if answer >= 0:
                    sets[head][which][0].append(row)
                    sets[head][which][1].append(answer)
                    if which in fold_of[head]:
                        fold_of[head][which].append(zlib.crc32(doc["sha256"].encode()) % max(FOLDS, 1))
os.makedirs(out, exist_ok=True)
for head, _, _, classes in HEADS:
    data = {k: (np.asarray(x, dtype=np.float32), np.asarray(y)) for k, (x, y) in sets[head].items() if y}
    for k, (x, y) in data.items():
        print(f"{head} {k}: {len(y)} rows, answers {np.bincount(y, minlength=classes).tolist()}", flush=True)
    if "train" not in data or "held out" not in data:
        print(f"{head}: no data", flush=True)
        continue
    params = dict(PARAMS, objective="multiclass", num_class=classes) if classes > 2 else dict(PARAMS, objective="binary")
    (x, y), (xv, yv) = data["train"], data["held out"]
    model = lgb.train(params, lgb.Dataset(x, y), num_boost_round=2000, valid_sets=[lgb.Dataset(xv, yv)],
                      callbacks=[lgb.early_stopping(50, verbose=False)])
    model.save_model(os.path.join(out, f"{head}.txt"), num_iteration=model.best_iteration)
    for k, (xk, yk) in data.items():
        p = model.predict(xk, num_iteration=model.best_iteration)
        guess = p.argmax(1) if classes > 2 else (p > 0.5).astype(int)
        if classes > 2:
            print(f"{head} {k}: right {np.mean(guess == yk):.4f}; per role recall " + " ".join(f"{c}:{np.mean(guess[yk == c] == c):.3f}" for c in range(classes) if (yk == c).any()), flush=True)
        else:
            tp = int(((guess == 1) & (yk == 1)).sum())
            prec, rec = tp / max(int(guess.sum()), 1), tp / max(int(yk.sum()), 1)
            print(f"{head} {k}: P {prec:.4f} R {rec:.4f} F1 {2 * prec * rec / max(prec + rec, 1e-9):.4f}", flush=True)
    print(f"{head} -> {out} ({model.best_iteration} rounds)", flush=True)
    for i in range(FOLDS):
        keep, keep_v = np.asarray(fold_of[head]["train"]) != i, np.asarray(fold_of[head]["held out"]) != i
        fold = lgb.train(params, lgb.Dataset(x[keep], y[keep]), num_boost_round=2000, valid_sets=[lgb.Dataset(xv[keep_v], yv[keep_v])],
                         callbacks=[lgb.early_stopping(50, verbose=False)])
        os.makedirs(os.path.join(out, f"fold{i}"), exist_ok=True)
        fold.save_model(os.path.join(out, f"fold{i}", f"{head}.txt"), num_iteration=fold.best_iteration)
        print(f"{head} fold{i}: {int(keep.sum())} rows, {fold.best_iteration} rounds", flush=True)
