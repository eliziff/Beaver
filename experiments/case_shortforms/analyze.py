"""Fit an interpretable name ranker; evaluate on held-out cases and party pairs."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import closing
import hashlib
import json
from pathlib import Path
import random
import statistics
import time

from mine import data_root, normalize, readonly, words
from shortform import FEATURES, WEAK_OPENINGS, baseline, candidates, core, generate, model_candidates, party_type, tree_score
from party_alias import learn_party_names, matches_party
from training_data import BACKGROUND, attach_citation_metadata, component_match, encoding_views, load_background


def gold(connection):
    records = {}
    query = """SELECT c.id,c.identity,c.citation,s.language,n.style,n.plaintiff,n.defendant,o.normalized,
               o.spelling,s.provider,s.local_id
      FROM clean_observation o JOIN source s ON s.id=o.source_id
      JOIN case_record c ON c.id=o.case_id
      LEFT JOIN case_profile n ON n.case_id=c.id AND n.language=s.language
      WHERE o.kind='definition' AND o.status='accepted' AND c.ambiguous=0 AND s.duplicate_of IS NULL
      ORDER BY c.identity,s.language,o.normalized,o.spelling"""
    for case_id, identity, citation, language, style, left, right, alias_id, spelling, provider, local_id in connection.execute(query):
        record = records.setdefault((case_id, language), {"id": case_id, "identity": identity, "language": language,
            "citation": citation, "style": style, "left": left, "right": right, "aliases": {}, "providers": set()})
        norm = normalize(spelling)
        alias = record["aliases"].setdefault(norm, {"documents": set(), "spellings": defaultdict(set)})
        document = (provider, local_id)
        alias["documents"].add(document)
        alias["spellings"][spelling].add(document)
        record["providers"].add(provider)
    result = []
    for record in records.values():
        for alias in record["aliases"].values():
            alias["document_ids"] = sorted(alias["documents"])
            alias["votes"] = len(alias.pop("documents"))
            alias["text"] = min(alias.pop("spellings").items(), key=lambda item: (-len(item[1]), len(item[0]), item[0]))[0]
        maximum = max(alias["votes"] for alias in record["aliases"].values())
        record["modal"] = {norm for norm, alias in record["aliases"].items() if alias["votes"] == maximum}
        record["max_votes"] = maximum
        record["providers"] = sorted(record["providers"])
        result.append(record)
    frozen = connection.execute("SELECT value FROM meta WHERE key='qualified_splits'").fetchone()
    if frozen:
        assignments = {(case, language): (split, group)
                       for case, language, split, group in json.loads(frozen[0])["assignments"]}
        for record in result:
            previous = assignments.get((record["id"], record["language"]))
            if previous:
                record["split"], record["split_group"] = previous
    return result


def assign_splits(records, reserve_audit=False):
    # All language versions, and cases sharing the same two party names, stay together.
    parent = {record["id"]: record["id"] for record in records}
    def root(case_id):
        while parent[case_id] != case_id:
            parent[case_id] = parent[parent[case_id]]
            case_id = parent[case_id]
        return case_id
    def union(first, second):
        first, second = root(first), root(second)
        parent[max(first, second)] = min(first, second)
    # Keep historical exposure when corrected identities or parties join groups.
    previous_groups = {}
    for record in records:
        if "split_group" in record:
            union(record["id"], previous_groups.setdefault(record["split_group"], record["id"]))
    seen = {}
    for record in records:
        if not record["left"] or not record["right"]:
            continue
        pair = (normalize(record["left"]), normalize(record["right"]))
        other = seen.setdefault(pair, record["id"])
        union(other, record["id"])
    identities = defaultdict(list)
    previous = defaultdict(list)
    for record in records:
        group = root(record["id"])
        identities[group].append(record["identity"])
        if "split" in record:
            previous[group].append((record["split"], record["split_group"]))
    anchors = {group: min(item[1] for item in previous[group]) if previous[group] else min(values)
               for group, values in identities.items()}
    for record in records:
        group = root(record["id"])
        record["split_group"] = anchors[group]
        digest = hashlib.sha256(record["split_group"].encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:4], "big") % 10
        prior_splits = {split for split, _ in previous[group]}
        if prior_splits:
            record["split"] = next(iter(prior_splits)) if len(prior_splits) == 1 else "quarantine"
        else:
            record["split"] = "test" if bucket < 2 else "development" if bucket == 2 else "train"
        if reserve_audit and record["split"] == "train" and encoding_fold(record, "case-shortforms-audit-v1:") == 0:
            record["split"] = "audit"


def encoding_fold(record, prefix="encoding-v1:"):
    digest = hashlib.sha256((prefix + record["split_group"]).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % 5


def alias_sides(record, norms=None, match=matches_party):
    result = set()
    for norm in norms or record["modal"]:
        alias = record["aliases"][norm]["text"]
        for side, name in enumerate((record["left"], record["right"])):
            if name and match(alias, name):
                result.add(side)
    return result


def retention(records):
    counts = defaultdict(Counter)
    for record in records:
        for norm in record["modal"]:
            alias_words = set(words(record["aliases"][norm]["text"]))
            sides = alias_sides(record, {norm})
            if len(sides) != 1:
                continue
            party = (record["left"], record["right"])[next(iter(sides))]
            tokens = words(party)
            if len(tokens) < 2:
                continue
            for token in set(tokens[1:]):
                counts[token]["cases"] += 1
                counts[token]["kept"] += int(token in alias_words)
    rows = [{"token": token, "cases": count["cases"], "kept": count["kept"],
             "retention": round(count["kept"] / count["cases"], 4)} for token, count in counts.items()]
    return sorted(rows, key=lambda row: (-row["cases"], row["token"]))


def weak_prefixes(records):
    counts = defaultdict(lambda: {"cases": 0, "used_alone": 0, "case_ids": set(),
                                  "alone_ids": set(), "parties": set()})
    for record in records:
        for norm in record["modal"]:
            sides = alias_sides(record, {norm})
            if len(sides) != 1:
                continue
            party = (record["left"], record["right"])[next(iter(sides))]
            tokens = words(party)
            if len(tokens) < 2:
                continue
            count = counts[tokens[0]]
            alone = words(record["aliases"][norm]["text"]) == [tokens[0]]
            count["cases"] += 1
            count["used_alone"] += alone
            count["case_ids"].add(record["id"])
            count["parties"].add(normalize(core(party)))
            if alone:
                count["alone_ids"].add(record["id"])
    return sorted(WEAK_OPENINGS | {token for token, count in counts.items() if
        (count["cases"] >= 25 and count["used_alone"] / count["cases"] <= 0.10) or
        (len(count["case_ids"]) >= 5 and len(count["parties"]) >= 2
         and len(count["alone_ids"]) / len(count["case_ids"]) <= 0.10)})


def party_selection(records, match=matches_party):
    """Learn party-name words that predict which side authors cite."""
    tokens, priors = defaultdict(Counter), defaultdict(Counter)
    identities = defaultdict(set)
    for record in records:
        sides = alias_sides(record, match=match)
        if len(sides) != 1:
            continue
        for side, party in enumerate((record["left"], record["right"])):
            selected = int(side in sides)
            prior = priors[f"{side}:{party_type(party)}"]
            prior["selected"] += selected
            prior["total"] += 1
            for word in set(words(core(party))):
                key = f"{side}:{word}"
                tokens[key]["selected"] += selected
                tokens[key]["total"] += 1
                identities[key].add(record["id"])
    return {"tokens": {key: [count["selected"], count["total"]] for key, count in sorted(tokens.items())
                       if len(identities[key]) >= 5},
            "priors": {key: count["selected"] / count["total"] for key, count in sorted(priors.items())}}


def context_statistics(records):
    """Learn word decisions conditional on position, party type and the opponent."""
    tables = defaultdict(lambda: defaultdict(lambda: [0.0, 0]))
    frequency = Counter()
    for record in records:
        frequency.update(record["aliases"].keys())
        for party in (record["left"], record["right"]):
            tokens, kind, seen = words(core(party)), party_type(party), set()
            for start in range(len(tokens)):
                for end in range(start + 1, len(tokens) + 1):
                    text = "".join(tokens[start:end])
                    if text in seen:
                        continue
                    seen.add(text)
                    for table, key in (("phrase", text), ("phrase_typed", kind + ":" + text)):
                        value = tables[table][key]
                        value[0] += text in record["aliases"]
                        value[1] += 1
        sides = alias_sides(record, match=component_match)
        if len(sides) != 1:
            continue
        picked = next(iter(sides))
        parties = (record["left"], record["right"])
        for side, party in enumerate(parties):
            kind, other = party_type(party), party_type(parties[1-side])
            tokens = words(core(party))
            for token in set(tokens):
                for table, key in (("select_type", f"{side}:{kind}:{token}"),
                                   ("select_pair", f"{side}:{kind}:{other}:{token}")):
                    value = tables[table][key]
                    value[0] += side == picked
                    value[1] += 1
            if side != picked:
                continue
            labels = [set(words(record["aliases"][norm]["text"])) for norm in record["modal"]]
            labels = [label for label in labels if label & set(tokens)]
            if not labels:
                continue
            for index, word in enumerate(tokens):
                position = "first" if index == 0 else "last" if index == len(tokens)-1 else "middle"
                kept = sum(word in label for label in labels) / len(labels)
                for table, key in (("typed", f"{kind}:{position}:{word}"), ("last", f"{position}:{word}")):
                    value = tables[table][key]
                    value[0] += kept
                    value[1] += 1
            for first, second in zip(tokens, tokens[1:]):
                value = tables["bigram"][first + " " + second]
                value[0] += sum(first in label and second in label for label in labels) / len(labels)
                value[1] += 1
            ordered = [words(record["aliases"][norm]["text"]) for norm in record["modal"]]
            ordered = [label for label in ordered if label and all(word in tokens for word in label)]
            if not ordered:
                continue
            for index, word in enumerate(tokens):
                before = (tokens[index-1] if index else "^") + " " + word
                after = word + " " + (tokens[index+1] if index+1 < len(tokens) else "$")
                kept = sum(word in label for label in ordered) / len(ordered)
                start = sum(word == label[0] for label in ordered) / len(ordered)
                end = sum(word == label[-1] for label in ordered) / len(ordered)
                for table, key, target in (("before", before, kept), ("after", after, kept),
                        ("start_before", before, start), ("start_after", after, start),
                        ("end_before", before, end), ("end_after", after, end)):
                    value = tables[table][key]
                    value[0] += target
                    value[1] += 1
    phrase_tables = {"phrase", "phrase_typed", "before", "after", "start_before", "start_after", "end_before", "end_after"}
    result = {table: {key: value for key, value in values.items() if value[1] >= (2 if table in phrase_tables else 5)}
              for table, values in tables.items()}
    result["alias_frequency"] = {key: count for key, count in frequency.items() if count >= 2}
    return result



def token_retention(records):
    """Learn which first and later words survive, with party-type backoff."""
    tokens, priors = defaultdict(Counter), defaultdict(Counter)
    for record in records:
        sides = alias_sides(record, match=component_match)
        if len(sides) != 1:
            continue
        party = (record["left"], record["right"])[next(iter(sides))]
        name = words(core(party))
        if len(name) < 2:
            continue
        labels = [set(words(record["aliases"][norm]["text"])) for norm in record["modal"]]
        labels = [label for label in labels if label & set(name)]
        if not labels:
            continue
        for index, word in enumerate(name):
            position = "first" if index == 0 else "other"
            kept = sum(word in label for label in labels) / len(labels)
            for count in (tokens[position + ":" + word], priors[party_type(party) + ":" + position]):
                count["kept"] += kept
                count["total"] += 1
    return {"tokens": {word: [round(count["kept"], 4), count["total"]] for word, count in sorted(tokens.items())
                       if count["total"] >= 5},
            "priors": {kind: round(count["kept"] / count["total"], 6) for kind, count in sorted(priors.items())},
            "party_selection": party_selection(records, match=component_match), "context": context_statistics(records)}


def fit(records, development, generic, weak_heads, retention, background, edit=False, set_targets=False,
        objective="lambdarank", control_training=False):
    from array import array
    import lightgbm as lgb
    import numpy as np

    popularity = objective == "lambdarank"
    gains = sorted({0} | {alias["votes"] for row in records + development for alias in row["aliases"].values()})
    gain_labels = {votes: index for index, votes in enumerate(gains)}
    views, _ = encoding_views(records, True)
    encodings = [token_retention([record for record in views if encoding_fold(record) != fold]) for fold in range(5)]
    name_encodings = [learn_party_names([record for record in records if encoding_fold(record) != fold],
                         minimum_cases=1, minimum_documents=1, minimum_share=0) for fold in range(5)]
    full_names = learn_party_names(records, minimum_cases=1, minimum_documents=1, minimum_share=0)
    if edit:
        from edit_decoder import learn, propose
        decoders = [learn([record for record in records if encoding_fold(record) != fold]) for fold in range(5)]
        decoder = learn(records)

    fitted_training_keys = []

    def dataset(rows, training=False):
        values, labels, authored, modal, groups, weights, support = array("d"), [], [], [], [], [], []
        for ordinal, record in enumerate(rows, 1):
            encoding = encodings[encoding_fold(record)] if training else retention
            names = name_encodings[encoding_fold(record)] if training else full_names
            extra = propose(record, decoders[encoding_fold(record)] if training else decoder) if edit else None
            choices = sorted(candidates(record["left"], record["right"], generic, weak_heads, encoding, names, background, extra=extra),
                             key=lambda choice: (len(choice.text), choice.side, normalize(choice.text), choice.text))
            positives = [int(normalize(choice.text) in (record["aliases"] if popularity or edit or set_targets else record["modal"])) for choice in choices]
            if training and control_training:
                original = [i for i, choice in enumerate(choices) if not choice.kind.startswith("edit_")]
                if len(original) < 2 or not any(positives[i] for i in original):
                    continue
            if training and (len(choices) < 2 or not any(positives)):
                continue
            if training:
                fitted_training_keys.append((record["identity"], record["language"]))
            if not choices:
                values.extend([0.] * len(FEATURES))
                groups.append(1)
                labels.append(0)
                authored.append(0)
                modal.append(0)
                weights.append(1.)
                support.append(0.)
                continue
            groups.append(len(choices))
            votes = [record["aliases"].get(normalize(choice.text), {}).get("votes", 0) for choice in choices]
            if popularity:
                labels.extend(gain_labels[count] for count in votes)
            else:
                labels.extend(positives)
            authored.extend(int(normalize(choice.text) in record["aliases"]) for choice in choices)
            modal.extend(int(normalize(choice.text) in record["modal"]) for choice in choices)
            support.extend(count / record["max_votes"] for count in votes)
            weights.extend([1 / len(choices)] * len(choices))
            for choice in choices:
                values.extend(choice.features)
            if ordinal % 5000 == 0:
                print(f"fit: {'training' if training else 'development'} {ordinal}/{len(rows)} rows, {len(labels)} candidates", flush=True)
        return (np.frombuffer(values, dtype=np.float64).reshape((-1, len(FEATURES))),
                np.asarray(labels), np.asarray(authored), np.asarray(modal), np.asarray(groups),
                np.asarray(weights) if not popularity and (edit or set_targets) else None, np.asarray(support))

    training_x, training_y, _, _, training_groups, training_weights, _ = dataset(records, True)
    development_x, development_y, development_any, development_modal, development_groups, _, development_support = dataset(development)
    if training_weights is not None and set_targets:
        # Equal case influence must not silently multiply the fixed L2 penalty.
        training_weights *= len(training_weights) / training_weights.sum()
    print(f"fit: {len(training_groups)} choice sets, {len(training_x)} candidates; grouped statistics cached", flush=True)
    starts = np.r_[0, np.cumsum(development_groups)]

    def selected(scores):
        maximum = np.maximum.reduceat(scores, starts[:-1])
        return np.minimum.reduceat(np.where(scores == np.repeat(maximum, development_groups),
                    np.arange(len(scores)), len(scores)), starts[:-1])

    def accuracy(scores, _):
        indices = selected(scores)
        return [("modal_top1", float(development_modal[indices].sum()) / len(development), True),
                ("source_support_top1", float(development_support[indices].sum()) / len(development), True),
                ("authored_top1", float(development_any[indices].sum()) / len(development), True)]

    def compact(node):
        if "leaf_value" in node:
            return node["leaf_value"]
        assert node["decision_type"] == "<=", "only numeric feature splits are supported"
        return [node["split_feature"], node["threshold"], compact(node["left_child"]), compact(node["right_child"])]

    def scores(matrix, trees):
        return np.asarray([tree_score(row, trees) for row in matrix])

    trees, stages, history = [], [], {}
    best = (-1, -1., -1)
    feature_gain = {name: 0. for name in FEATURES}
    for continued in (False, True):
        names = list(FEATURES)
        train_x, valid_x = training_x, development_x
        initial = fitted.predict(training_x, raw_score=True, num_threads=1) if continued else None
        initial_dev = native if continued else None
        train = lgb.Dataset(train_x, label=training_y, group=training_groups, init_score=initial,
                            weight=training_weights, feature_name=names, params={"feature_pre_filter": False})
        valid = lgb.Dataset(valid_x, label=development_y, group=development_groups, init_score=initial_dev, reference=train)
        parameters = {"objective": objective, "metric": "None", "feature_pre_filter": False,
            "num_leaves": 31 if continued else 63, "max_depth": 6 if continued else 8,
            "min_data_in_leaf": 60 if continued else 40, "lambda_l2": 1, "learning_rate": .05,
            "num_threads": 1, "deterministic": True, "force_col_wise": True, "seed": 51273, "verbosity": -1}
        if popularity:
            parameters["label_gain"] = gains
        curve = {}
        fitted = lgb.train(parameters, train, num_boost_round=700, valid_sets=[valid], feval=accuracy,
            callbacks=[lgb.early_stopping(80, first_metric_only=True, verbose=False), lgb.record_evaluation(curve)])
        proposed = trees + [compact(tree["tree_structure"]) for tree in fitted.dump_model()["tree_info"]]
        exported = scores(development_x, proposed)
        native = fitted.predict(valid_x, raw_score=True, num_threads=1) + (initial_dev if continued else 0.)
        error = float(np.max(np.abs(native-exported)))
        assert error < 1e-10, "exported ranker differs from the training library"
        indices = selected(exported)
        count = int(development_modal[indices].sum())
        score = (count, float(development_support[indices].sum()), int(development_any[indices].sum()))
        stage = {"continued": continued, "parameters": parameters, "boosting_rounds": fitted.best_iteration,
                 "development_matches": count, "development_source_support": score[1],
                 "development_any_matches": score[2], "export_max_absolute_error": error, "selected": score > best}
        history["continued" if continued else "base"] = curve
        if score > best:
            trees, best = proposed, score
            stages.append(stage)
            for name, gain in zip(names, fitted.feature_importance(importance_type="gain")):
                feature_gain[name] += float(gain)
        print(f"fit: {'continued' if continued else 'base'} {count}/{len(development)} in {fitted.best_iteration} rounds", flush=True)
    model = {"trees": trees, "features": list(FEATURES), "generic_tokens": generic, "weak_heads": weak_heads,
        "token_retention": retention, "background_statistics": background,
        "fitting": {"library": "lightgbm", "version": lgb.__version__, "stages": stages,
            "boosting_rounds": len(trees),
            "target": "source-document counts with linear ranking gain" if popularity else (
                "any eligible base name; case-balanced binary ranking" if edit or set_targets else "modal authored labels; pointwise binary ranking"),
            "selection": "modal top-one first; relative source-document support and any-attested agreement break stage ties",
            "case_weight_scale": "query-normalized ranking; uniform row weights" if popularity else
                "mean one" if set_targets else "sum one per case" if edit else "unweighted candidates",
            "training_inclusion": "control-reachable choice sets" if control_training else "reachable choice sets",
            "training_choice_keys_sha256": hashlib.sha256(json.dumps(fitted_training_keys, separators=(",", ":")).encode()).hexdigest(),
            "word_statistics": "five grouped out-of-fold word-form/component encodings; original labels and exact-party evidence unchanged",
            "scores": "raw tree margins for ordering; not calibrated confidence",
            "export_max_absolute_error": max(stage["export_max_absolute_error"] for stage in stages), "feature_gain": feature_gain}}
    if edit:
        model["edit_decoder"] = decoder
    return model, len(training_groups), history


def evaluate(records, model=None, use_government=False, party_aliases=None, predictions=None):
    counts = Counter()
    lengths = []
    failures = []
    for record in records:
        if model:
            context = {"style": record.get("style") or "", "language": record["language"]}
            selected = generate(record["left"], record["right"], model, party_aliases=party_aliases, **context)
            available = model_candidates(record["left"], record["right"], model, party_aliases, **context)
            text, side = selected["shortform"], selected["side"]
            ceiling = any(normalize(choice.text) in record["aliases"] for choice in available)
            counts["modal_candidate_ceiling_matches"] += int(any(normalize(choice.text) in record["modal"] for choice in available))
            counts["attested_party_names_used"] += int(selected["method"] == "generated_attested_party")
        else:
            text = baseline(record["left"], record["right"], use_government)
            side = 1 if normalize(text) == normalize(baseline(None, record["right"])) else 0
            ceiling = False
        if predictions is not None:
            predictions.append({"identity": record["identity"], "language": record["language"],
                                "shortform": text, "side": side})
        norm = normalize(text)
        counts["cases"] += 1
        counts["modal_matches"] += int(norm in record["modal"])
        counts["any_authored_matches"] += int(norm in record["aliases"])
        counts["source_support"] += record["aliases"].get(norm, {}).get("votes", 0) / record["max_votes"]
        counts["candidate_ceiling_matches"] += int(ceiling)
        sides = alias_sides(record)
        if sides:
            counts["party_choice_evaluable"] += 1
            counts["party_choice_correct"] += int(side in sides)
        lengths.append(len(text))
        counts["at_most_30_chars"] += int(len(text) <= 30)
        if norm not in record["aliases"]:
            failures.append({"identity": record["identity"], "language": record["language"],
                             "left": record["left"], "right": record["right"], "generated": text,
                             "observed": [alias["text"] for alias in record["aliases"].values()]})
    result = dict(counts)
    if records:
        for key in ("modal_matches", "any_authored_matches", "candidate_ceiling_matches", "modal_candidate_ceiling_matches", "source_support", "at_most_30_chars"):
            result[key + "_rate"] = round(counts[key] / len(records), 5)
        result["party_choice_accuracy"] = round(counts["party_choice_correct"] / max(1, counts["party_choice_evaluable"]), 5)
        result["median_chars"] = statistics.median(lengths)
        result["p90_chars"] = sorted(lengths)[int(0.9 * (len(lengths)-1))]
    return result, failures


def paired_comparison(records, predictions, previous):
    """Score frozen predictions on common, uncontaminated held-out cases and current labels."""
    old = {(row["identity"], row["language"]): row for row in previous["test_predictions"]}
    current = {(row["identity"], row["language"]): row for row in predictions}
    non_test = set(previous["non_test_identities"])
    excluded = {record["split_group"] for record in records if record["identity"] in non_test}
    before, after, changes = Counter(), Counter(), Counter()
    slices = defaultdict(Counter)
    grouped_scores = defaultdict(lambda: [0, 0, 0])
    identities, groups = set(), set()
    for record in records:
        key = (record["identity"], record["language"])
        if key not in old or key not in current or record["split_group"] in excluded:
            continue
        identities.add(record["identity"])
        groups.add(record["split_group"])
        kind = party_type(record["left"])
        slices[kind]["rows"] += 1
        for label, allowed in (("any_authored", record["aliases"]), ("modal", record["modal"])):
            was = normalize(old[key]["shortform"]) in allowed
            now = normalize(current[key]["shortform"]) in allowed
            if label == "any_authored":
                score = grouped_scores[record["split_group"]]
                score[0] += 1
                score[1] += int(was)
                score[2] += int(now)
            before[label + "_matches"] += was
            after[label + "_matches"] += now
            changes[label + "_gains"] += now and not was
            changes[label + "_losses"] += was and not now
            slices[kind]["before_" + label + "_matches"] += was
            slices[kind]["after_" + label + "_matches"] += now
    rows = sum(value["rows"] for value in slices.values())
    for metrics in (before, after):
        for label in ("any_authored", "modal"):
            metrics[label + "_match_rate"] = round(metrics[label + "_matches"] / max(1, rows), 5)
    intervals = {}
    if grouped_scores:
        rng = random.Random(93820)
        values = list(grouped_scores.values())
        samples = {"before_rate": [], "after_rate": [], "delta_points": []}
        for _ in range(1000):
            total = before_total = after_total = 0
            for _ in values:
                count, was, now = rng.choice(values)
                total += count
                before_total += was
                after_total += now
            samples["before_rate"].append(before_total / total)
            samples["after_rate"].append(after_total / total)
            samples["delta_points"].append(100 * (after_total - before_total) / total)
        intervals = {key: [round(sorted(values)[24], 5), round(sorted(values)[974], 5)]
                     for key, values in samples.items()}
    return {"method": "frozen predictions; shared held-out identities/languages; current qualified labels; "
                      "exclude groups containing a previous training/development identity",
            "rows": rows, "case_identities": len(identities), "case_party_groups": len(groups),
            "before": dict(before), "after": dict(after), **changes,
            "group_bootstrap_95ci": {"groups": "case and exact party-pair components", "resamples": 1000,
                                      "seed": 93820, **intervals},
            "leading_party_slices": {kind: dict(count) for kind, count in sorted(slices.items())}}


def author_variation(records):
    counts, rates = Counter(), []
    for record in records:
        votes = {norm: set(map(tuple, alias["document_ids"])) for norm, alias in record["aliases"].items()}
        documents = set().union(*votes.values())
        if len(documents) < 2:
            continue
        counts["case_language_rows"] += 1
        counts["rows_with_variants"] += int(len(votes) > 1)
        correct = 0
        for document in documents:
            selected = min(votes, key=lambda norm: (-(len(votes[norm]) - int(document in votes[norm])),
                                                    len(record["aliases"][norm]["text"]), norm))
            correct += int(document in votes[selected])
        counts["case_document_pairs"] += len(documents)
        counts["held_document_matches"] += correct
        rates.append(correct / len(documents))
    return {"scope": "training and development only; at least two distinct documents",
            "prediction": "modal alias from other documents; shortest-label tie break",
            "counts": dict(counts),
            "document_weighted_agreement": counts["held_document_matches"] / max(1, counts["case_document_pairs"]),
            "case_language_macro_agreement": statistics.mean(rates) if rates else None}


def analyze(database: Path, output: Path, model_path: Path, baseline_path: Path | None = None, evaluation="none", background_path=BACKGROUND):
    from base_targets import qualify

    started = time.monotonic()
    with closing(readonly(database)) as connection:
        meta = {key: json.loads(value) for key, value in connection.execute("SELECT * FROM meta")}
        records = gold(connection)
        attach_citation_metadata(connection, records)
        corpus = {"case_inventory": connection.execute("SELECT count(*) FROM case_record").fetchone()[0],
                  "case_identities_with_any_observation": connection.execute("SELECT count(distinct case_id) FROM observation").fetchone()[0],
                  "case_identities_with_definitions": connection.execute("SELECT count(distinct case_id) FROM observation WHERE kind='definition'").fetchone()[0],
                  "normalized_aliases": connection.execute("SELECT count(*) FROM alias").fetchone()[0],
                  "case_alias_pairs": connection.execute("SELECT count(*) FROM (SELECT DISTINCT case_id,alias_id FROM observation)").fetchone()[0],
                  "evidence_rows": connection.execute("SELECT count(*) FROM observation").fetchone()[0],
                  "ambiguous_provider_keys": connection.execute("SELECT count(*) FROM ambiguous_key").fetchone()[0],
                  "alias_collision_names": connection.execute("SELECT count(*) FROM (SELECT alias_id FROM observation GROUP BY alias_id HAVING count(distinct case_id)>1)").fetchone()[0],
                  "size_bytes": database.stat().st_size}
        corpus["qualified_case_identities_with_definitions"] = len({record["id"] for record in records})
        corpus["prepared"] = {"case_profiles": connection.execute("SELECT count(*) FROM case_profile").fetchone()[0],
            "case_alias_rows": connection.execute("SELECT count(*) FROM case_alias").fetchone()[0],
            "case_identities_with_names": connection.execute("SELECT count(DISTINCT case_id) FROM case_shortform"
                " WHERE method<>'citation_fallback'").fetchone()[0],
            "methods": dict(connection.execute("SELECT method,count(*) FROM case_shortform GROUP BY method"))}
    party_methods = Counter("prepared_parties" if record["left"] and record["right"] else
                            "nonadversarial_or_missing_caption" for record in records)
    assign_splits(records, reserve_audit=evaluation != "test")
    qualified = [qualify(record) for record in records if record["left"] and record["right"]]
    usable = [record for record in qualified if record["aliases"]]
    splits = {split: [record for record in usable if record["split"] == split]
              for split in ("train", "development", "test", "audit")}
    if not splits["train"] or not splits["development"]:
        raise ValueError("not enough independently split cases to fit and evaluate a model")
    tokens = retention(splits["train"])
    generic = sorted(row["token"] for row in tokens if row["cases"] >= 25 and row["retention"] <= 0.10)
    weak_heads = weak_prefixes(splits["train"])
    fitted_model, fitted, learning_curve = fit(splits["train"], splits["development"], generic, weak_heads,
                                               token_retention(encoding_views(splits["train"], True)[0]), load_background(background_path),
                                               edit=True, set_targets=True)
    model = {"schema": "case-shortform-ranker.v2", **fitted_model,
             "training": {"case_language_rows": len(splits["train"]), "fitted_choice_sets": fitted,
                          "split": "sha256; 70/10/20; case and exact party-pair groups" +
                              ("; repaired-data partitions preserved; mixed exposures quarantined" if "qualified_splits" in meta else "") +
                              ("; one fifth of training groups reserved for audit; earlier scores are known" if evaluation != "test" else ""),
                          "code_sha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                          for name in ("analyze.py", "base_targets.py", "training_data.py", "evidence.py", "shortform.py", "edit_decoder.py", "operations.py", "party_alias.py", "mine.py", "parser.mjs", "prepare.py")},
                          "text_stream_sha256": meta["text_stream_sha256"], "native_sha256": meta["engine"]["nativeSha256"]}}
    base_development = evaluate(splits["development"], model)[0]
    party_trials = []
    selected_names = {}
    selected_policy = None
    best_score = (base_development["modal_matches"], base_development["source_support"], base_development["any_authored_matches"], 0)
    for minimum_cases, minimum_documents, minimum_share in ((1, 1, 0), (2, 2, 0.6), (2, 2, 0.75), (2, 2, 0.9),
                                                           (3, 5, 0.6), (3, 5, 0.75), (3, 5, 0.9)):
        policy = {"minimum_cases": minimum_cases, "minimum_documents": minimum_documents, "minimum_share": minimum_share}
        learned = learn_party_names(splits["train"], **policy)
        metrics = evaluate(splits["development"], model, party_aliases=learned)[0]
        party_trials.append({"policy": policy, "party_names": len(learned), **metrics})
        score = (metrics["modal_matches"], metrics["source_support"], metrics["any_authored_matches"], -len(learned))
        if score > best_score:
            selected_names, selected_policy, best_score = learned, policy, score
    model["party_name_policy"] = selected_policy
    model["training"]["learned_party_names"] = len(selected_names)
    test = splits[evaluation] if evaluation != "none" else []
    baseline_metrics, _ = evaluate(test)
    exception_metrics, _ = evaluate(test, use_government=True)
    ranker_metrics, _ = evaluate(test, model)
    predictions = []
    learned_metrics, failures = evaluate(test, model, party_aliases=selected_names, predictions=predictions)
    slices = {}
    for kind in ("crown", "government", "numbered", "corporate", "ordinary"):
        subset = [record for record in test if party_type(record["left"]) == kind]
        slices["leading_" + kind] = evaluate(subset, model, party_aliases=selected_names)[0]
    for language in ("en", "fr"):
        slices[language] = evaluate([record for record in test if record["language"] == language], model, party_aliases=selected_names)[0]
    for provider in ("journal", "a2aj"):
        slices[provider] = evaluate([record for record in test if provider in record["providers"]], model, party_aliases=selected_names)[0]
    slices["alias_supported_by_two_documents"] = evaluate([record for record in test if record["max_votes"] >= 2], model, party_aliases=selected_names)[0]
    for multiple in (False, True):
        subset = [record for record in test if (len({tuple(document) for alias in record["aliases"].values()
                  for document in alias["document_ids"]}) >= 2) == multiple]
        slices["at_least_two_documents" if multiple else "one_document"] = evaluate(subset, model, party_aliases=selected_names)[0]
    selection = defaultdict(Counter)
    descriptive = [record for record in usable if record["split"] in {"train", "development"}]
    for record in descriptive:
        if not record["left"] or not record["right"]:
            continue
        sides = alias_sides(record)
        if len(sides) == 1:
            selection[party_type(record["left"])]["cases"] += 1
            selection[party_type(record["left"])]["second_party"] += int(sides == {1})
    labels = [alias["text"] for record in descriptive for alias in record["aliases"].values()]
    repeated = [record for record in descriptive if len({document for alias in record["aliases"].values()
                for document in alias["document_ids"]}) >= 2]
    report = {"scope": "complete installed texts" if meta["sampling"] == {"every": 1, "limit_per_provider": 0} else "pilot",
              "corpus": corpus, "mining": meta, "gold": {"case_language_rows": len(records),
              "usable_parsed_party_rows": len(usable), "party_methods": dict(party_methods),
              "unparsed_or_nonadversarial_rows": len(records)-len(qualified),
              "without_eligible_base_targets": len(qualified)-len(usable),
              "flagged_base_declarations": dict(Counter(d["flag"] for record in qualified for d in record["flagged_declarations"])),
              "quarantined_case_language_rows": sum(record["split"] == "quarantine" for record in usable),
              "split_rows": {key: len(value) for key, value in splits.items()},
              "split_case_ids": {key: len({record['id'] for record in value}) for key, value in splits.items()}},
              "author_variation": author_variation(descriptive),
              "observed": {"scope": "training and development only", "multi_document_case_language_rows": len(repeated),
                           "multi_document_rows_with_variant_labels": sum(len(record["aliases"]) > 1 for record in repeated),
                           "multi_document_rows_with_tied_modal_labels": sum(len(record["modal"]) > 1 for record in repeated),
                           "median_alias_chars": statistics.median(map(len, labels)),
                           "single_word_alias_rate": sum(len(words(label)) == 1 for label in labels) / len(labels),
                           "party_selection": {kind: dict(count) for kind, count in selection.items()}},
              "token_retention_train_only": tokens,
              "development_learning_curve": learning_curve, "development_ranker": base_development,
              "boosting_rounds": model["fitting"]["boosting_rounds"],
              "development_party_name_trials": party_trials, "selected_party_name_policy": selected_policy,
              "evaluation_split": evaluation,
              "test": {"first_party_legal_suffix_only": baseline_metrics,
                       "government_numbered_exception": exception_metrics, "ranker_without_party_memory": ranker_metrics,
                       "learned_ranker": learned_metrics,
                       "slices": slices},
              "model_sha256": hashlib.sha256(json.dumps(model, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest(),
              "model_training": model["training"],
              "test_predictions": predictions,
              "non_test_identities": sorted({record["identity"] for record in usable if record["split"] in {"train", "development"}}),
              "test_mismatches": failures,
              "limits": ["Exact authored-alias agreement measures imitation, not all acceptable shortforms.",
                         "Targets are qualified authored declarations, not generated names or parser shortName values; source/key errors remain possible.",
                         "Nonadversarial title shortening is outside the held-out two-party evaluation.",
                         "Document-local labels and uncertain source-key merges are excluded from global gold.",
                         "The screen census is bounded by the owning grammar; unmatched references remain unresolved."]}
    if baseline_path and evaluation != "none":
        previous = json.loads(baseline_path.read_text(encoding="utf-8"))
        report["paired_previous_run"] = {"baseline_model_sha256": previous["model_sha256"],
            "baseline_training": previous["model_training"],
            **paired_comparison(usable, predictions, previous)}
    report["elapsed_seconds"] = round(time.monotonic() - started, 2)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    model_path.write_text(json.dumps(model, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"evaluation_split": evaluation, "corpus": corpus, "gold": report["gold"], "observed": report["observed"],
                      "test": {key: value for key, value in report["test"].items() if key != "slices"},
                      "boosting_rounds": model["fitting"]["boosting_rounds"], "generic_tokens": generic, "weak_heads": weak_heads}, indent=2, ensure_ascii=True))
    return report, model


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=data_root() / "cache/case-shortforms/shortforms.sqlite")
    parser.add_argument("--output", type=Path, help="private receipt; defaults to development.json or analysis.json")
    parser.add_argument("--model", type=Path, default=Path(__file__).with_name("model.json"))
    parser.add_argument("--baseline", type=Path, help="previous private analysis receipt for paired held-out comparison")
    parser.add_argument("--evaluate", choices=("audit", "test"), help="score a frozen candidate; default fits/develops without holdout evaluation")
    parser.add_argument("--background", type=Path, default=BACKGROUND, help="training word counts; regenerate with training_data.py")
    args = parser.parse_args()
    output = args.output or Path("benchmarks/local-data/case-shortforms") / ("analysis.json" if args.evaluate else "development.json")
    analyze(args.database, output, args.model, args.baseline, args.evaluate or "none", args.background)
