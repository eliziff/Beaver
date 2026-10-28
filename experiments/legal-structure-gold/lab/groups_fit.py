"""The group-level heading decision fitted on train: each within-document style group's relative
evidence (its members' shares of standing alone, set apart, governing text, being labels; its
placement, case, family and type; the document's type and mode) against the gold's majority label
for the group; decoded on dev as styles_decide decodes (a member stands when it governs or is set
apart), and scored as heading unit F1 beside tier 0 and the hand rules.

  python groups_fit.py ROWS_DIR GOLD_TYPES [logistic|trees]
"""
import collections
import json
import sys

import numpy as np

import lab
from lab import R, RI
import styles_decide as sd
from styles import enumerator_family

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root, types_path = sys.argv[1], sys.argv[2]
model_kind = sys.argv[3] if len(sys.argv) > 3 else "trees"
KEEP = ("outline", "rules_promote")
TYPES = ["judgment", "contract", "legislation", "form", "submission", "article", "report", "transcript", "affidavit", "order", "notice", "correspondence", "pleading", "other"]
PLACES = ["centred", "flush", "indented", "margin"]
CASES = ["caps", "title", "sentence"]
FAMILIES = ["", "word", "arabic-1", "arabic-2", "arabic-3", "alpha", "roman", "bracket-arabic", "bracket-alpha", "bracket-square"]
NAMES = (["log_members", "pages_share", "alone", "apart_above", "apart_below", "governs", "label", "bold", "larger", "underlined", "subsection_next",
          "sequence", "first_on_page", "mean_width", "mean_chars", "mean_gap_above", "mean_gap_below", "mean_centre", "body_look", "ocr", "doc_pages"]
         + [f"place_{p}" for p in PLACES] + [f"case_{c}" for c in CASES] + [f"family_{f or 'none'}" for f in FAMILIES] + [f"type_{t}" for t in TYPES])


def group_rows(doc):
    """(features, majority-heading label, members) per candidate group of the document."""
    n = len(doc["text"])
    if n == 0:
        return []
    ev = sd.evidence(doc)
    kind = sd.doc_type(doc)
    X, pages = doc["X"], doc["pages"]
    F = sd.F
    groups = collections.defaultdict(list)
    for k in range(n):
        if ev[k]["candidate"]:
            groups[ev[k]["key"]].append(k)
    page_count = max(int(pages.max()) + 1, 1) if n else 1
    rows = []
    for key, members in groups.items():
        look, col, placement, case, alone, family = key
        m = len(members)
        share = lambda name: sum(bool(ev[k][name]) for k in members) / m
        seq, last = 0, None
        for k in members:
            o = ev[k]["ordinal"]
            if o is not None and (o == 1 or (last is not None and o == last + 1)):
                seq += 1
            last = o
        feats = [np.log1p(m), len({int(pages[k]) for k in members}) / page_count, share("alone"), share("apart_above"), share("apart_below"),
                 share("governs"), share("label"), share("bold"), share("larger"), share("underlined"), share("subsection_next"),
                 seq / m, np.mean([X[k, F["first_on_page"]] for k in members]), np.mean([ev[k]["rel"] for k in members]),
                 np.mean([len(doc["text"][k].strip()) for k in members]) / 100, np.mean([X[k, F["gap_above"]] for k in members]),
                 np.mean([X[k, F["gap_below"]] for k in members]), np.mean([abs(X[k, F["centre"]]) for k in members]),
                 np.mean([X[k, F["body_style"]] for k in members]), float(doc["mode"] == "ocr"), np.log1p(page_count)]
        feats += [float(placement == p) for p in PLACES] + [float(case == c) for c in CASES] + [float(family == f) for f in FAMILIES] + [float(kind == t) for t in TYPES]
        heads = sum(doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1 for k in members)
        rows.append((np.asarray(feats, dtype=np.float32), float(heads * 2 > m), members, ev))
    return rows


def fit(train):
    Xs, ys, ws = [], [], []
    for doc in train:
        for feats, label, members, _ in group_rows(doc):
            Xs.append(feats); ys.append(label); ws.append(len(members))
    X, y, w = np.vstack(Xs), np.asarray(ys), np.asarray(ws, dtype=np.float32)
    if model_kind == "trees":
        import lightgbm as lgb
        booster = lgb.train({"objective": "binary", "learning_rate": 0.05, "num_leaves": 15, "min_data_in_leaf": 20, "verbose": -1},
                            lgb.Dataset(X, y, weight=w, feature_name=NAMES), num_boost_round=300)
        predict = lambda F: booster.predict(F)
        gain = booster.feature_importance(importance_type="gain")
        order = np.argsort(-gain)
        print("group evidence by gain:", ", ".join(f"{NAMES[k]} {gain[k] / gain.sum():.3f}" for k in order[:14]))
    else:
        # Logistic regression by gradient descent on standardized features (no sklearn here).
        mean, std = X.mean(0), X.std(0) + 1e-6
        Z = (X - mean) / std
        beta = np.zeros(Z.shape[1] + 1)
        for _ in range(3000):
            logits = Z @ beta[:-1] + beta[-1]
            p = 1 / (1 + np.exp(-logits))
            grad = np.concatenate([(w * (p - y)) @ Z, [(w * (p - y)).sum()]]) / w.sum() + 1e-3 * np.concatenate([beta[:-1], [0]])
            beta -= 0.5 * grad
        predict = lambda F: 1 / (1 + np.exp(-(((F - mean) / std) @ beta[:-1] + beta[-1])))
        order = np.argsort(-np.abs(beta[:-1]))
        print("logistic weights:", ", ".join(f"{NAMES[k]} {beta[k]:+.2f}" for k in order[:16]))
    return predict


def decoder(predict, threshold, strict):
    def decide(doc):
        region, start = doc["r0"].copy(), doc["s0"].copy()
        rows = group_rows(doc)
        if not rows:
            return region, start
        n = len(doc["text"])
        ev = rows[0][3]
        p = predict(np.vstack([r[0] for r in rows]))
        heads = np.zeros(n, dtype=bool)
        for (feats, _, members, _), prob in zip(rows, p):
            if prob < threshold:
                continue
            for k in members:
                e = ev[k]
                if (not strict or e["governs"] or (e["apart_above"] and e["apart_below"]) or e["ordinal"] is not None) and not e["label"]:
                    heads[k] = True
        for k in range(n):
            if doc["r0"][k] == RI["heading"] and doc["s0"][k] == 1 and any(mark in doc["trail"][k] for mark in KEEP) \
                    and not doc["trail"][k].endswith(("demote_wrapped", "demote_sentence", "demote_label", "demote_caption", "demote_caps_body", "demote_nearer_above", "marginal_note")):
                heads[k] = True
        opens = next((k for k in range(n) if ev[k]["long"]), n)
        first = next((k for k in range(n) if heads[k]), None)
        title = first is not None and first < opens and enumerator_family(doc["text"][first]) != "word" and (ev[first]["caps"] or ev[first]["placement"] == "centred" or ev[first]["larger"])
        wrapped = set()
        for k in range(n):
            if heads[k] and k == first and title:
                region[k] = RI["title"]; start[k] = 1
                for j in ev[k]["unit"][1:]:
                    region[j] = RI["title"]; start[j] = 0; wrapped.add(j)
            elif heads[k]:
                region[k] = RI["heading"]; start[k] = 1
                for j in ev[k]["unit"][1:]:
                    region[j] = RI["heading"]; start[j] = 0; wrapped.add(j)
            elif doc["r0"][k] == RI["heading"] and k not in wrapped:
                region[k] = RI["text"]; start[k] = 1 if doc["s0"][k] != 0 else 0
        return region, start
    return decide


if __name__ == "__main__":
    train, dev = lab.load(root, "train"), lab.load(root, "development")
    predict = fit(train)
    lab.table("tier 0, development", lab.score(dev, lab.tier0, kinds=("heading", "body")), kinds=("heading", "body"))
    for keep in (("outline", "rules_promote"), ("outline", "rules_promote", "native"), ("outline", "rules_promote", "native", "styled", "layout", "rules_lift")):
        KEEP = keep
        for threshold in (0.2, 0.3):
            lab.table(f"fitted groups ({model_kind}) + {'+'.join(keep)}, threshold {threshold}, development",
                      lab.score(dev, decoder(predict, threshold, False), kinds=("heading", "body")), kinds=("heading", "body"))
    decide = decoder(predict, 0.3, False)
    by_type = collections.defaultdict(list)
    for d in dev:
        by_type[sd.doc_type(d)].append(d)
    print(f"\n  {'type':14} {'docs':>5} {'tier 0':>8} {'fitted':>8}")
    for kind, ds in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
        t0 = lab.f1(lab.score(ds, lab.tier0, kinds=("heading",))[("heading", "all")])[0]
        st = lab.f1(lab.score(ds, decide, kinds=("heading",))[("heading", "all")])[0]
        print(f"  {kind:14} {len(ds):5} {t0:8.3f} {st:8.3f}")
