"""Development-only operation model using the retained, frozen feature caches.

Names share one canonical-name score. A conditional model chooses the complete
surface form for each name; the decoder considers every combination jointly.
The prepared generator is untouched unless this probe clears its declared gate.
Inputs, examples, predictions and numeric fitting artifacts remain private.
"""
import argparse
from array import array
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import pickle
import time

import numpy as np

import operations as op
import shortform as s
from mine import normalize, words

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / "benchmarks/local-data/case-shortforms"
INPUTS = ("combined-word-features.pickle", "evidence-features.pickle",
          "features-expanded.pickle", "combined-word-candidate-model.json")
FORM_FEATURES = ("render_words", "render_ending", "render_initials", "raw", "abbreviated",
                 "omitted", "full_style", "attested", "year", "court", "year_court",
                 "surface_chars", "surface_words", "added_chars", "legal_words", "french",
                 "chosen_scc", "chosen_appellate", "court_language_match", "citation_year",
                 "court_use_rate", "court_use_support", "year_use_rate", "year_use_support")


def read(name):
    return json.loads((PRIVATE / name).read_text(encoding="utf-8"))


def write(name, value):
    (PRIVATE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def edges(groups):
    return np.r_[0, np.cumsum(groups)]


def winners(scores, groups):
    starts = edges(groups)[:-1]
    maximum = np.maximum.reduceat(scores, starts)
    return np.minimum.reduceat(np.where(scores == np.repeat(maximum, groups),
                                       np.arange(len(scores)), len(scores)), starts)


def log_probabilities(scores, groups):
    starts = edges(groups)[:-1]
    centered = scores - np.repeat(np.maximum.reduceat(scores, starts), groups)
    return centered - np.repeat(np.log(np.add.reduceat(np.exp(centered), starts)), groups)


def objective(groups):
    def loss(scores, dataset):
        probability = np.exp(log_probabilities(scores, groups))
        return probability - dataset.get_label(), np.maximum(probability * (1 - probability), 1e-6)
    return loss


def numeric_scores(matrix, trees):
    result = np.zeros(len(matrix))
    def visit(node, indices):
        if not len(indices):
            return
        if not isinstance(node, list):
            result[indices] += node
            return
        mask = matrix[indices, node[0]] <= node[1]
        visit(node[2], indices[mask])
        visit(node[3], indices[~mask])
    for tree in trees:
        visit(tree, np.arange(len(matrix)))
    return result


def compact(node):
    if "leaf_value" in node:
        return node["leaf_value"]
    assert node["decision_type"] == "<="
    return [node["split_feature"], node["threshold"], compact(node["left_child"]), compact(node["right_child"])]


def form_features(record, choice, parts, source, evidence, feature_index):
    text, side, kind = op.unpack(choice)
    name, _, rendering, year, court = parts
    return (float(rendering == "words"), float(rendering == "ending"), float(rendering == "initials"),
            float(kind.startswith("raw")), float(kind.startswith("abbreviated")),
            float(kind.startswith("omitted")), float(kind.startswith("full_style")),
            float(kind.startswith("attested")), float(year), float(court), float(year and court),
            len(text)/30, len(words(text))/4, (len(text)-len(name))/30,
            sum(word in s.LEGAL_ENDINGS for word in words(text)), float(record["language"] == "fr"),
            source[feature_index["chosen_scc"]], source[feature_index["chosen_appellate"]],
            source[feature_index["court_language_match"]], source[feature_index["earliest_cited_year"]],
            *evidence[-4:])


def build_partition(expanded, modal, authored, groups, metas, evidence, original,
                    original_modal, original_any, original_groups, features, background, training):
    starts = edges(groups)
    original_starts = edges(original_groups)
    original_query = 0
    stem_rows, stem_modal, stem_any, stem_groups = [], [], [], []
    form_rows = array("f")
    form_modal, form_any, form_groups, form_to_stem, case_groups = [], [], [], [], []
    records, choices_out, stem_keys = [], [], []
    baseline_correct, baseline_stem, baseline_text = [], [], []
    source_counts = Counter()
    feature_index = {name: i for i, name in enumerate(features)}
    base_model = read("combined-word-candidate-model.json")
    original_scores = numeric_scores(original, base_model["trees"])
    original_best = winners(original_scores, original_groups)
    for query, ((record, choices), start, stop) in enumerate(zip(metas, starts[:-1], starts[1:])):
        assert len(choices) == stop-start
        base_indices = np.flatnonzero(expanded[start:stop, 89] == 0) + start
        has_original = not training or (len(base_indices) >= 2 and np.any(modal[base_indices]))
        lookup = {}
        if has_original:
            left, right = original_starts[original_query:original_query+2]
            assert right-left == len(base_indices)
            assert np.array_equal(original_modal[left:right], modal[base_indices])
            assert np.array_equal(original_any[left:right], authored[base_indices])
            for base_index, old_index in zip(base_indices, range(left, right)):
                text, side, _ = op.unpack(choices[int(base_index-start)])
                lookup[normalize(text), side] = int(old_index)
            if not training:
                selected = int(original_best[original_query])
                chosen = choices[int(base_indices[selected-left]-start)]
                canonical = op.parts(record, chosen)
                baseline_correct.append(int(original_any[selected]))
                baseline_stem.append((normalize(canonical[0]), canonical[1]))
                baseline_text.append(op.unpack(chosen)[0])
            original_query += 1
        decomposed = [op.parts(record, choice) for choice in choices]
        grouped = {}
        for number, parts in enumerate(decomposed):
            grouped.setdefault((normalize(parts[0]), parts[1]), []).append(number)
        targets, any_targets = op.label_keys(record, True), op.label_keys(record)
        stem_groups.append(len(grouped))
        case_groups.append(len(choices))
        local_choices, local_keys = [], []
        for key, numbers in grouped.items():
            first = numbers[0]
            name, side, *_ = decomposed[first]
            old = lookup.get(key)
            if old is not None:
                row = original[old].copy()
                source_counts["original_109"] += 1
            else:
                # A rare new name may have no original candidate. Its lexical
                # features use the retained 89-feature view, with label-free shape.
                source = next((i for i in numbers if normalize(op.unpack(choices[i])[0]) == key[0]), first)
                row = np.r_[expanded[start+source, :89],
                            s.shape_features((record["left"], record["right"]), name, side, background)]
                source_counts["legacy_89_plus_shape"] += 1
            stem_index = len(stem_rows)
            stem_rows.append(row)
            exact_modal = any(modal[start+i] for i in numbers)
            exact_any = any(authored[start+i] for i in numbers)
            stem_modal.append(int(key in targets or exact_modal))
            stem_any.append(int(key in any_targets or exact_any))
            form_groups.append(len(numbers))
            local_keys.append(key)
            for i in numbers:
                form_rows.extend(form_features(record, choices[i], decomposed[i],
                                               expanded[start+i], evidence[start+i], feature_index))
                form_modal.append(modal[start+i])
                form_any.append(authored[start+i])
                form_to_stem.append(stem_index)
                local_choices.append(op.unpack(choices[i]))
        stem_keys.append(local_keys)
        records.append(record)
        choices_out.append(local_choices)
        if (query+1) % 5000 == 0:
            print(json.dumps({"phase": "operation_cache", "training": training,
                              "queries": query+1, "stems": len(stem_rows)}), flush=True)
    assert original_query == len(original_groups)
    result = {"stem_x": np.asarray(stem_rows), "stem_modal": np.asarray(stem_modal, dtype=np.uint8),
              "stem_any": np.asarray(stem_any, dtype=np.uint8), "stem_groups": np.asarray(stem_groups),
              "form_x": np.frombuffer(form_rows, dtype=np.float32).reshape((-1, len(FORM_FEATURES))),
              "form_modal": np.asarray(form_modal, dtype=np.uint8), "form_any": np.asarray(form_any, dtype=np.uint8),
              "form_groups": np.asarray(form_groups), "form_to_stem": np.asarray(form_to_stem, dtype=np.int32),
              "case_groups": np.asarray(case_groups), "records": records, "choices": choices_out,
              "stem_keys": stem_keys, "feature_sources": dict(source_counts)}
    if not training:
        result.update(baseline_correct=np.asarray(baseline_correct, dtype=np.uint8),
                      baseline_stem=baseline_stem, baseline_text=baseline_text)
    return result


def prepare():
    op.self_check()
    started = time.monotonic()
    plan = {"scope": "reduced training and original development only; exact complete authored labels; all 5351 development rows",
            "baseline_matches": 4007, "promotion_gate_matches": 4115,
            "gate": "at least two absolute percentage points above the current reduced-fit development baseline",
            "fit_modes": ["structured_from_scratch", "structured_continue_stems"],
            "objective": "case-normalized canonical-name softmax, then surface-form softmax conditional on each canonical name; joint decoding",
            "auxiliary_targets": "modal authored labels decomposed mechanically; complete original labels retained for form targets and exact evaluation",
            "inputs": {name: fingerprint(PRIVATE/name) for name in INPUTS},
            "source_sha256": {name: fingerprint(Path(__file__).with_name(name))
                              for name in ("operation_probe.py", "operations.py")}}
    write("operations-plan.json", plan)
    ox, oy, oa, og, ov, ovy, ova, ovg, ometas, names, mode = pickle.loads((PRIVATE/INPUTS[0]).read_bytes())
    et, ev, train_metas, _, _ = pickle.loads((PRIVATE/INPUTS[1]).read_bytes())
    tx, ty, ta, tg, dx, dy, da, dg, metas, features = pickle.loads((PRIVATE/INPUTS[2]).read_bytes())
    assert len(names) == 109 and len(og) == 21957 and len(metas) == len(ometas) == 5351
    assert [(r["identity"], r["language"]) for r, _ in metas] == [(r["identity"], r["language"]) for r, _ in ometas]
    background = read("combined-word-candidate-model.json")["background_statistics"]
    train = build_partition(tx, ty, ta, tg, train_metas, et, ox, oy, oa, og, features, background, True)
    dev = build_partition(dx, dy, da, dg, metas, ev, ov, ovy, ova, ovg, features, background, False)
    assert int(dev["baseline_correct"].sum()) == 4007
    diagnosis = diagnose(dev)
    diagnosis.update(plan=plan, elapsed_seconds=round(time.monotonic()-started, 2),
                     feature_sources={"train": train["feature_sources"], "development": dev["feature_sources"]})
    write("operations-diagnosis.json", diagnosis)
    with (PRIVATE/"operations-features.pickle").open("wb") as stream:
        pickle.dump({"train": train, "development": dev, "stem_features": names, "form_features": FORM_FEATURES,
                     "plan": plan}, stream, protocol=5)
    print(json.dumps({key: value for key, value in diagnosis.items() if key not in ("plan", "review")}), flush=True)


def diagnose(dev):
    counts = Counter()
    missing = Counter()
    review = []
    se, ce = edges(dev["stem_groups"]), edges(dev["case_groups"])
    for q, (record, choices, keys) in enumerate(zip(dev["records"], dev["choices"], dev["stem_keys"])):
        baseline = bool(dev["baseline_correct"][q])
        exact = bool(np.any(dev["form_any"][ce[q]:ce[q+1]]))
        canonical = bool(np.any(dev["stem_any"][se[q]:se[q+1]]))
        correct_keys = {key for key, good in zip(keys, dev["stem_any"][se[q]:se[q+1]]) if good}
        chosen_key = dev["baseline_stem"][q]
        same_stem = chosen_key in correct_keys
        counts["rows"] += 1
        counts["baseline_exact"] += baseline
        counts["expanded_exact_coverage"] += exact
        counts["canonical_coverage"] += canonical
        if baseline:
            continue
        exact_keys = {op.parts(record, choice)[:2] for choice, good in
                      zip(choices, dev["form_any"][ce[q]:ce[q+1]]) if good}
        exact_keys = {(normalize(name), side) for name, side in exact_keys}
        if chosen_key in exact_keys:
            category = "selected_canonical_name_has_an_exact_authored_rendering"
        elif same_stem:
            category = "selected_canonical_name_matches_but_exact_rendering_absent"
        elif exact:
            correct_sides = {side for _, side in correct_keys}
            category = ("different_canonical_name_same_possible_party" if chosen_key[1] in correct_sides
                        else "different_party")
        elif canonical:
            category = "canonical_name_available_but_exact_rendering_absent"
        else:
            category = "authored_canonical_name_absent"
        counts[category] += 1
        if not exact:
            labels = [alias["text"] for alias in record["aliases"].values()]
            missing["all_authored_labels_over_30"] += all(len(label) > 30 for label in labels)
            missing["some_uppercase_label"] += any(label.replace(".", "").isupper() for label in labels)
        review.append({"identity": record["identity"], "language": record["language"], "category": category,
                       "left": record["left"], "right": record["right"], "citation": record["citation"],
                       "prediction": dev["baseline_text"][q],
                       "authored": [alias["text"] for alias in record["aliases"].values()]})
    review.sort(key=lambda r: hashlib.sha256(("operations-review-v1:"+r["identity"]+":"+r["language"]).encode()).digest())
    counts["selected_name_with_perfect_rendering_oracle"] = (
        counts["baseline_exact"] + counts["selected_canonical_name_has_an_exact_authored_rendering"])
    return {"counts": dict(counts), "missing_renderings_overlapping": dict(missing),
            "interpretation": "mechanical decomposition and oracle counts, not a semantic audit or an information-theoretic ceiling",
            "review": review[:120]}


def self_check():
    op.self_check()
    group = np.array([2, 3])
    score = np.array([.2, -.4, 1.2, .8, -.5])
    target = np.array([1., 0., .5, .5, 0.])
    class Data:
        def get_label(self):
            return target
    gradient, hessian = objective(group)(score, Data())
    assert np.allclose(np.add.reduceat(np.exp(log_probabilities(score, group)), edges(group)[:-1]), 1.)
    for index in range(len(score)):
        plus, minus = score.copy(), score.copy()
        plus[index] += 1e-5
        minus[index] -= 1e-5
        finite = (-np.dot(target, log_probabilities(plus, group))
                  + np.dot(target, log_probabilities(minus, group))) / 2e-5
        assert abs(finite-gradient[index]) < 1e-8
        assert hessian[index] > 0
    assert winners(np.array([1., 1., 0., 2., 2.]), group).tolist() == [0, 3]
    stem_log = log_probabilities(np.log([.55, .45]), np.array([2]))
    surface_log = log_probabilities(np.zeros(3), np.array([2, 1]))
    joint = stem_log[np.array([0, 0, 1])] + surface_log
    assert abs(float(np.exp(joint).sum())-1) < 1e-12
    assert int(np.argmax(joint)) == 2 and int(np.argmax(stem_log)) == 0


def fit():
    import lightgbm as lgb
    self_check()
    started = time.monotonic()
    cache = pickle.loads((PRIVATE/"operations-features.pickle").read_bytes())
    train, dev = cache["train"], cache["development"]
    plan = cache["plan"]
    assert plan["source_sha256"] == {name: fingerprint(Path(__file__).with_name(name))
                                     for name in ("operation_probe.py", "operations.py")}, "recipe changed after preparation"
    base = read("combined-word-candidate-model.json")
    forms_positive = np.add.reduceat(train["form_modal"], edges(train["form_groups"])[:-1]) > 0
    selected = np.flatnonzero(np.repeat(forms_positive, train["form_groups"]))
    form_groups = train["form_groups"][forms_positive]
    form_targets = train["form_modal"][selected].astype(float)
    form_targets /= np.repeat(np.add.reduceat(form_targets, edges(form_groups)[:-1]), form_groups)
    form_x = np.column_stack((train["stem_x"][train["form_to_stem"][selected]], train["form_x"][selected]))
    valid_forms = np.column_stack((dev["stem_x"][dev["form_to_stem"]], dev["form_x"]))
    form_names = cache["stem_features"] + ["op_"+name for name in FORM_FEATURES]
    stem_targets = train["stem_modal"].astype(float)
    stem_totals = np.add.reduceat(stem_targets, edges(train["stem_groups"])[:-1])
    assert np.all(stem_totals > 0)
    stem_targets /= np.repeat(stem_totals, train["stem_groups"])
    parameters = {"metric": "None", "num_leaves": 63, "max_depth": 8, "min_data_in_leaf": 40,
                  "lambda_l2": 1, "learning_rate": .05, "num_threads": 1, "deterministic": True,
                  "force_col_wise": True, "feature_pre_filter": False, "seed": 51273, "verbosity": -1}
    ledger = {"plan": plan, "training_cases": len(train["stem_groups"]), "development_cases": 5351,
              "stem_training_shape": list(train["stem_x"].shape), "form_training_shape": list(form_x.shape),
              "form_development_shape": list(valid_forms.shape), "trials": []}
    write("operations-fit.json", ledger)
    print(json.dumps({"phase": "structured_fit", **{k: v for k, v in ledger.items() if k not in ("plan", "trials")}}), flush=True)
    best = 0
    for mode in plan["fit_modes"]:
        fitting = time.monotonic()
        continued = mode == "structured_continue_stems"
        initial = numeric_scores(train["stem_x"], base["trees"]) if continued else None
        initial_dev = numeric_scores(dev["stem_x"], base["trees"]) if continued else None
        stem_set = lgb.Dataset(train["stem_x"], label=stem_targets, group=train["stem_groups"], init_score=initial,
                               feature_name=cache["stem_features"], params={"feature_pre_filter": False})
        stem_valid = lgb.Dataset(dev["stem_x"], label=dev["stem_modal"], group=dev["stem_groups"],
                                 init_score=initial_dev, reference=stem_set)
        def stem_metric(scores, _):
            return "canonical_authored", float(dev["stem_any"][winners(scores, dev["stem_groups"])].sum())/5351, True
        fitted_stem = lgb.train({**parameters, "objective": objective(train["stem_groups"])}, stem_set,
                                num_boost_round=700, valid_sets=[stem_valid], feval=stem_metric,
                                callbacks=[lgb.early_stopping(80, first_metric_only=True, verbose=False)])
        stem_trees = (base["trees"] if continued else []) + [compact(tree["tree_structure"])
                     for tree in fitted_stem.dump_model()["tree_info"]]
        stem_scores = fitted_stem.predict(dev["stem_x"], raw_score=True, num_threads=1)
        if continued:
            stem_scores += initial_dev
        stem_error = float(np.max(np.abs(numeric_scores(dev["stem_x"], stem_trees)-stem_scores)))
        assert stem_error < 1e-10
        stem_log = log_probabilities(stem_scores, dev["stem_groups"])
        train_set = lgb.Dataset(form_x, label=form_targets, group=form_groups,
                                feature_name=form_names, params={"feature_pre_filter": False})
        valid_set = lgb.Dataset(valid_forms, label=dev["form_modal"], group=dev["form_groups"], reference=train_set)
        def form_metric(scores, _):
            joint = stem_log[dev["form_to_stem"]] + log_probabilities(scores, dev["form_groups"])
            selected = winners(joint, dev["case_groups"])
            return [("exact_authored", float(dev["form_any"][selected].sum())/5351, True),
                    ("exact_modal", float(dev["form_modal"][selected].sum())/5351, True)]
        fitted_form = lgb.train({**parameters, "num_leaves": 31, "max_depth": 6,
                                 "min_data_in_leaf": 60, "objective": objective(form_groups)}, train_set,
                                num_boost_round=700, valid_sets=[valid_set], feval=form_metric,
                                callbacks=[lgb.early_stopping(80, first_metric_only=True, verbose=False)])
        form_scores = fitted_form.predict(valid_forms, raw_score=True, num_threads=1)
        form_trees = [compact(tree["tree_structure"]) for tree in fitted_form.dump_model()["tree_info"]]
        form_error = float(np.max(np.abs(numeric_scores(valid_forms, form_trees)-form_scores)))
        assert form_error < 1e-10
        joint = stem_log[dev["form_to_stem"]] + log_probabilities(form_scores, dev["form_groups"])
        chosen = winners(joint, dev["case_groups"])
        good = dev["form_any"][chosen]
        canonical_good = dev["stem_any"][winners(stem_scores, dev["stem_groups"])]
        trial = {"mode": mode, "any": int(good.sum()), "modal": int(dev["form_modal"][chosen].sum()),
                 "canonical_any": int(canonical_good.sum()), "rows": 5351,
                 "gains": int(np.sum((good > 0) & (dev["baseline_correct"] == 0))),
                 "losses": int(np.sum((good == 0) & (dev["baseline_correct"] > 0))),
                 "stem_rounds": fitted_stem.best_iteration, "form_rounds": fitted_form.best_iteration,
                 "stem_export_error": stem_error, "form_export_error": form_error,
                 "gate_passed": int(good.sum()) >= plan["promotion_gate_matches"],
                 "seconds": round(time.monotonic()-fitting, 2)}
        ledger["trials"].append(trial)
        ledger["elapsed_seconds"] = round(time.monotonic()-started, 2)
        write("operations-fit.json", ledger)
        print(json.dumps(trial), flush=True)
        if int(good.sum()) > best:
            best = int(good.sum())
            write("operations-model.json", {"stem_trees": stem_trees, "form_trees": form_trees,
                  "stem_features": cache["stem_features"], "form_features": form_names,
                  "plan": plan, "selected": trial, "score_contract": "log P(canonical name|caption) + log P(surface|canonical name,caption,citation metadata)"})
        del fitted_stem, fitted_form, stem_set, stem_valid, train_set, valid_set
    print("complete declared structured-operation comparison", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("check", "prepare", "fit"))
    args = parser.parse_args()
    {"check": self_check, "prepare": prepare, "fit": fit}[args.stage]()
