"""The transition parser's tables, fitted on what the parser itself dumped (LEGALPDF_TRANSITION_DUMP):
the local forests over each line's features (multiclass over region-and-opening classes), k of them on
train, fold<i> fitted on every document but those of fold i (CRC-32 of the sha256 mod k), which read it
(out of fold), and full.txt on all of train, which every other document reads; or the ranker over each candidate move's features (listwise: the oracle's move), from one
or more rollout dumps aggregated (DAgger), fitted from each candidate's local log-probability as its base
(init_score), so it scores the state's correction to the local score. Split by the gold store's partition. Models are LightGBM text,
which the parser reads (transition/trees.rs).
python fit_transition.py local DUMP_DIR GOLD_STORE OUT_DIR
python fit_transition.py ranker GOLD_STORE OUT_FILE DUMP_DIR [DUMP_DIR...]"""
import json, os, sys, zlib
import numpy as np
import lightgbm as lgb

PARAMS = dict(learning_rate=0.2, num_leaves=int(os.environ.get("LEAVES", "63")), min_data_in_leaf=40, max_bin=31, feature_fraction=0.5,
              bagging_fraction=0.5, bagging_freq=1, lambda_l2=1.0, num_threads=12, verbose=-1)
ROUNDS = int(os.environ.get("ROUNDS", "100"))
# Of the ranker's easy lines (one candidate of the oracle's class, the local scores' first), and of earlier
# rounds' rollouts, the shares kept by a fixed draw.
EASY_KEEP = float(os.environ.get("EASY_KEEP", "0.5"))
OLDER_KEEP = float(os.environ.get("OLDER_KEEP", "0.5"))


def partition(store, sha):
    try:
        return json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))["partition"]
    except (OSError, KeyError, ValueError):
        return None


def documents(folder, store, split):
    for name in sorted(os.listdir(folder)):
        if name.endswith(".json") and not name.endswith(".labels.json"):
            meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
            if partition(store, meta["sha256"]) == split:
                yield meta


def lines(folder, meta):
    return np.fromfile(os.path.join(folder, f"{meta['sha256']}.lines.f32"), dtype="<f4").reshape(meta["lines"], meta["line_width"])


def moves(folder, meta):
    rows = np.fromfile(os.path.join(folder, f"{meta['sha256']}.moves.f32"), dtype="<f4")
    return rows.reshape(-1, meta["move_width"])


def target(meta):
    gold = np.asarray(meta["gold"], dtype=np.int64).reshape(-1, 8)
    return np.where(gold[:, 0] >= 0, gold[:, 0] * 2 + (gold[:, 1] == 1), -1)


def fit_local(folder, store, out):
    os.makedirs(out, exist_ok=True)
    metas = list(documents(folder, store, "train"))
    folds = int(os.environ.get("FOLDS", "5"))
    # The commonest easy moves (text going on, a provision going on, a transcript's line number) are kept
    # at COMMON_KEEP of their lines by a fixed draw, weighted back, so a large train fits in memory.
    keep_common = float(os.environ.get("COMMON_KEEP", "1.0"))
    common = np.array([1 * 2, 16 * 2, 13 * 2 + 1])
    Xs, ys, ws, fs = [], [], [], []
    for m in metas:
        t = target(m)
        rng = np.random.default_rng(zlib.crc32(m["sha256"].encode()))
        easy = np.isin(t, common)
        keep = (t >= 0) & (~easy | (rng.random(len(t)) < keep_common))
        Xs.append(lines(folder, m)[keep])
        ys.append(t[keep])
        ws.append(np.where(easy[keep], 1.0 / keep_common, 1.0))
        fs.append(np.full(int(keep.sum()), zlib.crc32(m["sha256"].encode()) % folds))
    X, y, w, fold = np.vstack(Xs), np.concatenate(ys), np.concatenate(ws), np.concatenate(fs)
    del Xs
    print("local rows", len(y), flush=True)
    params = dict(PARAMS, objective="multiclass", num_class=34)
    for i in range(folds):
        mask = fold != i
        model = lgb.train(params, lgb.Dataset(X[mask], y[mask], weight=w[mask]), num_boost_round=ROUNDS)
        model.save_model(os.path.join(out, f"fold{i}.txt"))
        print(f"fitted fold{i}.txt", int(mask.sum()), "lines", flush=True)
    # The product's forest: one, fitted on all of train, which a document outside train reads (tier 0's
    # speed: one forest a line, not k averaged).
    model = lgb.train(params, lgb.Dataset(X, y, weight=w), num_boost_round=ROUNDS)
    model.save_model(os.path.join(out, "full.txt"))
    print("fitted full.txt", len(y), "lines", flush=True)
    del X
    dev = list(documents(folder, store, "development"))
    right = total = 0
    for m in dev:
        t = target(m)
        p = model.predict(lines(folder, m)).argmax(1)
        right += int((p[t >= 0] == t[t >= 0]).sum())
        total += int((t >= 0).sum())
    print(f"development move accuracy, the full forest: {right / max(total, 1):.4f} over {total} lines")


def fit_ranker(store, out, folders):
    Xs, ys, groups = [], [], []
    for round_, folder in enumerate(folders):
        # Earlier rounds' rollouts are kept at half their lines, the latest whole.
        older = round_ < len(folders) - 1
        gold_lines = reachable = 0
        for m in documents(folder, store, "train"):
            rows = moves(folder, m)
            oracle = np.asarray(m["move_oracle"], dtype=np.int8)
            line = np.asarray(m["move_lines"], dtype=np.int64)
            classes = np.asarray(m["move_classes"], dtype=np.int64)
            # Lines the oracle reads (some candidate is its move: the gold's class among the line's),
            # each line's candidates one group. A line whose oracle move is the only candidate of its
            # class, the local scores' first, has only the class to choose: half of those (by a fixed
            # draw), every other line.
            ruled = np.zeros(m["lines"], dtype=bool)
            ruled[line[oracle == 1]] = True
            gold_lines += int((target(m) >= 0).sum())
            reachable += int(ruled.sum())
            chosen_class = np.full(m["lines"], -1)
            chosen_class[line[oracle == 1]] = classes[oracle == 1]
            same_class = np.bincount(line[classes == chosen_class[line]], minlength=m["lines"])
            first = np.zeros(m["lines"], dtype=bool)
            first[line[(oracle == 1) & (rows[:, 1] == 0)]] = True
            easy = first & (same_class == 1)
            rng = np.random.default_rng(zlib.crc32(f"{round_}:{m['sha256']}".encode()))
            ruled &= ~easy | (rng.random(m["lines"]) < EASY_KEEP)
            if older:
                ruled &= rng.random(m["lines"]) < OLDER_KEEP
            keep = ruled[line]
            Xs.append(rows[keep])
            ys.append(oracle[keep])
            groups.append(np.bincount(line[keep], minlength=m["lines"])[ruled])
        print(f"{folder}: the gold's move among the candidates on {reachable / max(gold_lines, 1):.4f} of {gold_lines} gold lines", flush=True)
    X, y, group = np.vstack(Xs), np.concatenate(ys), np.concatenate(groups)
    print("ranker rows", len(y), "lines", len(group), flush=True)
    # A listwise objective (cross-entropy of each line's softmax over its candidates), so a beam can sum
    # its scores as log-probabilities.
    params = dict(PARAMS, objective="rank_xendcg")
    model = lgb.train(params, lgb.Dataset(X, y, group=group, init_score=X[:, 0]), num_boost_round=ROUNDS)
    model.save_model(out)
    print("ranker ->", out)


if __name__ == "__main__":
    if sys.argv[1] == "local":
        fit_local(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        fit_ranker(sys.argv[2], sys.argv[3], sys.argv[4:])
