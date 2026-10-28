"""The rows lab: the parser's pieces with their evidence, tier 0's labels and the gold's, loaded once
(cached as a pickle), scored by unit F1 per region and mode the way the census reads units, so a
candidate labelling can be measured in seconds.

  python lab.py ROWS_DIR baseline            tier 0's unit F1 per region and mode, both splits
  python lab.py ROWS_DIR trails              which heading passes earn their keep (TP/FP by trail)
  python lab.py ROWS_DIR importance          LightGBM over the evidence for heading starts: what matters
"""
import collections
import json
import os
import pickle
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
R = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
     "marginal_note", "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
RI = {name: k for k, name in enumerate(R)}
NAMES = None


def load(root, split):
    """Documents of a split: dicts of arrays, cached beside the rows."""
    global NAMES
    NAMES = json.load(open(rf"{root}\features.json"))
    cache = rf"{root}\rows-{split}.pkl"
    if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(rf"{root}\rows-{split}.jsonl"):
        return pickle.load(open(cache, "rb"))
    docs = []
    for line in open(rf"{root}\rows-{split}.jsonl", encoding="utf-8"):
        doc = json.loads(line)
        n = len(doc["text"])
        gold = doc["gold"]
        docs.append({
            "sha": doc["sha256"], "mode": doc.get("mode", "?"), "pages": np.asarray(doc["pages"], dtype=np.int32), "ids": doc["ids"],
            "X": np.asarray(doc["features"], dtype=np.float32),
            "text": [t[0] for t in doc["text"]], "region_type": [t[1] for t in doc["text"]],
            "family": [t[3] for t in doc["text"]], "trail": [t[4] for t in doc["text"]],
            "look": np.asarray(doc["look"], dtype=np.int32),
            "r0": np.asarray([t[0] for t in doc["tier0"]], dtype=np.int8), "s0": np.asarray([t[1] for t in doc["tier0"]], dtype=np.int8),
            "rg": np.asarray([g[0] if g else -1 for g in gold], dtype=np.int8), "sg": np.asarray([g[1] if g else -1 for g in gold], dtype=np.int8),
            "lg": np.asarray([g[4] if g else 0 for g in gold], dtype=np.int8),
        })
    pickle.dump(docs, open(cache, "wb"), protocol=5)
    return docs


def units(region, start):
    """(region, first, last) runs: a start opens one, an inside piece of the open unit's region extends it."""
    out, open_ = [], None
    for k in range(len(region)):
        r, s = int(region[k]), int(start[k])
        if r <= 0:
            continue
        if s != 0 or open_ is None or open_[0] != r:
            if open_:
                out.append(tuple(open_))
            open_ = [r, k, k]
        else:
            open_[2] = k
    if open_:
        out.append(tuple(open_))
    return out


BODY = {RI["text"], RI["provision"], RI["list_item"]}


def score(docs, labels, kinds=("heading", "body", "quote", "list_item", "note", "table")):
    """Unit F1 per kind and mode of a labelling `labels(doc) -> (region, start)`; body pools text,
    provision and list items as the grader does; a unit matches on its pieces and its kind."""
    tally = collections.defaultdict(lambda: [0, 0, 0])  # (kind, mode) -> expected, predicted, correct
    for doc in docs:
        region, start = labels(doc)
        gold = set(units(doc["rg"], doc["sg"]))
        pred = set(units(region, start))
        for kind in kinds:
            if kind == "body":
                g = {(-2, a, b) for r, a, b in gold if r in BODY}
                p = {(-2, a, b) for r, a, b in pred if r in BODY}
            else:
                g = {u for u in gold if u[0] == RI[kind]}
                p = {u for u in pred if u[0] == RI[kind]}
            for mode in (doc["mode"], "all"):
                t = tally[(kind, mode)]
                t[0] += len(g); t[1] += len(p); t[2] += len(g & p)
    return tally


def f1(t):
    e, p, c = t
    return 2 * c / max(e + p, 1), c / max(p, 1), c / max(e, 1)


def table(name, tallies, kinds=("heading", "body", "quote", "list_item", "note", "table")):
    print(f"\n{name}")
    print(f"  {'kind':10} " + "  ".join(f"{mode:>22}" for mode in ("all", "digitalborn", "ocr")))
    for kind in kinds:
        cells = []
        for mode in ("all", "digitalborn", "ocr"):
            f, p, r = f1(tallies[(kind, mode)])
            cells.append(f"{f:.3f} (P{p:.2f} R{r:.2f})")
        print(f"  {kind:10} " + "  ".join(f"{c:>22}" for c in cells))


def tier0(doc):
    return doc["r0"], doc["s0"]


def neighbours(doc, X):
    """The evidence of the piece before and after (zeros at a page's edge), beside the piece's own."""
    prev = np.zeros_like(X); nxt = np.zeros_like(X)
    if len(X) > 1:
        pages = doc["pages"]
        same_prev = np.concatenate([[False], pages[1:] == pages[:-1]])
        same_next = np.concatenate([pages[:-1] == pages[1:], [False]])
        prev[1:] = X[:-1]; nxt[:-1] = X[1:]
        prev[~same_prev] = 0; nxt[~same_next] = 0
    return np.hstack([X, prev, nxt])


if __name__ == "__main__":
    root, command = sys.argv[1], sys.argv[2]
    if command == "baseline":
        for split in ("train", "development"):
            docs = load(root, split)
            table(f"tier 0, {split} ({len(docs)} docs)", score(docs, tier0))
    elif command == "trails":
        docs = load(root, "development")
        by = collections.defaultdict(lambda: [0, 0, 0, 0])  # trail -> TP, FP, FN, TN (lines a pass touched that are no heading and end as none)
        for doc in docs:
            for k in range(len(doc["text"])):
                if doc["rg"][k] < 0:
                    continue
                g = doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1
                p = doc["r0"][k] == RI["heading"] and doc["s0"][k] == 1
                t = doc["trail"][k] or "(none)"
                if not (g or p or t != "(none)"):
                    continue
                by[t][0 if g and p else 1 if p else 2 if g else 3] += 1
        print(f"  {'trail':48} {'TP':>6} {'FP':>6} {'FN':>6} {'TN':>6}")
        for trail, counts in sorted(by.items(), key=lambda kv: -sum(kv[1]))[:40]:
            print(f"  {trail:48} " + " ".join(f"{c:6}" for c in counts))
    elif command == "missed":
        # The evidence of gold heading starts no pass proposed, beside those proposed and beside body lines.
        docs = load(root, "development")
        f = {n: k for k, n in enumerate(NAMES)}
        groups = collections.defaultdict(list)
        for doc in docs:
            for k in range(len(doc["text"])):
                g = doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1
                if doc["rg"][k] < 0:
                    continue
                if g and not doc["trail"][k]:
                    key = ("missed heading", doc["mode"])
                elif g:
                    key = ("proposed heading", doc["mode"])
                elif doc["rg"][k] == RI["text"] and doc["sg"][k] == 1:
                    key = ("text start", doc["mode"])
                else:
                    continue
                groups[key].append((doc["X"][k], doc["region_type"][k]))
        cues = ["bold", "size", "upper", "length", "gap_above", "gap_below", "width", "centre", "indent", "look_share", "look_lines", "ends_period", "starts_digit", "ocr", "underlined", "italic", "body_style"]
        for key in sorted(groups):
            rows = np.vstack([x for x, _ in groups[key]])
            regions = collections.Counter(r for _, r in groups[key])
            print(f"\n{key[0]} / {key[1]}: {len(rows)} pieces; parser region_type {regions.most_common(5)}")
            print("  " + "  ".join(f"{c}={np.median(rows[:, f[c]]):.2f}" for c in cues))
            print("  shares: " + "  ".join(f"{c}>0.5:{(rows[:, f[c]] > 0.5).mean():.2f}" for c in ("bold", "upper", "underlined", "italic", "body_style", "ends_period"))
                  + f"  size>1.1:{(rows[:, f['size']] > 1.1).mean():.2f}  width<0.6:{(rows[:, f['width']] < 0.6).mean():.2f}  gap_above>0.5:{(rows[:, f['gap_above']] > 0.5).mean():.2f}  gap_below>0.5:{(rows[:, f['gap_below']] > 0.5).mean():.2f}  length<0.75:{(rows[:, f['length']] < 0.75).mean():.2f}")
    elif command == "lexicon":
        # Heading words, out of fold: each word's log-odds of opening a heading, unconditioned and
        # conditioned on the gold's document type (an oracle for type detection), as three features
        # each over the base evidence; the yardstick says whether either transfers.
        import lightgbm as lgb
        import re
        train, dev = load(root, "train"), load(root, "development")
        types = json.load(open(sys.argv[3], encoding="utf-8"))
        def doc_type(d):
            by = collections.Counter()
            for kind, _, lines in types.get(d["sha"], []):
                by[kind] += lines
            return by.most_common(1)[0][0] if by else "other"
        token = re.compile(r"[^\W\d_]{2,}")
        folds = {d["sha"]: n % 5 for n, d in enumerate(train)}
        def counts(docs):
            heads, total = collections.Counter(), collections.Counter()
            for d in docs:
                t = doc_type(d)
                for k in range(len(d["text"])):
                    if d["rg"][k] < 0:
                        continue
                    g = d["rg"][k] == RI["heading"] and d["sg"][k] == 1
                    for w in set(x.lower() for x in token.findall(d["text"][k])):
                        total[w] += 1; heads[w] += g
                        total[(t, w)] += 1; heads[(t, w)] += g
            return heads, total
        all_heads, all_total = counts(train)
        fold_counts = {f: counts([d for d in train if folds[d["sha"]] != f]) for f in range(5)}
        base = sum(v for k, v in all_heads.items() if isinstance(k, str)) / max(sum(v for k, v in all_total.items() if isinstance(k, str)), 1)
        def odds(heads, total, key):
            return np.log((heads[key] + 2 * base) / (total[key] - heads[key] + 2 * (1 - base)))
        def extra(d, conditioned):
            heads, total = fold_counts[folds[d["sha"]]] if d["sha"] in folds else (all_heads, all_total)
            t = doc_type(d)
            out = np.zeros((len(d["text"]), 3), dtype=np.float32)
            for k in range(len(d["text"])):
                ws = [w.lower() for w in token.findall(d["text"][k])]
                if ws:
                    o = [odds(heads, total, (t, w) if conditioned else w) for w in ws]
                    out[k] = (np.mean(o), np.max(o), np.min(o))
            return out
        for variant in ("base", "unconditioned", "by type (oracle)"):
            def frame(docs):
                docs = [d for d in docs if len(d["text"]) > 0]
                parts = []
                for d in docs:
                    X = neighbours(d, d["X"])
                    if variant != "base":
                        X = np.hstack([X, extra(d, variant.startswith("by"))])
                    parts.append(X)
                X = np.vstack(parts)
                y = np.concatenate([(d["rg"] == RI["heading"]) & (d["sg"] == 1) for d in docs]).astype(np.int8)
                keep = np.concatenate([d["rg"] >= 0 for d in docs])
                return X[keep], y[keep]
            Xt, yt = frame(train); Xd, yd = frame(dev)
            booster = lgb.train({"objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "bagging_fraction": 0.8, "bagging_freq": 1,
                                 "feature_fraction": 0.8, "verbose": -1}, lgb.Dataset(Xt, yt), num_boost_round=400)
            p = booster.predict(Xd)
            best = max(((2 * ((p >= t) & (yd == 1)).sum() / max(((p >= t).sum() + (yd == 1).sum()), 1), t) for t in (0.2, 0.3, 0.4, 0.5)))
            pred = p >= best[1]
            tp = int((pred & (yd == 1)).sum()); fp = int((pred & (yd == 0)).sum()); fn = int((~pred & (yd == 1)).sum())
            print(f"  lexicon {variant:18} dev heading starts: P {tp / max(tp + fp, 1):.3f} R {tp / max(tp + fn, 1):.3f} F1 {best[0]:.3f} (threshold {best[1]})", flush=True)
    elif command == "fit":
        # Can the evidence even fit the train labels? In-sample F1 of the base yardstick on train
        # beside dev: a low train fit says the labels are no function of the evidence (noise or
        # missing evidence); a high train fit with low dev says the evidence does not transfer.
        import lightgbm as lgb
        train, dev = load(root, "train"), load(root, "development")
        def frame(docs):
            docs = [d for d in docs if len(d["text"]) > 0]
            X = np.vstack([neighbours(d, d["X"]) for d in docs])
            y = np.concatenate([(d["rg"] == RI["heading"]) & (d["sg"] == 1) for d in docs]).astype(np.int8)
            keep = np.concatenate([d["rg"] >= 0 for d in docs])
            return X[keep], y[keep]
        Xt, yt = frame(train); Xd, yd = frame(dev)
        for rounds, leaves in ((400, 63), (1500, 255)):
            booster = lgb.train({"objective": "binary", "learning_rate": 0.05, "num_leaves": leaves, "verbose": -1}, lgb.Dataset(Xt, yt), num_boost_round=rounds)
            for name, X, y in (("train (in sample)", Xt, yt), ("dev", Xd, yd)):
                p = booster.predict(X)
                pred = p >= 0.3
                tp = int((pred & (y == 1)).sum()); fp = int((pred & (y == 0)).sum()); fn = int((~pred & (y == 1)).sum())
                print(f"  {rounds} rounds x {leaves} leaves, {name:18}: P {tp / max(tp + fp, 1):.3f} R {tp / max(tp + fn, 1):.3f} F1 {2 * tp / max(2 * tp + fp + fn, 1):.3f}", flush=True)
    elif command == "columns2":
        # Column-aware evidence proper: each line's column (clusters of left edges), its width and
        # centre against that column, and its neighbours taken within its column by vertical order
        # (the page's reading order interleaves a two-column page's columns, so the rows' gaps and
        # neighbours there are the other column's). Scored by the gold's document type.
        import lightgbm as lgb
        train, dev = load(root, "train"), load(root, "development")
        types = json.load(open(sys.argv[3], encoding="utf-8"))
        def doc_type(d):
            by = collections.Counter()
            for kind, _, lines in types.get(d["sha"], []):
                by[kind] += lines
            return by.most_common(1)[0][0] if by else "other"
        f = {name: k for k, name in enumerate(NAMES)}
        W = 16
        def extra(d):
            X, n, pages = d["X"], len(d["text"]), d["pages"]
            x0, y0, x1, y1 = X[:, f["x0"]], X[:, f["y0"]], X[:, f["x1"]], X[:, f["y1"]]
            marker, upper, ends_period, bold = X[:, f["marker"]], X[:, f["upper"]], X[:, f["ends_period"]], X[:, f["bold"]]
            look = d["look"]
            out = np.zeros((n, W), dtype=np.float32)
            for p in np.unique(pages):
                ks = np.where(pages == p)[0]
                heights = (y1[ks] - y0[ks])
                unit = float(np.median(heights[heights > 0])) if (heights > 0).any() else 0.01
                order = ks[np.argsort(x0[ks])]
                clusters, current = [], [order[0]]
                for k in order[1:]:
                    if x0[k] - x0[current[-1]] > 0.06:
                        clusters.append(current); current = [k]
                    else:
                        current.append(k)
                clusters.append(current)
                cols = []
                for c in clusters:
                    if len(c) >= 3:
                        left = float(np.median(x0[c])); right = float(np.percentile(x1[c], 90))
                        if right - left > 0.15:
                            cols.append((left, right))
                if not cols:
                    left = float(np.min(x0[ks])); right = float(np.max(x1[ks])); cols = [(left, max(right, left + 0.1))]
                cols.sort()
                # Each line's column: the one its horizontal middle falls in, else the nearest left edge.
                col_of = {}
                for k in ks:
                    mid = (x0[k] + x1[k]) / 2
                    inside = [i for i, (l, r) in enumerate(cols) if l - 0.03 <= mid <= r + 0.03]
                    col_of[k] = inside[0] if inside else int(np.argmin([abs(l - x0[k]) for l, _ in cols]))
                members = collections.defaultdict(list)
                for k in ks:
                    members[col_of[k]].append(k)
                for i, (left, right) in enumerate(cols):
                    width = max(right - left, 0.05)
                    col = sorted(members[i], key=lambda k: (y0[k] + y1[k]) / 2)
                    for pos, k in enumerate(col):
                        rel = (x1[k] - x0[k]) / width
                        prev = col[pos - 1] if pos > 0 else None
                        nxt = col[pos + 1] if pos + 1 < len(col) else None
                        gap_above = (y0[k] - y1[prev]) / unit if prev is not None else 3.0
                        gap_below = (y0[nxt] - y1[k]) / unit if nxt is not None else 3.0
                        out[k] = [
                            min(rel, 2.0), ((x0[k] + x1[k]) / 2 - (left + right) / 2) / width, (x0[k] - left) / width,
                            float(len(cols)), float(abs((x0[k] + x1[k]) / 2 - (left + right) / 2) / width < 0.04 and rel < 0.8),
                            max(min(gap_above, 3.0), -3.0), max(min(gap_below, 3.0), -3.0),
                            (x1[prev] - x0[prev]) / width if prev is not None else 0.0, (x1[nxt] - x0[nxt]) / width if nxt is not None else 0.0,
                            marker[nxt] if nxt is not None else 0.0, ends_period[prev] if prev is not None else 1.0,
                            upper[prev] if prev is not None else 0.0, upper[nxt] if nxt is not None else 0.0,
                            float(prev is not None and look[prev] == look[k]), float(nxt is not None and look[nxt] == look[k]),
                            bold[nxt] if nxt is not None else 0.0,
                        ]
            return out
        names = NAMES + ["col_width", "col_centre", "col_indent", "col_count", "col_centred", "col_gap_above", "col_gap_below", "col_prev_width", "col_next_width",
                         "col_next_marker", "col_prev_ends_period", "col_prev_upper", "col_next_upper", "col_prev_same_look", "col_next_same_look", "col_next_bold"]
        def frame(docs):
            docs = [d for d in docs if len(d["text"]) > 0]
            X = np.vstack([np.hstack([d["X"], extra(d)]) for d in docs])
            y = np.concatenate([(d["rg"] == RI["heading"]) & (d["sg"] == 1) for d in docs]).astype(np.int8)
            keep = np.concatenate([d["rg"] >= 0 for d in docs])
            kinds = np.concatenate([[doc_type(d) + "/" + d["mode"]] * len(d["text"]) for d in docs])
            return X[keep], y[keep], kinds[keep]
        Xt, yt, _ = frame(train); Xd, yd, kd = frame(dev)
        booster = lgb.train({"objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "bagging_fraction": 0.8, "bagging_freq": 1,
                             "feature_fraction": 0.8, "verbose": -1}, lgb.Dataset(Xt, yt, feature_name=names), num_boost_round=400)
        p = booster.predict(Xd)
        pred = p >= 0.3
        def prf(mask):
            tp = int((pred[mask] & (yd[mask] == 1)).sum()); fp = int((pred[mask] & (yd[mask] == 0)).sum()); fn = int((~pred[mask] & (yd[mask] == 1)).sum())
            return tp / max(tp + fp, 1), tp / max(tp + fn, 1), 2 * tp / max(2 * tp + fp + fn, 1), tp + fn
        P, Rc, F1, n = prf(np.ones_like(yd, dtype=bool))
        print(f"  columns2 (same-column neighbours), dev all: P {P:.3f} R {Rc:.3f} F1 {F1:.3f} ({n} heading starts)")
        for kind in sorted(set(kd), key=lambda k: -(kd == k).sum()):
            P, Rc, F1, n = prf(kd == kind)
            if n >= 20:
                print(f"    {kind:28} P {P:.3f} R {Rc:.3f} F1 {F1:.3f} ({n})")
        gain = booster.feature_importance(importance_type="gain")
        order = np.argsort(-gain)
        print("evidence by gain:", ", ".join(f"{names[k]} {gain[k] / gain.sum():.3f}" for k in order[:16]))
    elif command == "columns":
        # Column-relative evidence: each page's columns from the left edges of all its lines, each
        # line's width, centre and indent against its own column rather than the page's measure
        # (on a two-column page every line is "short" against the page). With the functional set,
        # scored by the gold's document type.
        import lightgbm as lgb
        train, dev = load(root, "train"), load(root, "development")
        types = json.load(open(sys.argv[3], encoding="utf-8"))
        def doc_type(d):
            by = collections.Counter()
            for kind, _, lines in types.get(d["sha"], []):
                by[kind] += lines
            return by.most_common(1)[0][0] if by else "other"
        f = {name: k for k, name in enumerate(NAMES)}
        def extra(d):
            X, n, pages = d["X"], len(d["text"]), d["pages"]
            x0, x1, gap_above, marker = X[:, f["x0"]], X[:, f["x1"]], X[:, f["gap_above"]], X[:, f["marker"]]
            out = np.zeros((n, 9), dtype=np.float32)
            for p in np.unique(pages):
                ks = np.where(pages == p)[0]
                # Columns: clusters of left edges holding at least three lines, 6% of the page apart.
                order = ks[np.argsort(x0[ks])]
                clusters, current = [], [order[0]]
                for k in order[1:]:
                    if x0[k] - x0[current[-1]] > 0.06:
                        clusters.append(current); current = [k]
                    else:
                        current.append(k)
                clusters.append(current)
                cols = []
                for c in clusters:
                    if len(c) >= 3:
                        left = float(np.median(x0[c])); right = float(np.percentile(x1[c], 90))
                        if right - left > 0.15:
                            cols.append((left, right))
                if not cols:
                    left = float(np.min(x0[ks])); right = float(np.max(x1[ks])); cols = [(left, max(right, left + 0.1))]
                cols.sort()
                for k in ks:
                    # The line's column: the one whose left edge is nearest at or before its own.
                    own = [c for c in cols if c[0] <= x0[k] + 0.03]
                    left, right = (own[-1] if own else cols[0])
                    width = max(right - left, 0.05)
                    rel = (x1[k] - x0[k]) / width
                    out[k, 0] = min(rel, 2.0)
                    out[k, 1] = ((x0[k] + x1[k]) / 2 - (left + right) / 2) / width
                    out[k, 2] = (x0[k] - left) / width
                    out[k, 3] = (right - x1[k]) / width
                    out[k, 4] = float(len(cols))
                    out[k, 5] = float(rel < 0.6)
                    out[k, 6] = float(abs(out[k, 1]) < 0.04 and rel < 0.8)
            # Column-relative "what follows": long lines (in their column) after this line before the next set-apart line.
            short = out[:, 5] > 0
            apart = short & (gap_above > 0.5)
            for k in range(n):
                longs = 0; j = k + 1
                while j < n and pages[j] == pages[k] and not apart[j]:
                    longs += not short[j]; j += 1
                out[k, 7] = min(longs, 20) / 20
                out[k, 8] = float(k + 1 < n and pages[k + 1] == pages[k] and (not short[k + 1] or marker[k + 1] > 0))
            return out
        names = NAMES + [f"prev_{n}" for n in NAMES] + [f"next_{n}" for n in NAMES] + ["col_width", "col_centre", "col_indent", "col_right_gap", "col_count", "col_short", "col_centred", "col_governs", "col_next_body"]
        def frame(docs):
            docs = [d for d in docs if len(d["text"]) > 0]
            X = np.vstack([np.hstack([neighbours(d, d["X"]), extra(d)]) for d in docs])
            y = np.concatenate([(d["rg"] == RI["heading"]) & (d["sg"] == 1) for d in docs]).astype(np.int8)
            keep = np.concatenate([d["rg"] >= 0 for d in docs])
            kinds = np.concatenate([[doc_type(d) + "/" + d["mode"]] * len(d["text"]) for d in docs])
            return X[keep], y[keep], kinds[keep]
        Xt, yt, _ = frame(train); Xd, yd, kd = frame(dev)
        booster = lgb.train({"objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "bagging_fraction": 0.8, "bagging_freq": 1,
                             "feature_fraction": 0.8, "verbose": -1}, lgb.Dataset(Xt, yt, feature_name=names), num_boost_round=400)
        p = booster.predict(Xd)
        pred = p >= 0.3
        def prf(mask):
            tp = int((pred[mask] & (yd[mask] == 1)).sum()); fp = int((pred[mask] & (yd[mask] == 0)).sum()); fn = int((~pred[mask] & (yd[mask] == 1)).sum())
            return tp / max(tp + fp, 1), tp / max(tp + fn, 1), 2 * tp / max(2 * tp + fp + fn, 1), tp + fn
        P, Rc, F1, n = prf(np.ones_like(yd, dtype=bool))
        print(f"  columns, dev all: P {P:.3f} R {Rc:.3f} F1 {F1:.3f} ({n} heading starts)")
        for kind in sorted(set(kd), key=lambda k: -(kd == k).sum()):
            P, Rc, F1, n = prf(kd == kind)
            if n >= 20:
                print(f"    {kind:28} P {P:.3f} R {Rc:.3f} F1 {F1:.3f} ({n})")
        gain = booster.feature_importance(importance_type="gain")
        order = np.argsort(-gain)
        print("evidence by gain:", ", ".join(f"{names[k]} {gain[k] / gain.sum():.3f}" for k in order[:16]))
    elif command == "functional":
        # Label-free structural evidence: what a line governs (the run of long lines and marker
        # lines after it before the next line set apart), how the lines of its look are followed
        # across the document, its enumerator's place in its family's sequence, and its centring
        # within its own column (columns clustered from the page's long lines).
        import lightgbm as lgb
        import re
        train, dev = load(root, "train"), load(root, "development")
        f = {name: k for k, name in enumerate(NAMES)}
        enum = re.compile(r"^\s*(?:(part|partie|chapter|chapitre|article|schedule|annexe?|appendix|division|title|titre|book|livre|section|rule)\s+([0-9]{1,3}|[ivxlcdm]{1,7}|[a-z])\b|(\d{1,3})(?:\.\d{1,3})*[.)]?\s|([a-z])[.)]\s|\(([a-z0-9]{1,3})\)\s|([ivxlcdm]{1,6})[.)]\s)", re.I)
        roman = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10, "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15, "xx": 20}
        def family_ordinal(text):
            m = enum.match(text)
            if not m:
                return None, 0
            if m.group(1):
                v = m.group(2).lower()
                n = int(v) if v.isdigit() else roman.get(v, ord(v) - 96 if len(v) == 1 else 0)
                return "word:" + m.group(1).lower(), n
            if m.group(3):
                return "arabic", int(m.group(3))
            if m.group(4):
                return "alpha", ord(m.group(4).lower()) - 96
            if m.group(5):
                v = m.group(5).lower()
                return ("bracket-" + ("digit" if v.isdigit() else "roman" if v in roman else "alpha")), int(v) if v.isdigit() else roman.get(v, ord(v) - 96 if len(v) == 1 else 0)
            v = m.group(6).lower()
            return "roman", roman.get(v, 0)
        def extra(d):
            X, n, pages, text, look = d["X"], len(d["text"]), d["pages"], d["text"], d["look"]
            width, gap_above, marker, x0, x1 = X[:, f["width"]], X[:, f["gap_above"]], X[:, f["marker"]], X[:, f["x0"]], X[:, f["x1"]]
            short = width < 0.6
            apart = short & (gap_above > 0.5)
            out = np.zeros((n, 12), dtype=np.float32)
            # Governs: long lines and marker lines after this line on its page before the next line set apart.
            for k in range(n):
                longs = marks = 0
                j = k + 1
                while j < n and pages[j] == pages[k] and not apart[j]:
                    longs += not short[j]; marks += marker[j] > 0
                    j += 1
                out[k, 0] = min(longs, 20) / 20; out[k, 1] = min(marks, 10) / 10
                out[k, 2] = float(j < n and pages[j] == pages[k] and apart[j])   # a set-apart line follows the run
                out[k, 3] = float(k + 1 < n and pages[k + 1] == pages[k] and (not short[k + 1] or marker[k + 1] > 0))
            # Look follow-through: of this look's lines in the document, the share followed by a long or marker line.
            by = collections.defaultdict(list)
            for k in range(n):
                if look[k] >= 0:
                    by[int(look[k])].append(k)
            for l, ks in by.items():
                ks = np.asarray(ks)
                out[ks, 4] = out[ks, 3].mean(); out[ks, 5] = short[ks].mean(); out[ks, 6] = np.log1p(len(ks)) / 8
            # Family sequence among short lines: continues the family's last ordinal, or restarts at 1.
            last = {}
            for k in range(n):
                fam, ordinal = family_ordinal(text[k])
                if fam is None or not short[k]:
                    continue
                prev = last.get(fam)
                out[k, 7] = float(prev is not None and ordinal == prev + 1)
                out[k, 8] = float(ordinal == 1)
                out[k, 9] = float(prev is not None and ordinal != prev + 1 and ordinal != 1)
                last[fam] = ordinal
            # Column-relative centring: columns from the page's long lines' left edges.
            for p in np.unique(pages):
                ks = np.where(pages == p)[0]
                longs = ks[~short[ks]]
                edges = np.sort(x0[longs]) if len(longs) else np.asarray([])
                cols = []
                for e in edges:
                    if not cols or e - cols[-1][0] > 0.08:
                        cols.append([e, e])
                    else:
                        cols[-1][1] = e
                for k in ks:
                    left = max([c[0] for c in cols if c[0] <= x0[k] + 0.02], default=0.0)
                    rights = [x1[j] for j in longs if abs(x0[j] - left) <= 0.03]
                    right = max(rights) if rights else 1.0
                    centre = (x0[k] + x1[k]) / 2 - (left + right) / 2
                    out[k, 10] = centre; out[k, 11] = float(abs(centre) < 0.02 and x1[k] - x0[k] < 0.8 * (right - left))
            return out
        names = NAMES + [f"prev_{n}" for n in NAMES] + [f"next_{n}" for n in NAMES] + ["governs_long", "governs_marks", "apart_follows", "next_body", "look_follow", "look_short", "look_count", "seq_continues", "seq_restarts", "seq_breaks", "col_centre", "col_centred"]
        def frame(docs):
            docs = [d for d in docs if len(d["text"]) > 0]
            X = np.vstack([np.hstack([neighbours(d, d["X"]), extra(d)]) for d in docs])
            y = np.concatenate([(d["rg"] == RI["heading"]) & (d["sg"] == 1) for d in docs]).astype(np.int8)
            keep = np.concatenate([d["rg"] >= 0 for d in docs])
            modes = np.concatenate([[d["mode"]] * len(d["text"]) for d in docs])
            return X[keep], y[keep], modes[keep]
        Xt, yt, _ = frame(train); Xd, yd, md = frame(dev)
        booster = lgb.train({"objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "bagging_fraction": 0.8, "bagging_freq": 1,
                             "feature_fraction": 0.8, "verbose": -1}, lgb.Dataset(Xt, yt, feature_name=names), num_boost_round=400)
        p = booster.predict(Xd)
        for threshold in (0.3, 0.4, 0.5):
            for mode in ("all", "digitalborn", "ocr"):
                m = md == mode if mode != "all" else np.ones_like(yd, dtype=bool)
                pred = p[m] >= threshold; y = yd[m]
                tp = int((pred & (y == 1)).sum()); fp = int((pred & (y == 0)).sum()); fn = int((~pred & (y == 1)).sum())
                print(f"  functional, dev {mode:12} threshold {threshold}: P {tp / max(tp + fp, 1):.3f} R {tp / max(tp + fn, 1):.3f} F1 {2 * tp / max(2 * tp + fp + fn, 1):.3f}")
        gain = booster.feature_importance(importance_type="gain")
        order = np.argsort(-gain)
        print("evidence by gain:")
        for k in order[:30]:
            print(f"  {names[k]:24} {gain[k] / gain.sum():.3f}")
    elif command in ("importance", "enriched"):
        import lightgbm as lgb
        import re
        train, dev = load(root, "train"), load(root, "development")
        enriched = command == "enriched"
        # Word evidence: each word's log-odds of opening a heading, counted on the train split
        # (smoothed); a line's evidence is the mean and the max over its words.
        token = re.compile(r"[^\W\d_]{2,}")
        heads, total = collections.Counter(), collections.Counter()
        if enriched:
            for d in train:
                for k in range(len(d["text"])):
                    if d["rg"][k] < 0:
                        continue
                    g = d["rg"][k] == RI["heading"] and d["sg"][k] == 1
                    for w in set(t.lower() for t in token.findall(d["text"][k])):
                        total[w] += 1
                        heads[w] += g
            base = sum(heads.values()) / max(sum(total.values()), 1)
            def odds(w):
                return np.log((heads[w] + 2 * base) / (total[w] - heads[w] + 2 * (1 - base)))
        def extra(d):
            n = len(d["text"])
            X = d["X"]
            f = {name: k for k, name in enumerate(NAMES)}
            words = np.zeros((n, 3), dtype=np.float32)
            for k in range(n):
                ws = [w.lower() for w in token.findall(d["text"][k])]
                if ws:
                    o = [odds(w) for w in ws]
                    words[k] = (np.mean(o), np.max(o), np.min(o))
            # Look aggregates within the document: how the lines of this look are set on average.
            look = d["look"]
            agg = np.zeros((n, 6), dtype=np.float32)
            by = collections.defaultdict(list)
            for k in range(n):
                by[int(look[k])].append(k)
            for l, ks in by.items():
                if l < 0:
                    continue
                rows = X[ks]
                vals = [rows[:, f["width"]].mean(), rows[:, f["gap_above"]].mean(), rows[:, f["gap_below"]].mean(),
                        (rows[:, f["ends_period"]] > 0).mean(), np.log1p(len(ks)), words[ks, 0].mean()]
                agg[ks] = vals
            return np.hstack([words, agg])
        names = NAMES + [f"prev_{n}" for n in NAMES] + [f"next_{n}" for n in NAMES]
        if enriched:
            names += ["word_odds_mean", "word_odds_max", "word_odds_min", "look_width", "look_gap_above", "look_gap_below", "look_ends_period", "look_count", "look_word_odds"]
        def frame(docs):
            docs = [d for d in docs if len(d["text"]) > 0]
            X = np.vstack([np.hstack([neighbours(d, d["X"]), extra(d)]) if enriched else neighbours(d, d["X"]) for d in docs])
            y = np.concatenate([(d["rg"] == RI["heading"]) & (d["sg"] == 1) for d in docs]).astype(np.int8)
            keep = np.concatenate([d["rg"] >= 0 for d in docs])
            return X[keep], y[keep]
        Xt, yt = frame(train); Xd, yd = frame(dev)
        booster = lgb.train({"objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "bagging_fraction": 0.8, "bagging_freq": 1,
                             "feature_fraction": 0.8, "verbose": -1}, lgb.Dataset(Xt, yt, feature_name=names), num_boost_round=400)
        p = booster.predict(Xd)
        for threshold in (0.3, 0.4, 0.5, 0.6):
            pred = p >= threshold
            tp = int((pred & (yd == 1)).sum()); fp = int((pred & (yd == 0)).sum()); fn = int((~pred & (yd == 1)).sum())
            print(f"  heading-start lines, dev, threshold {threshold}: P {tp / max(tp + fp, 1):.3f} R {tp / max(tp + fn, 1):.3f} F1 {2 * tp / max(2 * tp + fp + fn, 1):.3f}")
        gain = booster.feature_importance(importance_type="gain")
        order = np.argsort(-gain)
        print("evidence by gain:")
        for k in order[:40]:
            print(f"  {names[k]:24} {gain[k] / gain.sum():.3f}")
