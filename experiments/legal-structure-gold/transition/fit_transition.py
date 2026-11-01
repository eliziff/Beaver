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
# Of the ranker's lines, the share kept by a fixed draw, the latest round's and earlier rounds' (never by how
# easy a line is: keeping fewer of the lines where the local scores' first class is the oracle's taught the
# ranker that it mostly is not); and on each line kept, the oracle's move and at most CAP - 1 others, the local
# scores' likeliest.
LINE_KEEP = float(os.environ.get("LINE_KEEP", "0.4"))
OLDER_KEEP = float(os.environ.get("OLDER_KEEP", "0.15"))
CAP = int(os.environ.get("CAP", "6"))


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
    """Each line's gold class, -1 where the gold gives none or leaves its body region unmarked (101)."""
    gold = np.asarray(meta["gold"], dtype=np.int64).reshape(-1, 8)
    return np.where((gold[:, 0] >= 0) & (gold[:, 0] < 17), gold[:, 0] * 2 + (gold[:, 1] == 1), -1)


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
        x = lines(folder, m)
        if not len(x):
            continue
        p = np.asarray(model.predict(x)).reshape(len(x), -1).argmax(1)
        right += int((p[t >= 0] == t[t >= 0]).sum())
        total += int((t >= 0).sum())
    print(f"development move accuracy, the full forest: {right / max(total, 1):.4f} over {total} lines")


def fit_ranker(store, out, folders):
    Xs, ys, groups = [], [], []
    for round_, folder in enumerate(folders):
        older = round_ < len(folders) - 1
        gold_lines = reachable = 0
        for m in documents(folder, store, "train"):
            rows = moves(folder, m)
            oracle = np.asarray(m["move_oracle"], dtype=np.int8)
            line = np.asarray(m["move_lines"], dtype=np.int64)
            classes = np.asarray(m["move_classes"], dtype=np.int64)
            # Lines the oracle reads (some candidate is its move: the gold's class among the line's), each
            # line's candidates one group, a fixed draw of them.
            ruled = np.zeros(m["lines"], dtype=bool)
            ruled[line[oracle == 1]] = True
            gold_lines += int((target(m) >= 0).sum())
            reachable += int(ruled.sum())
            rng = np.random.default_rng(zlib.crc32(f"{round_}:{m['sha256']}".encode()))
            ruled &= rng.random(m["lines"]) < (OLDER_KEEP if older else LINE_KEEP)
            # On each line, the oracle's move and the likeliest others by the local scores (rows are a
            # line's candidates in turn; column 0 is the local log-probability).
            order = np.lexsort((-rows[:, 0], line))
            place = np.empty(len(line), dtype=np.int64)
            starts = np.r_[0, np.flatnonzero(np.diff(line[order])) + 1]
            ranks = np.arange(len(line)) - np.repeat(starts, np.diff(np.r_[starts, len(line)]))
            place[order] = ranks
            keep = ruled[line] & ((oracle == 1) | (place < CAP - 1))
            Xs.append(rows[keep])
            ys.append(oracle[keep])
            groups.append(np.bincount(line[keep], minlength=m["lines"])[ruled])
        print(f"{folder}: the gold's move among the candidates on {reachable / max(gold_lines, 1):.4f} of {gold_lines} gold lines", flush=True)
    X, y, group = np.vstack(Xs), np.concatenate(ys), np.concatenate(groups)
    print("ranker rows", len(y), "lines", len(group), flush=True)
    # Each line's softmax over its candidates' scores (the local log-probability plus the trees' correction),
    # its cross-entropy against the oracle's move: so a beam can sum the scores as log-probabilities. Written
    # out (LightGBM's rank_xendcg with the local score as its initial score diverged: corrections in the
    # thousands, the oracle's move ranked best on 0.01% of its own training lines).
    base = X[:, 0].astype(np.float64)
    starts = np.r_[0, np.cumsum(group)[:-1]]
    owner = np.repeat(np.arange(len(group)), group)

    def listwise(preds, _data):
        score = base + preds
        top = np.maximum.reduceat(score, starts)
        e = np.exp(score - top[owner])
        p = e / np.add.reduceat(e, starts)[owner]
        return p - y, np.maximum(p * (1 - p), 1e-6)

    params = dict(PARAMS, objective=listwise)
    model = lgb.train(params, lgb.Dataset(X, y), num_boost_round=ROUNDS)
    model.save_model(out)
    score = base + model.predict(X, raw_score=True)
    best = np.zeros(len(group), dtype=bool)
    best_row = starts + np.array([np.argmax(score[a:a + n]) for a, n in zip(starts, group)])
    print(f"ranker -> {out}; the oracle's move best on {np.mean(y[best_row] == 1):.4f} of its {len(group)} lines "
          f"(local scores alone {np.mean(y[starts + np.array([np.argmax(base[a:a + n]) for a, n in zip(starts, group)])] == 1):.4f})", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "local":
        fit_local(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        fit_ranker(sys.argv[2], sys.argv[3], sys.argv[4:])
