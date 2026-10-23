"""Freeze base-target source review and untouched local evaluation sources.

Inputs and review packets stay in the ignored benchmark directory. This harness
never updates the installed database, model or original gold snapshot.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack, closing
import hashlib
import json
from pathlib import Path
import time

from base_targets import decompose, project, qualify
from mine import ROOT, data_root, normalize, readonly

PRIVATE = ROOT / "benchmarks/local-data/case-shortforms"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest(value):
    return hashlib.sha256(("base-names-v1:" + str(value)).encode()).digest()


def read(name):
    return json.loads((PRIVATE / name).read_text(encoding="utf-8"))


def save(name, value):
    (PRIVATE / name).write_text(json.dumps(value, ensure_ascii=False,
        separators=(",", ":")) + "\n", encoding="utf-8")


def inputs():
    protocol = read("clean-refit-protocol.json")
    assert sha(PRIVATE / "clean-refit-inputs.json") == protocol["input_sha256"]
    return protocol, read("clean-refit-inputs.json")["records"]


def reserve_sources():
    """Freeze unmined case documents before any new model or error inspection."""
    output = PRIVATE / "base-final-source-manifest.json"
    if output.exists():
        print("Existing final-source manifest preserved", flush=True)
        return
    protocol, rows = inputs()
    used_cases = {r["id"] for r in read("gold-original.json")["records"]}
    used_cases.update(r["id"] for r in rows)
    with ExitStack() as stack:
        index = stack.enter_context(closing(readonly(
            data_root() / "cache/case-shortforms/shortforms.sqlite")))
        paths = json.loads(index.execute("SELECT value FROM meta WHERE key='sources'").fetchone()[0])
        old_docs = {(p, id, lang) for p, id, lang in index.execute(
            "SELECT provider,local_id,language FROM source")}
        old_hashes = {h for h, in index.execute("SELECT sha256 FROM source")}
        source = stack.enter_context(closing(readonly(Path(paths["a2aj"]))))
        metadata = dict(source.execute("SELECT key,value FROM meta"))
        documents = []
        candidates = [r for r in source.execute("SELECT id,dataset,document_date_en FROM document"
            " WHERE doc_type='cases'") if any(("a2aj", r[0], lang) not in old_docs for lang in ("en", "fr"))]
        for id, dataset, date in candidates:
            en, fr = source.execute("SELECT unofficial_text_en,unofficial_text_fr FROM document WHERE id=?", (id,)).fetchone()
            for language, text in (("en", en), ("fr", fr)):
                if not text or ("a2aj", id, language) in old_docs:
                    continue
                h = hashlib.sha256(text.encode()).hexdigest()
                if h in old_hashes:
                    continue
                documents.append({"provider": "a2aj", "local_id": id, "language": language,
                    "sha256": h, "chars": len(text), "dataset": dataset, "date": date,
                    "own_case_has_previous_gold": id in used_cases})
        documents.sort(key=lambda r: (r["local_id"], r["language"]))
    manifest = {"schema": "case-shortforms.fresh-source-reservation.v1",
        "status": "source_hashes_frozen_before_mining_or_prediction_inspection",
        "frozen_input_sha256": protocol["input_sha256"], "provider_metadata": metadata,
        "documents": documents, "excluded_previous_gold_case_ids": sorted(used_cases),
        "requirements": ["Mine declarations without evaluating predictions or exposing error examples.",
            "Final targets must exclude all earlier gold cases and their litigation families.",
            "Deduplicate source texts and keep source/litigation components together.",
            "Remove final declaration documents and target cases from training and background inputs.",
            "Measure achieved independent target count and uncertainty before calling this sufficient final evidence."],
        "recipe_sha256": sha(Path(__file__))}
    save(output.name, manifest)
    print(json.dumps({"reserved_texts": len(documents), "reserved_documents": len({r['local_id'] for r in documents}),
        "reserved_chars": sum(r['chars'] for r in documents),
        "own_cases_without_previous_gold": len({r['local_id'] for r in documents if not r['own_case_has_previous_gold']}),
        "manifest_sha256": sha(output)}), flush=True)


def prepare_review():
    """Four hundred case/source-disjoint checks, without model predictions."""
    if (PRIVATE / "base-target-review-protocol.json").exists():
        raise FileExistsError("preserve the frozen review protocol and judgments")
    protocol, all_rows = inputs()
    rows = [r for r in all_rows if r["split"] in {"train", "development"} and r["left"] and r["right"]]
    groups = defaultdict(list)
    for record in rows:
        groups[record["left"], record["right"]].append(record)
    conflicts = set()
    for records in groups.values():
        labels = [set(project(r)["aliases"]) for r in records]
        if len(labels) > 1 and not set.intersection(*labels):
            conflicts.update((r["id"], r["language"]) for r in records)
    pools = defaultdict(list)
    for record in rows:
        changed = [norm for norm, a in record["aliases"].items()
                   if decompose(record, a["text"])["qualifiers"]]
        stratum = "transformed" if changed else "conflicting_inputs" if (
            record["id"], record["language"]) in conflicts else "unchanged_control"
        norms = changed or list(record["aliases"])
        norm = min(norms, key=lambda v: digest(("alias", record["identity"], record["language"], v)))
        pools[stratum].append((record, norm))
    with ExitStack() as stack:
        index = stack.enter_context(closing(readonly(
            data_root() / "cache/case-shortforms/shortforms.sqlite")))
        paths = json.loads(index.execute("SELECT value FROM meta WHERE key='sources'").fetchone()[0])
        sources = {p: stack.enter_context(closing(readonly(Path(path)))) for p, path in paths.items()}
        witnesses = defaultdict(list)
        for row in index.execute("SELECT x.case_id,x.normalized,s.provider,s.local_id,s.language,s.sha256,"
                "o.start,o.end,x.spelling FROM clean_observation x JOIN observation o"
                " ON o.case_id=x.original_case_id AND o.alias_id=x.original_alias_id"
                " AND o.source_id=x.source_id AND o.kind=x.kind JOIN source s ON s.id=x.source_id"
                " WHERE x.kind='definition' AND x.status='accepted' AND s.duplicate_of IS NULL"):
            witnesses[row[0], row[4], row[1]].append(row[2:])
        packets = {"discovery": [], "validation": []}
        used_cases, used_docs = set(), set()
        populations, skipped = {}, Counter()
        for stratum, count in (("transformed", 200), ("conflicting_inputs", 100), ("unchanged_control", 100)):
            pool = pools[stratum]
            populations[stratum] = len(pool)
            selected = 0
            for record, norm in sorted(pool, key=lambda v: digest(("row", v[0]["identity"], v[0]["language"]))):
                if record["id"] in used_cases:
                    skipped[stratum + "_case_reuse"] += 1
                    continue
                options = [w for w in witnesses[record["id"], record["language"], norm]
                           if (w[0], w[1]) not in used_docs]
                if not options:
                    skipped[stratum + "_no_new_source"] += 1
                    continue
                provider, local_id, language, h, start, end, spelling = min(options,
                    key=lambda v: digest(("source", v[:3])))
                query = "SELECT text FROM articles WHERE article_id=?" if provider == "journal" else (
                    "SELECT unofficial_text_" + language + " FROM document WHERE id=?")
                text = sources[provider].execute(query, (local_id,)).fetchone()[0]
                if hashlib.sha256(text.encode()).hexdigest() != h:
                    raise ValueError("review source changed since the frozen extraction")
                phase = "discovery" if selected % 2 == 0 else "validation"
                packet = packets[phase]
                packet.append({"number": len(packet), "stratum": stratum,
                    "identity": record["identity"], "case_id": record["id"], "language": language,
                    "left": record["left"], "right": record["right"], "citation": record["citation"],
                    "years": record["years"], "courts": record["courts"],
                    "proposal": decompose(record, spelling), "original_normalized": norm,
                    "provider": provider, "local_id": local_id, "sha256": h, "start": start, "end": end,
                    "context": text[max(0, start - 750):min(len(text), end + 230)],
                    "judgment": None, "note": ""})
                selected += 1
                used_cases.add(record["id"])
                used_docs.add((provider, local_id))
                if selected == count:
                    break
            assert selected == count, (stratum, selected)
    for phase, items in packets.items():
        save("base-target-review-" + phase + ".json", {"scope": phase + "; no model predictions",
            "reviewer": None, "judgments": ["supported", "wrong_projection", "wrong_owner_or_caption", "uncertain"],
            "items": items})
    save("base-target-review-protocol.json", {"input_sha256": protocol["input_sha256"],
        "rule_sha256": sha(Path(__file__).with_name("base_targets.py")), "runner_sha256": sha(Path(__file__)),
        "population_rows": len(rows), "stratum_populations": populations, "skipped_dependence": dict(skipped),
        "counts": {phase: dict(Counter(x['stratum'] for x in items)) for phase, items in packets.items()},
        "limits": ["Case/source-disjoint sampling conditions on available unused witnesses; report exclusions.",
            "Transformed rows select a changed alias; controls select an alias by an independent hash.",
            "Stratum-weighted estimates describe this reviewed alias policy, not complete target-set validity.",
            "Model-assisted source inspection is not independent human annotation.",
            "Validation judgments must not revise this frozen rule; revisions need fresh validation."]})
    print(json.dumps({"review_counts": {p: len(v) for p, v in packets.items()},
        "stratum_populations": populations, "skipped_dependence": dict(skipped)}), flush=True)


def operation_inventory():
    from operations import align_base
    protocol, rows = inputs()
    counts, rows_by_family, programs, unresolved = Counter(), defaultdict(set), [], []
    training = [qualify(r) for r in rows if r["split"] == "train" and r["left"] and r["right"]]
    for record in training:
        key = (record["identity"], record["language"])
        for norm, alias in record["aliases"].items():
            alignment = align_base(record, alias["text"])
            family = alignment["family"]
            counts[family] += 1
            rows_by_family[family].add(key)
            item = {"identity": key[0], "language": key[1], "normalized": norm,
                    "text": alias["text"], "alignment": alignment}
            (unresolved if family.startswith(("unresolved", "ambiguous")) else programs).append(item)
    save("base-operation-inventory.json", {"scope": "training labels only; mechanical alignments, not source adjudications or prediction gains",
        "input_sha256": protocol["input_sha256"], "base_rule_sha256": sha(Path(__file__).with_name("base_targets.py")),
        "operation_code_sha256": sha(Path(__file__).with_name("operations.py")),
        "training_rows": len(training), "alias_counts": dict(counts),
        "case_language_counts_overlapping": {k: len(v) for k, v in rows_by_family.items()},
        "programs": programs, "unresolved": unresolved})
    print(json.dumps({"training_rows": len(training), "alias_counts": dict(counts),
        "case_language_counts_overlapping": {k: len(v) for k, v in rows_by_family.items()}}), flush=True)


def freeze_targets():
    """Freeze eligible targets, exclusions and baseline predictions before fitting."""
    import inspect

    if (PRIVATE / "base-control-fit.json").exists():
        raise FileExistsError("preserve the fitted base-target comparison")
    protocol, rows = inputs()
    reviewed = read("base-target-review-protocol.json")
    assert hashlib.sha256(inspect.getsource(decompose).encode()).hexdigest() == reviewed["reviewed_decompose_sha256"]
    summaries, projected, exclusions = {}, [], []
    for split in ("train", "development"):
        selected = [qualify(r) for r in rows if r["split"] == split and r["left"] and r["right"]]
        counts = Counter()
        for row in selected:
            counts["source_rows"] += 1
            counts["eligible_rows"] += bool(row["aliases"])
            counts["eligible_aliases"] += len(row["aliases"])
            for declaration in row["flagged_declarations"]:
                counts[declaration["flag"]] += 1
                exclusions.append({"identity": row["identity"], "language": row["language"],
                    "split": split, **declaration})
        summaries[split] = dict(counts)
        projected.extend(selected)
    assert all(item["judgment"] is not None for phase in ("discovery", "validation")
               for item in read("base-target-review-" + phase + ".json")["items"])
    previous = read("clean-refit-evaluation.json")["predictions"]["development"]["baseline"]
    allowed = {(r["identity"], r["language"]): r for r in projected if r["split"] == "development"}
    baseline = Counter()
    for item in previous:
        row = allowed[item["identity"], item["language"]]
        norm = normalize(item["shortform"])
        baseline["eligible_rows"] += bool(row["aliases"])
        baseline["eligible_base_matches"] += bool(row["aliases"]) and norm in row["aliases"]
        originals = {original for a in row["aliases"].values() for original in a["original_normalized"]}
        baseline["eligible_original_form_matches"] += bool(row["aliases"]) and norm in originals
    save("base-target-inputs.json", {"schema": "case-shortforms.base-targets.v1", "records": projected})
    save("base-target-flags.json", {"scope": "never training or scored targets; originals and witnesses preserved",
        "counts": summaries, "declarations": exclusions})
    freeze = {"status": "targets_and_control_frozen_before_fitting", "original_input_sha256": protocol["input_sha256"],
        "input_sha256": sha(PRIVATE / "base-target-inputs.json"),
        "flags_sha256": sha(PRIVATE / "base-target-flags.json"),
        "baseline_model_sha256": protocol["baseline_model_sha256"],
        "baseline_development": dict(baseline), "cohorts": summaries,
        "source_reservation_sha256": sha(PRIVATE / "base-final-source-manifest.json"),
        "review_sha256": {phase: sha(PRIVATE / ("base-target-review-" + phase + ".json")) for phase in ("discovery", "validation")},
        "code_sha256": {name: sha(Path(__file__).with_name(name)) for name in (
            "base_targets.py", "evidence.py", "operations.py", "edit_decoder.py", "analyze.py", "shortform.py", "party_alias.py", "training_data.py")},
        "contract": "Context-independent authored base names with a supported party/caption edit or initialism relation. Document-local roles, dates, annotations and unresolved names are flagged and excluded from targets. A case with another eligible label remains evaluable.",
        "limits": ["Eligibility and target coverage are separate from model accuracy.",
            "Unresolved inputs and names require repair/source review; exclusion is not evidence of irreducible error.",
            "The earlier held-aside source packet validated trailing court/year projection, not every new eligibility rule.",
            "Development is reused evidence; fresh reserved-source targets are not yet mined or certified sufficient."],
        "control_recipe": protocol["recipe"], "background_sha256": protocol["background_sha256"],
        "selection": "development only; unchanged-recipe control on eligible base targets; no historical test scoring"}
    save("base-target-protocol.json", freeze)
    print(json.dumps({"cohorts": summaries, "baseline_development": dict(baseline)}), flush=True)


def freeze_set_comparison():
    """Isolate set-valued supervision from the proposal change on fixed targets."""
    name = "base-set-target-protocol.json"
    if (PRIVATE / name).exists():
        raise FileExistsError("preserve the frozen matched comparison")
    parent = read("base-target-protocol.json")
    for filename in ("base-control-fit.json", "base-editor-fit.json"):
        assert read(filename)["status"] == "complete"
    assert sha(PRIVATE / "base-target-inputs.json") == parent["input_sha256"]
    current = {filename: sha(Path(__file__).with_name(filename)) for filename in parent["code_sha256"]}
    assert all(value == parent["code_sha256"][filename] for filename, value in current.items() if filename != "analyze.py")
    save(name, {**parent, "parent_protocol_sha256": sha(PRIVATE / "base-target-protocol.json"),
        "code_sha256": current, "comparison": "Same eligible targets, case-balanced weights normalized to mean one, fixed numeric recipe; original proposals versus learned edits.",
        "selection": "One matched pair on reused development; no final-target predictions or promotion."})
    print(json.dumps({"frozen_matched_comparison_sha256": sha(PRIVATE / name)}), flush=True)


def fit_control(edit=False, set_targets=False):
    import analyze as a
    import training_data as td
    from party_alias import learn_party_names

    started = time.monotonic()
    prefix = ("base-set-editor" if edit else "base-set-control") if set_targets else ("base-editor" if edit else "base-control")
    protocol_name = "base-set-target-protocol.json" if set_targets else "base-target-protocol.json"
    frozen = read(protocol_name)
    assert sha(PRIVATE / "base-target-inputs.json") == frozen["input_sha256"]
    assert sha(td.BACKGROUND) == frozen["background_sha256"]
    for name, expected in frozen["code_sha256"].items():
        assert sha(Path(__file__).with_name(name)) == expected, name
    if (PRIVATE / (prefix + "-fit.json")).exists():
        raise FileExistsError("this fixed control already started; preserve its receipt")
    save(prefix + "-fit.json", {"status": "fitting", "protocol_sha256": sha(PRIVATE / protocol_name),
        "runner_sha256": sha(Path(__file__))})
    rows = read("base-target-inputs.json")["records"]
    training = [r for r in rows if r["split"] == "train" and r["aliases"]]
    development = [r for r in rows if r["split"] == "development" and r["aliases"]]
    tokens = a.retention(training)
    generic = sorted(r["token"] for r in tokens if r["cases"] >= 25 and r["retention"] <= .10)
    weak = a.weak_prefixes(training)
    encoding = a.token_retention(td.encoding_views(training, True)[0])
    model, sets, curve = a.fit(training, development, generic, weak, encoding, td.load_background(), edit=edit, set_targets=set_targets)
    assert model["fitting"]["version"] == frozen["control_recipe"]["library_version"]
    for i, stage in enumerate(model["fitting"]["stages"]):
        assert stage["parameters"] == frozen["control_recipe"]["stages"][i]
    names = learn_party_names(training, **frozen["control_recipe"]["party_name_policy"])
    model = {"schema": "case-shortform-ranker.v2", **model,
        "party_name_policy": frozen["control_recipe"]["party_name_policy"],
        "training": {"case_language_rows": len(training), "fitted_choice_sets": sets,
            "target_contract": frozen["contract"], "input_sha256": frozen["input_sha256"],
            "code_sha256": frozen["code_sha256"], "learned_party_names": len(names)}}
    save(prefix + "-model.json", model)
    save(prefix + "-party-names.json", names)
    predictions = []
    metrics, failures = a.evaluate(development, model, party_aliases=names, predictions=predictions)
    previous_name = "base-set-control-development.json" if set_targets and edit else "base-control-development.json"
    previous = (read(previous_name)["predictions"] if edit or set_targets else
                read("clean-refit-evaluation.json")["predictions"]["development"]["baseline"])
    paired = a.paired_comparison(development, predictions, {"test_predictions": previous, "non_test_identities": []})
    paired["method"] = "Same eligible development cases and targets; frozen baseline predictions; development reused for stopping. Case/party-pair grouped interval does not account for all shared-source dependence."
    receipt = {"status": "complete", "protocol_sha256": sha(PRIVATE / protocol_name),
        "runner_sha256": sha(Path(__file__)), "model_sha256": sha(PRIVATE / (prefix + "-model.json")),
        "party_names_sha256": sha(PRIVATE / (prefix + "-party-names.json")), "metrics": metrics,
        "paired_baseline": paired, "curve": curve, "seconds": round(time.monotonic() - started, 2),
        "scope": (f"Matched set-valued, case-balanced comparison with {'learned edits' if edit else 'original proposals'}; mean-one weights; reused development only" if set_targets else
                  "learned edit decoder with set-valued, case-balanced training; compared with the fixed base-target control; development only" if edit else
                  "unchanged recipe on eligible base-name targets; development only; data-contract control, not an editor gain or final evidence"),
        "promoted": False}
    save(prefix + "-development.json", {"predictions": predictions, "failures": failures})
    save(prefix + "-fit.json", receipt)
    print(json.dumps({k: v for k, v in receipt.items() if k not in {"curve", "paired_baseline"}}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("reserve", "review", "operations", "freeze", "control", "editor", "freeze-set", "set-control", "set-editor"))
    args = parser.parse_args()
    {"reserve": reserve_sources, "review": prepare_review, "operations": operation_inventory,
     "freeze": freeze_targets, "control": fit_control, "editor": lambda: fit_control(True),
     "freeze-set": freeze_set_comparison, "set-control": lambda: fit_control(set_targets=True),
     "set-editor": lambda: fit_control(edit=True, set_targets=True)}[args.stage]()
