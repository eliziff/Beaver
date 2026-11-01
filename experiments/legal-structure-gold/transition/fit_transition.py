"""The transition parser's tables, fitted on what the parser itself dumped (LEGALPDF_TRANSITION_DUMP):
the local forests over each line's features (multiclass over region-and-opening classes), k of them on
train, fold<i> fitted on every document but those of fold i (CRC-32 of the sha256 mod k), which read it
(out of fold), and full.txt on all of train, which every other document reads; or the ranker over each candidate move's features (listwise: the oracle's move), from one
or more rollout dumps aggregated (DAgger), fitted from each candidate's local log-probability as its base
(init_score), so it scores the state's correction to the local score. Split by the gold store's partition. Models are LightGBM text,
which the parser reads (transition/trees.rs).
python fit_transition.py local DUMP_DIR GOLD_STORE OUT_DIR
python fit_transition.py ranker GOLD_STORE OUT_FILE DUMP_DIR [DUMP_DIR...]
python fit_transition.py prior GOLD_STORE OUT_FILE DUMP_DIR [DUMP_DIR...]"""
import json, os, sys, zlib
import numpy as np
import lightgbm as lgb

PARAMS = dict(learning_rate=0.2, num_leaves=int(os.environ.get("LEAVES", "63")), min_data_in_leaf=40, max_bin=31, feature_fraction=0.5,
              bagging_fraction=0.5, bagging_freq=1, lambda_l2=1.0, num_threads=12, verbose=-1)
ROUNDS = int(os.environ.get("ROUNDS", "100"))
# Of the ranker's lines, the share kept by a fixed draw, the latest round's and earlier rounds', every candidate
# of a line kept: never lines by how easy they are (keeping fewer of the lines where the local scores' first class
# is the oracle's taught the ranker that it mostly is not), and never a line's likeliest candidates alone (the
# ranker never saw the unlikely ones, and at the parse its corrections lifted them over the oracle's: 0.37 of a
# document's own lines read right, where every candidate kept reads 0.92 of development's).
LINE_KEEP = float(os.environ.get("LINE_KEEP", "0.25"))
OLDER_KEEP = float(os.environ.get("OLDER_KEEP", "0.08"))
CAP = int(os.environ.get("CAP", "100000"))
# The label sources whose documents the ranker is not fitted on (comma-separated; the forests read them still).
RANKER_SKIP = {s for s in os.environ.get("RANKER_SKIP", "").split(",") if s}


def partition(store, sha):
    try:
        return json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))["partition"]
    except (OSError, KeyError, ValueError):
        return None


def label_source(store, sha):
    try:
        return json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8")).get("label_source")
    except (OSError, ValueError):
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
    """The ranker, a tenth of train's documents (CRC-32 of the sha256 mod 10 is 0) held out: the fit stops where
    their loss stops falling, and reports how often each set's oracle move is the best."""
    # Two passes, so the rows are held once: each document's kept rows planned from its moves' metadata,
    # then read into the train and held-out arrays allocated for them (39.8 million rows stacked from
    # pieces needed twice their size).
    plans = []
    for round_, folder in enumerate(folders):
        older = round_ < len(folders) - 1
        gold_lines = reachable = 0
        for m in documents(folder, store, "train"):
            if label_source(store, m["sha256"]) in RANKER_SKIP:
                continue
            oracle = np.asarray(m["move_oracle"], dtype=np.int8)
            line = np.asarray(m["move_lines"], dtype=np.int64)
            # Lines the oracle reads (some candidate is its move: the gold's class among the line's), each
            # line's candidates one group, a fixed draw of them, every candidate of a line kept.
            ruled = np.zeros(m["lines"], dtype=bool)
            ruled[line[oracle == 1]] = True
            gold_lines += int((target(m) >= 0).sum())
            reachable += int(ruled.sum())
            rng = np.random.default_rng(zlib.crc32(f"{round_}:{m['sha256']}".encode()))
            ruled &= rng.random(m["lines"]) < (OLDER_KEEP if older else LINE_KEEP)
            keep = ruled[line]
            plans.append((folder, m["sha256"], m["move_width"], keep, oracle[keep],
                          np.bincount(line[keep], minlength=m["lines"])[ruled], zlib.crc32(m["sha256"].encode()) % 10 == 0))
        print(f"{folder}: the gold's move among the candidates on {reachable / max(gold_lines, 1):.4f} of {gold_lines} gold lines", flush=True)
    width = plans[0][2]

    def fill(which):
        chosen = [p for p in plans if p[6] == which]
        X = np.empty((sum(int(p[3].sum()) for p in chosen), width), dtype=np.float32)
        at = 0
        for folder, sha, _, keep, _, _, _ in chosen:
            rows = np.fromfile(os.path.join(folder, f"{sha}.moves.f32"), dtype="<f4").reshape(-1, width)[keep]
            X[at:at + len(rows)] = rows
            at += len(rows)
        return X, np.concatenate([p[4] for p in chosen]), np.concatenate([p[5] for p in chosen])
    (X, y, group), (Xv, yv, groupv) = fill(False), fill(True)
    print("ranker rows", len(y), "lines", len(group), "held out rows", len(yv), "lines", len(groupv), flush=True)
    # Each line's softmax over its candidates' scores (the local log-probability plus the trees' correction),
    # its cross-entropy against the oracle's move: so a beam can sum the scores as log-probabilities. Written
    # out (LightGBM's rank_xendcg with the local score as its initial score diverged: corrections in the
    # thousands, the oracle's move ranked best on 0.01% of its own training lines).
    def softmax(score, starts, owner):
        top = np.maximum.reduceat(score, starts)
        e = np.exp(score - top[owner])
        return e / np.add.reduceat(e, starts)[owner]

    def layout(X, group):
        starts = np.r_[0, np.cumsum(group)[:-1]]
        return X[:, 0].astype(np.float64), starts, np.repeat(np.arange(len(group)), group)

    base, starts, owner = layout(X, group)
    base_v, starts_v, owner_v = layout(Xv, groupv)

    def listwise(preds, _data):
        p = softmax(base + preds, starts, owner)
        return p - y, np.maximum(p * (1 - p), 1e-6)

    def held_loss(preds, _data):
        p = softmax(base_v + preds, starts_v, owner_v)
        return "held_listwise", float(-np.log(np.maximum(p[yv == 1], 1e-12)).sum() / len(groupv)), False

    # Each line's softmax over its candidates' scores (the local log-probability plus the trees' correction),
    # its cross-entropy against the oracle's move, so a beam can sum the scores as log-probabilities. Written
    # out: LightGBM's rank_xendcg with the local score as its initial score diverged. Leaf outputs capped and
    # each leaf holding real hessian mass: a confident line's tiny hessian made Newton steps in the hundreds,
    # which fit train's lines and read development's worse than the local scores alone.
    params = dict(PARAMS, objective=listwise, metric="None", max_delta_step=2.0, min_sum_hessian_in_leaf=1.0, lambda_l2=10.0)
    model = lgb.train(params, lgb.Dataset(X, y), num_boost_round=ROUNDS, valid_sets=[lgb.Dataset(Xv, yv)], feval=held_loss,
                      callbacks=[lgb.early_stopping(10, verbose=False), lgb.log_evaluation(10)])
    model.save_model(out, num_iteration=model.best_iteration)

    def best_share(y, base, starts, group, preds):
        score = base + preds
        pick = lambda s: np.maximum.reduceat(np.where(s == np.repeat(np.maximum.reduceat(s, starts), group), np.arange(len(s)), -1), starts)
        return np.mean(y[pick(score)] == 1), np.mean(y[pick(base)] == 1)

    for name, (Xs_, ys_, bs, ss, gs) in [("train", (X, y, base, starts, group)), ("held out", (Xv, yv, base_v, starts_v, groupv))]:
        ranked, local = best_share(ys_, bs, ss, gs, model.predict(Xs_, raw_score=True, num_iteration=model.best_iteration))
        print(f"{name}: the oracle's move best on {ranked:.4f} of its {len(gs)} lines, the local scores alone {local:.4f}", flush=True)
    print(f"ranker -> {out} ({model.best_iteration} rounds)", flush=True)


def gold_levels(gold):
    """Each heading opening's level in the gold, its steps chained (-1 elsewhere or where the gold gives none)."""
    out, current = np.full(len(gold), -1), 0
    for k, g in enumerate(gold):
        if g[2] == 1:
            current = 0
        if g[0] == 3 and g[1] == 1:
            if g[4] < 0:
                current = 0
                continue
            current = int(np.clip(max(current, 1) + g[4] - 10, 1, 9))
            out[k] = current
    return out


def fit_prior(store, out, folders):
    """The template prior of the joint stylesheet solve (transition/joint.rs): over each held template's measures
    (`template_rows`), its role in the gold, no heading (0) where under half its lines the gold reads are headings,
    else its heading openings' commonest level (1 to 9); each template weighted by its lines, as the solve weighs
    it. A2AJ's documents, whose gold leaves headings' levels out, are not read; a tenth of train's held out, the fit
    stopping where their loss stops falling; development's accuracy reported where a dump holds it."""
    sets = {"train": ([], [], []), "held out": ([], [], []), "development": ([], [], [])}
    for folder in folders:
        for split in ("train", "development"):
            for m in documents(folder, store, split):
                if label_source(store, m["sha256"]) == "a2aj-align" or "template_rows" not in m:
                    continue
                gold = np.asarray(m["gold"], dtype=np.int64).reshape(-1, 8)
                template = np.asarray(m["templates"])
                levels = gold_levels(gold)
                which = "development" if split == "development" else ("held out" if zlib.crc32(m["sha256"].encode()) % 10 == 0 else "train")
                X, y, w = sets[which]
                for t in m["held"]:
                    here = (template == t) & (gold[:, 0] >= 0)
                    if not here.any():
                        continue
                    if (gold[here, 0] == 3).mean() < 0.5:
                        role = 0
                    else:
                        found = levels[here & (levels > 0)]
                        if not len(found):
                            continue
                        role = int(np.bincount(found).argmax())
                    X.append(m["template_rows"][t])
                    y.append(role)
                    w.append(float(here.sum()))
    arrays = {k: (np.asarray(X, dtype=np.float32).reshape(-1, len(sets["train"][0][0])), np.asarray(y), np.asarray(w)) for k, (X, y, w) in sets.items() if y}
    for k, (X, y, w) in arrays.items():
        print(f"prior {k}: {len(y)} templates, roles {np.bincount(y, minlength=10).tolist()}", flush=True)
    X, y, w = arrays["train"]
    Xv, yv, wv = arrays["held out"]
    params = dict(PARAMS, objective="multiclass", num_class=10, num_leaves=15, min_data_in_leaf=20, learning_rate=0.05)
    model = lgb.train(params, lgb.Dataset(X, y, weight=w), num_boost_round=1000, valid_sets=[lgb.Dataset(Xv, yv, weight=wv)],
                      callbacks=[lgb.early_stopping(30, verbose=False)])
    model.save_model(out, num_iteration=model.best_iteration)
    for k, (Xk, yk, wk) in arrays.items():
        p = model.predict(Xk, num_iteration=model.best_iteration).argmax(1)
        print(f"prior {k}: role right on {np.mean(p == yk):.4f} of templates, {np.sum(wk * (p == yk)) / wk.sum():.4f} of their lines", flush=True)
    print(f"prior -> {out} ({model.best_iteration} rounds)", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "local":
        fit_local(sys.argv[2], sys.argv[3], sys.argv[4])
    elif sys.argv[1] == "prior":
        fit_prior(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        fit_ranker(sys.argv[2], sys.argv[3], sys.argv[4:])
