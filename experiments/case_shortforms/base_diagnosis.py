"""Explain fixed development gains, regressions and remaining errors privately."""
import argparse
from collections import Counter, defaultdict
import time

from base_batch import PRIVATE, read, save, sha
import edit_decoder as edits
from mine import normalize
from operations import align_base
import shortform as short


def proposals(record, model, names):
    if "edit_decoder" in model:
        return edits.choices(record, model, names)
    return short.candidates(record["left"], record["right"], model["generic_tokens"],
        model["weak_heads"], model["token_retention"], names, model["background_statistics"])


def ranked(choices, model):
    return sorted(((short.tree_score(c.features, model["trees"]), c) for c in choices),
        key=lambda v: (-v[0], len(v[1].text), v[1].side, normalize(v[1].text), v[1].text))


def target_sides(record):
    result = set()
    for alias in record["aliases"].values():
        alignment = align_base(record, alias["text"])
        for value in alignment.get("alternatives", [alignment]):
            if "side" in value:
                result.add(value["side"])
            elif value["family"] == "joint_party_edit":
                result.update((0, 1))
    return result


def diagnose(candidate="base-editor"):
    baseline = "base-set-control" if candidate == "base-set-editor" else "base-control"
    prefixes = baseline, candidate
    receipts = [read(prefix + "-fit.json") for prefix in prefixes]
    models = [read(prefix + "-model.json") for prefix in prefixes]
    names = [read(prefix + "-party-names.json") for prefix in prefixes]
    for prefix, receipt in zip(prefixes, receipts):
        assert receipt["status"] == "complete"
        assert sha(PRIVATE / (prefix + "-model.json")) == receipt["model_sha256"]
        assert sha(PRIVATE / (prefix + "-party-names.json")) == receipt["party_names_sha256"]
    key = lambda r: (r["identity"], r["language"])
    predictions = [{key(r): r for r in read(prefix + "-development.json")["predictions"]} for prefix in prefixes]
    all_rows = [r for r in read("base-target-inputs.json")["records"] if r["aliases"]]
    rows = [r for r in all_rows if r["split"] == "development"]
    pair_labels = defaultdict(list)
    for record in all_rows:
        pair_labels[record["left"], record["right"]].append(set(record["aliases"]))
    conflicts = {pair: len(values) for pair, values in pair_labels.items()
                 if len(values) > 1 and not set.intersection(*values)}
    counts, regression_causes, misses, families, new_kinds = Counter(), Counter(), Counter(), Counter(), Counter()
    packets = defaultdict(list)
    started = time.monotonic()
    for record in rows:
        target = set(record["aliases"])
        before, after = [p[key(record)] for p in predictions]
        before_norm, after_norm = normalize(before["shortform"]), normalize(after["shortform"])
        correct = before_norm in target, after_norm in target
        pools = [proposals(record, model, memory) for model, memory in zip(models, names)]
        available = [{normalize(c.text) for c in pool} for pool in pools]
        covered = [bool(target & values) for values in available]
        counts["baseline_covered"] += covered[0]
        counts["candidate_covered"] += covered[1]
        counts["newly_reachable"] += covered[1] and not covered[0]
        chosen = next((c for c in pools[1] if c.side == after["side"] and normalize(c.text) == after_norm), None)
        new = bool(chosen and not any(c.side == chosen.side and normalize(c.text) == after_norm for c in pools[0]))
        if new:
            counts["new_proposal_selected"] += 1
            counts["new_proposal_correct"] += correct[1]
            new_kinds[(chosen.kind, "correct" if correct[1] else "miss")] += 1
        group = ("regressions" if correct[0] and not correct[1] else "gains" if correct[1] and not correct[0]
                 else "persisting_misses" if not correct[1] else None)
        if group is None:
            continue
        counts[group] += 1
        allowed_sides = target_sides(record)
        cause = ("unreachable" if not covered[1] else "wrong_party" if allowed_sides and after["side"] not in allowed_sides
                 else "shortening_or_form" if len(allowed_sides) == 1 else "joint_or_ambiguous_party")
        if not correct[1]:
            misses[cause] += 1
            counts["all_targets_over_30"] += all(len(a["text"]) > 30 for a in record["aliases"].values())
            counts["all_normalized_targets_over_30"] += all(len(value) > 30 for value in target)
            families.update({a["family"] for a in (align_base(record, v["text"]) for v in record["aliases"].values())})
        if group == "regressions":
            regression_causes["new_proposal" if new else "reranked_existing_proposal"] += 1
            regression_causes[cause] += 1
            if cause == "shortening_or_form":
                regression_causes["longer" if len(after_norm) > len(before_norm) else "shorter" if len(after_norm) < len(before_norm) else "same_length"] += 1
        scored = ranked(pools[1], models[1]) if not correct[1] or new else []
        gold = [(i + 1, score, choice) for i, (score, choice) in enumerate(scored) if normalize(choice.text) in target]
        item = {"identity": record["identity"], "language": record["language"], "left": record["left"], "right": record["right"],
            "citation": record["citation"], "before": before, "after": after, "targets": list(record["aliases"].values()),
            "target_alignments": [align_base(record, a["text"]) for a in record["aliases"].values()],
            "covered": covered, "selected_new_proposal": new, "selected_kind": chosen.kind if chosen else None,
            "cause": cause, "same_party_input_conflict_rows": conflicts.get((record["left"], record["right"]), 0),
            "best_target_rank": gold[0][0] if gold else None,
            "target_margin": scored[0][0] - gold[0][1] if gold else None,
            "top_choices": [{"name": c.text, "side": c.side, "kind": c.kind, "score": score,
                             "target": normalize(c.text) in target} for score, c in scored[:5]]}
        packets[group].append(item)
    assert counts["baseline_covered"] == receipts[0]["metrics"]["candidate_ceiling_matches"]
    assert counts["candidate_covered"] == receipts[1]["metrics"]["candidate_ceiling_matches"]
    summary = {"counts": dict(counts), "regression_breakdown_overlapping": dict(regression_causes),
        "remaining_misses_exclusive": dict(misses), "remaining_target_families_overlapping": dict(families),
        "selected_new_proposal_kinds": {kind + ":" + outcome: n for (kind, outcome), n in new_kinds.items()},
        "model_bytes": {p: (PRIVATE / (p + "-model.json")).stat().st_size for p in prefixes},
        "seconds": round(time.monotonic() - started, 2)}
    save(candidate + "-diagnosis.json", {"scope": "Reused development only; target membership is authored agreement, not an independent validity judgment.",
        "fit_sha256": {p: sha(PRIVATE / (p + "-fit.json")) for p in prefixes},
        "input_sha256": sha(PRIVATE / "base-target-inputs.json"), "summary": summary, "cases": dict(packets)})
    print(summary, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", choices=("base-editor", "base-set-editor"), default="base-editor")
    diagnose(parser.parse_args().candidate)
