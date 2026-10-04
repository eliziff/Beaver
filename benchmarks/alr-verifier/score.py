#!/usr/bin/env python3
"""Score ALR verifier arms with the Python app's own benchmark scorers.

Differential oracle: every split, field, link and supra/ibid number below is
computed by the read-only Python modules in ALR-Quote-Verifier/dev (imported at
eval time, never copied). This file only arranges each arm's rows into the
payload shape those scorers read and prints the metric groups separately, in
the README's order (user-visible safety, final source outcomes, routing inputs,
diagnostics), followed by quote checking and performance.

Arms live in benchmarks/local-data/alr-verifier/arms/<arm>/<document stem>.json
in the Python live-benchmark payload shape ({source_doc, records, arm: {rows},
metrics}). `python-free` is the current Python app's Free mode re-run on the
same inputs (`run.py baseline`); the new pipeline's arms are written by run.py.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from suite import ALR, FIELD_GOLD, REGRESSIONS, SPLIT_GOLD, SUITE, SUPRA_GOLD

ARMS = SUITE / "arms"
CONTEXT_MARKER = "sequential_production_run"
# The document of the recorded live comparison in dev/DETERMINISTIC_SPLITTER_RESULTS.md,
# identified by content hash (the inputs are private).
LIVE_DOC_SHA256 = "0c6055da0074af2b38b203a31152f28772b41d9b169216a5d4656607adcdd65c"

# Recorded Python baselines (dev/DETERMINISTIC_SPLITTER_RESULTS.md, 2026-07-13, and
# dev/benchmarks/README.md Luna experiment, 2026-08-01). Re-runnable Python numbers come
# from the python-free arm instead.
RECORDED = {
    "split_gold_405": {
        "Free (recorded)": {"exact": 324, "over_split": 66, "boundary_mismatch": 15, "under_split": 0},
        "High Accuracy (recorded, 368 shared rows)": {"exact": 255, "under_split": 28, "rows": 368},
    },
    "live_document": {
        "High Accuracy (recorded)": {"parts": 155, "exact": 20, "under": 10, "over": 8, "boundary": 1,
                                       "supra_correct": 23, "supra_incorrect": 15, "supra_missing": 4, "calls": 131},
        "Ultra Economy (recorded)": {"parts": 147, "exact": 19, "under": 12, "over": 6, "boundary": 2,
                                       "supra_correct": 27, "supra_incorrect": 13, "supra_missing": 2, "calls": 117},
        "Free (recorded)": {"parts": 171, "exact": 25, "under": 0, "over": 14, "boundary": 0,
                             "supra_correct": 15, "supra_incorrect": 15, "supra_missing": 12, "calls": 0},
    },
    "luna_2026_08_01": {
        "gpt-5.6-luna high (4 docs)": {"final_link_base": "254/284 (89.44%)", "supra_ibid_base": "122/166 (73.49%)"},
        "gpt-5.6-luna xhigh (3 docs)": {"final_link_base": "263/294 (89.46%)", "supra_ibid_base": "120/156 (76.92%)"},
    },
}


def oracle():
    """Import the Python app's scorers (read-only, eval time only)."""
    sys.path.insert(0, str(ALR))
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    sys.dont_write_bytecode = True
    with contextlib.redirect_stdout(io.StringIO()):
        from dev.benchtools import benchmark_live_hybrid_docx as live
        from dev.benchtools import benchmark_high_accuracy_hybrid as hybrid
        from dev.benchtools import benchmark_deterministic_splitter as det
        from dev.benchtools import benchmark_fast_splitter as fast
        from dev.benchtools import benchmark_correctness as correctness
    return live, hybrid, det, fast, correctness


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def manifest() -> list[dict]:
    return json.loads((SUITE / "inputs" / "manifest.json").read_text(encoding="utf-8"))["documents"]


def load_arm(arm: str) -> dict[str, dict]:
    folder = ARMS / arm
    if not folder.is_dir():
        return {}
    return {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(folder.glob("*.json"))}


def rows_by_internal(payload: dict) -> dict[int, list[dict]]:
    grouped: dict[int, list[dict]] = defaultdict(list)
    for row in payload["arm"]["rows"]:
        grouped[int(row["footnote_id"])].append(row)
    for rows in grouped.values():
        rows.sort(key=lambda row: int(row["citation_part_index"]))
    return grouped


def with_context(payload: dict) -> dict:
    """Every arm is a sequential whole-document run; mark it so for the supra scorer."""
    for record in payload["records"]:
        if not record.get("previous_citations"):
            record["previous_citations"] = CONTEXT_MARKER
    return payload


def ratio(n: float, d: float) -> str:
    return f"{n}/{d} ({100 * n / d:.1f}%)" if d else "n/a"


# ---------------------------------------------------------------- safety


def split_gold_lane(det, fast, payload: dict) -> dict:
    """The 405-row split gold, all footnotes in one document (build_gold_docx.py)."""
    mapping = json.loads((SUITE / "inputs" / "split-gold" / "split-gold-map.json").read_text(encoding="utf-8"))
    gold = {row["id"]: row for row in read_jsonl(SPLIT_GOLD)}
    emitted = rows_by_internal(payload)
    outcomes: Counter = Counter()
    strict = core_loss = core_gain = 0
    per_row = {}
    for item in mapping["footnotes"]:
        row = gold[item["id"]]
        parts = [r.get("citation_part_text", "") for r in emitted.get(int(item["footnote"]), [])]
        outcome = det.partition_outcome(parts, row)
        score = fast.score_parts(row.get("expected_verbatim_parts") or [], parts, row.get("acceptable_partitions"))
        chars = fast.score_character_neutrality(str(row.get("footnote_text") or ""), parts)
        outcomes[outcome] += 1
        strict += bool(score["strict_exact_match"])
        core_loss += chars["core_loss_chars"] > 0
        core_gain += chars["core_gain_chars"] > 0
        per_row[item["id"]] = {"outcome": outcome, "parts": parts, "expected": row.get("expected_verbatim_parts"),
                               "loss": chars["core_loss_chars"], "gain": chars["core_gain_chars"]}
    return {"rows": len(mapping["footnotes"]), "outcomes": dict(outcomes), "strict_exact": strict,
            "core_loss_cases": core_loss, "core_gain_cases": core_gain, "per_row": per_row}


# ---------------------------------------------------------------- documents


def loose(value) -> str:
    text = str(value or "")
    # Gold text lost curly quotes to U+FFFD; compare letters and digits only.
    return re.sub(r"[^0-9a-z]+", "", str(value or "").casefold())


def aligned_gold(reference: dict[str, dict]) -> tuple[Path, Path, dict]:
    """Gold rows whose footnote is the same text in the located DOCX.

    Some gold was built from a different draft of a document (footnote numbers
    shift) or from a checked workbook. A split-gold row is renumbered to the
    footnote with the same text when exactly one exists; supra/ibid rows are
    kept only where their footnote number already holds the same text. Every
    arm is scored on the same aligned rows.
    """
    by_doc = {}
    for entry in manifest():
        if entry.get("input") and Path(entry["input"]).stem in reference:
            records = reference[Path(entry["input"]).stem]["records"]
            by_doc[entry["gold_source_doc"].casefold()] = (
                {str(r["display_id"]): loose(r["text"]) for r in records},
                defaultdict(list),
            )
            for r in records:
                by_doc[entry["gold_source_doc"].casefold()][1][loose(r["text"])].append(str(r["display_id"]))
    counts: Counter = Counter()
    out_dir = SUITE / "gold"
    out_dir.mkdir(parents=True, exist_ok=True)
    split_rows, supra_rows = [], []
    for row in read_jsonl(SPLIT_GOLD):
        if row.get("status") != "accepted":
            continue
        doc = by_doc.get(Path(str(row.get("source_doc") or "").replace("\\", "/")).name.casefold())
        text = loose(row.get("footnote_text"))
        if not doc:
            counts["split_no_document"] += 1
            continue
        numbers, texts = doc
        if numbers.get(str(row.get("footnote_number"))) == text:
            counts["split_aligned"] += 1
        elif len(texts.get(text, [])) == 1:
            row = {**row, "footnote_number": texts[text][0]}
            counts["split_renumbered"] += 1
        else:
            counts["split_dropped"] += 1
            continue
        split_rows.append(row)
    for row in read_jsonl(SUPRA_GOLD):
        if row.get("status") not in ("auto", "agent"):
            continue
        doc = by_doc.get(Path(str(row.get("source_doc") or "").replace("\\", "/")).name.casefold())
        if doc and doc[0].get(str(row.get("footnote_number"))) == loose(row.get("footnote_text")):
            supra_rows.append(row)
            counts["supra_aligned"] += 1
        else:
            counts["supra_dropped"] += 1
    split_path, supra_path = out_dir / "split_aligned.jsonl", out_dir / "supra_aligned.jsonl"
    for path, rows in ((split_path, split_rows), (supra_path, supra_rows)):
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    return split_path, supra_path, dict(counts)


def document_lane(live, hybrid, correctness, payloads: dict[str, dict], reference: dict[str, dict]) -> dict:
    """Real documents: split gold per document, field gold, supra/ibid gold, legacy supra counts."""
    split_gold, supra_gold, alignment = aligned_gold(reference)
    supra_index = hybrid.load_gold(supra_gold)
    split_totals: Counter = Counter()
    all_details: list[dict] = []
    legacy: Counter = Counter()
    per_doc = {}
    for entry in manifest():
        if not entry.get("input"):
            continue
        stem = Path(entry["input"]).stem
        payload = payloads.get(stem)
        if payload is None:
            continue
        ref = reference.get(stem) or payload
        # Identity of footnotes comes from the Python app's own record list for this document.
        aligned = with_context({**payload, "records": [dict(r) for r in ref["records"]], "source_doc": entry["gold_source_doc"]})
        with contextlib.redirect_stdout(io.StringIO()):
            split = live._split_gold_scores(aligned, split_gold)
            details = live._gold_details(aligned, split_gold)
        for key, value in split.items():
            if not key.endswith("_rate"):
                split_totals[key] += value
        all_details.extend(details)
        stem_key = Path(entry["gold_source_doc"]).stem
        legacy_doc = hybrid.score_supra_gold(stem_key, aligned["records"], aligned["arm"], supra_index)
        legacy.update(legacy_doc)
        per_doc[entry["gold_source_doc"]] = {"split": split, "legacy_supra": dict(legacy_doc)}
    with contextlib.redirect_stdout(io.StringIO()):
        scores, field_details, supra_details = correctness.score_correctness(
            all_details, field_gold_path=FIELD_GOLD, supra_gold_path=supra_gold)
    return {"gold_alignment": alignment, "split": dict(split_totals), "correctness": scores, "field_details": field_details,
            "supra_details": supra_details, "legacy_supra": dict(legacy), "per_doc": per_doc}


# ---------------------------------------------------------------- report


def group_tables(arms: dict[str, dict]) -> str:
    def row(name, cells):
        return "| " + name + " | " + " | ".join(str(c) for c in cells) + " |"

    names = list(arms)
    head = "| metric | " + " | ".join(names) + " |\n|---|" + "---:|" * len(names)
    out = []

    def section(title, metrics):
        out.append(f"\n### {title}\n\n{head}")
        for label, getter in metrics:
            out.append(row(label, [getter(arms[name]) for name in names]))

    def g(*keys, fmt=None):
        def get(arm):
            value = arm
            for key in keys:
                value = (value or {}).get(key) if isinstance(value, dict) else None
            if value is None:
                return "-"
            return fmt(value) if fmt else value
        return get

    pct = lambda v: f"{100 * v:.1f}%"
    sg = lambda key: (lambda arm: (arm.get("split_gold") or {}).get("outcomes", {}).get(key, 0) if arm.get("split_gold") else "-")
    section("1. User-visible safety (split gold, 405 footnotes in one document)", [
        ("exact partition (canonical or accepted)", sg("exact")),
        ("strict canonical exact", g("split_gold", "strict_exact")),
        ("undersplits (worst)", sg("under_split")),
        ("oversplits", sg("over_split")),
        ("boundary mismatches", sg("boundary_mismatch")),
        ("footnotes losing characters", g("split_gold", "core_loss_cases")),
        ("footnotes gaining characters", g("split_gold", "core_gain_cases")),
    ])
    section("1b. User-visible safety (split gold inside the real documents)", [
        ("gold footnotes scored", g("documents", "split", "cases")),
        ("strict exact", g("documents", "split", "strict_exact_match")),
        ("tolerant exact", g("documents", "split", "tolerant_partition_match")),
        ("undersplits", g("documents", "split", "under_split")),
        ("oversplits", g("documents", "split", "over_split")),
        ("boundary mismatches", g("documents", "split", "boundary_mismatch")),
        ("character-neutral", g("documents", "split", "core_loss_gain_neutral")),
    ])
    c = lambda key, fmt=None: g("documents", "correctness", key, fmt=fmt)
    section("2. Final source outcomes", [
        ("final link, base (field gold)", c("field_link_base_accuracy", pct)),
        ("final link, with anchor (field gold)", c("field_link_identity_accuracy", pct)),
        ("link values scored", c("field_link_scored")),
        ("pinpoint fragments", c("field_pinpoint_fragments_accuracy", pct)),
        ("page pinpoints", c("field_page_pinpoints_accuracy", pct)),
        ("supra/ibid cases scored", c("supra_link_cases")),
        ("supra/ibid exact", c("supra_link_exact_accuracy", pct)),
        ("supra/ibid base", c("supra_link_base_accuracy", pct)),
        ("supra/ibid dropped", c("supra_link_dropped")),
        ("supra/ibid wrong target", c("supra_link_wrong_target")),
        ("supra/ibid hallucinated", c("supra_link_hallucinated")),
        ("supra/ibid reference part missing", c("supra_link_missing_reference_part")),
        ("legacy supra correct / incorrect / missing part",
         lambda a: "-" if not a.get("documents") else "{correct_base} / {incorrect_base} / {missing_part}".format(**Counter(a["documents"]["legacy_supra"]))),
    ])
    section("3. Conditional routing inputs", [
        ("kind", c("field_kind_accuracy", pct)),
        ("short_form", c("field_short_form_accuracy", pct)),
        ("bare_citation", c("field_bare_citation_accuracy", pct)),
        ("citation_with_style", c("field_citation_with_style_accuracy", pct)),
    ])
    section("4. Hidden diagnostics", [
        ("corrected", c("field_corrected_accuracy", pct)),
        ("field_accuracy (unweighted, not a gate)", c("field_accuracy", pct)),
        ("field values scored", c("field_scored_values")),
    ])
    section("5. Quote checking (independent quote gold)", [
        ("quotes scored", g("quotes", "scored")),
        ("status agrees with gold", g("quotes", "agree")),
        ("false Perfect (gold says not verbatim)", g("quotes", "false_perfect")),
        ("missed Perfect (gold verbatim, app not Perfect)", g("quotes", "missed_perfect")),
        ("unavailable source", g("quotes", "unavailable")),
    ])
    section("6. Cost and speed", [
        ("model calls", g("perf", "calls")),
        ("cache-adjusted tokens", g("perf", "cache_adjusted_tokens", fmt=lambda v: f"{v:,.0f}")),
        ("wall clock, all documents (s)", g("perf", "wall_s", fmt=lambda v: f"{v:,.1f}")),
        ("median wall clock per document (s)", g("perf", "median_doc_s", fmt=lambda v: f"{v:,.2f}")),
        ("cold start: launch to workbook, smallest document (s)", g("perf", "cold_start_s", fmt=lambda v: f"{v:,.2f}")),
    ])
    return "\n".join(out)


def quote_outcome(status: str) -> str:
    status = str(status or "").upper()
    if "PARTIAL" in status:
        return "partial"
    if status == "NO_MATCH":
        return "no_match"
    if "MATCH" in status:
        return "perfect"
    return "unavailable" if status else "not_checked"


def quote_lane(payloads: dict[str, dict]) -> dict:
    """Score each gold quotation (build_quote_gold.py) against the row that checked it."""
    counts: Counter = Counter()
    misses = []
    for gold in read_jsonl(SUITE / "quotes" / "quote_gold.jsonl"):
        payload = payloads.get(Path(gold["document"]).stem)
        if payload is None:
            continue
        counts["scored"] += 1
        want = loose(gold["quote"])
        rows = [r for r in payload["arm"]["rows"] if int(r.get("footnote_id") or 0) == int(gold["footnote_internal_id"])]
        hits = []
        for row in rows:
            try:
                quotes = json.loads(row.get("quotes_list_json") or "[]")
            except (TypeError, ValueError):
                quotes = []
            if any(want and (want in loose(q) or loose(q) in want) and loose(q) for q in quotes):
                hits.append(row)
        outcomes = {quote_outcome(r.get("quote_check_status")) for r in hits}
        # A footnote with several citation parts checks the quote against each; the
        # quote is judged by the best outcome any of its rows reached.
        best = next((o for o in ("perfect", "partial", "no_match", "unavailable", "not_checked") if o in outcomes), "not_found")
        counts[f"got_{best}"] += 1
        ok = best in gold["accept"]
        counts["agree"] += ok
        if gold["label"] != "verbatim" and best == "perfect" and "perfect" not in gold["accept"]:
            counts["false_perfect"] += 1
        if gold["label"] == "verbatim" and best != "perfect":
            counts["missed_perfect"] += 1
        if best in ("unavailable", "not_checked", "not_found"):
            counts["unavailable"] += 1
        if not ok:
            misses.append({"id": gold["id"], "document": gold["document"], "footnote": gold["footnote_display_id"],
                           "citation": gold["citation"], "gold": gold["label"], "got": best,
                           "status": sorted({str(r.get("quote_check_status") or "") for r in hits})})
    out = {k: counts[k] for k in ("scored", "agree", "false_perfect", "missed_perfect", "unavailable")}
    out["agree"] = ratio(counts["agree"], counts["scored"])
    out["outcomes"] = {k[4:]: v for k, v in counts.items() if k.startswith("got_")}
    out["misses"] = misses
    return out


def live_document_table(results: dict[str, dict]) -> str:
    """The live one-document comparison of dev/DETERMINISTIC_SPLITTER_RESULTS.md, recorded and re-run."""
    entry = next((d for d in manifest() if d.get("sha256") == LIVE_DOC_SHA256), None)
    if entry is None:
        return ""
    doc = entry["gold_source_doc"]
    lines = ["\n### Live one-document comparison (recorded Python rows, then this run)\n",
             "| arm | parts | split gold exact / under / over / boundary | supra correct / incorrect / missing part | model calls |",
             "|---|---:|---|---|---:|"]
    for name, row in RECORDED["live_document"].items():
        lines.append(f"| {name} | {row['parts']} | {row['exact']} / {row['under']} / {row['over']} / {row['boundary']} | "
                     f"{row['supra_correct']} / {row['supra_incorrect']} / {row['supra_missing']} | {row['calls']} |")
    for name, arm in results.items():
        per_doc = ((arm.get("documents") or {}).get("per_doc") or {}).get(doc)
        if not per_doc:
            continue
        split, legacy = Counter(per_doc["split"]), Counter(per_doc["legacy_supra"])
        live = load_arm(name).get(Path(entry["input"]).stem, {}).get("metrics", {})
        lines.append(f"| {name} | {live.get('parts', '-')} | {split['strict_exact_match']} / {split['under_split']} / "
                     f"{split['over_split']} / {split['boundary_mismatch']} | {legacy['correct_base']} / "
                     f"{legacy['incorrect_base']} / {legacy['missing_part']} | {live.get('live_calls', 0)} |")
    return "\n".join(lines)


def perf(payloads: dict[str, dict]) -> dict:
    walls = sorted(float((p.get("metrics") or {}).get("elapsed_s") or 0) for name, p in payloads.items() if name != "split-gold-footnotes")
    usage: Counter = Counter()
    for p in payloads.values():
        m = p.get("metrics") or {}
        for key in ("input_tokens", "cached_input_tokens", "output_tokens", "live_calls"):
            usage[key] += int(m.get(key) or 0)
    adjusted = usage["input_tokens"] - usage["cached_input_tokens"] + 0.1 * usage["cached_input_tokens"] + usage["output_tokens"]
    # Cold start: launch-to-workbook process time for the smallest benchmark document,
    # including interpreter/runtime start and imports (one fresh process per document).
    sizes = {Path(d["input"]).stem: d["bytes"] for d in manifest() if d.get("input")}
    present = [stem for stem in payloads if stem in sizes]
    smallest = (payloads[min(present, key=sizes.get)].get("metrics") or {}) if present else {}
    cold = [float(smallest["process_s"])] if smallest.get("process_s") is not None else []
    return {"calls": usage["live_calls"], "cache_adjusted_tokens": adjusted, "wall_s": sum(walls),
            "median_doc_s": walls[len(walls) // 2] if walls else None, "cold_start_s": cold[0] if cold else None,
            **{k: usage[k] for k in ("input_tokens", "cached_input_tokens", "output_tokens")}}


def paired(baseline: dict, candidate: dict) -> dict:
    """Per-item comparisons against the Python app on identical gold items."""
    out: dict = {}
    if baseline.get("split_gold") and candidate.get("split_gold"):
        rank = {"exact": 0, "over_split": 1, "boundary_mismatch": 2, "under_split": 3}
        wins, losses = [], []
        for gid, base in baseline["split_gold"]["per_row"].items():
            new = candidate["split_gold"]["per_row"][gid]
            if rank[new["outcome"]] < rank[base["outcome"]]:
                wins.append(gid)
            elif rank[new["outcome"]] > rank[base["outcome"]]:
                losses.append({"id": gid, "python": base["outcome"], "new": new["outcome"],
                               "expected": new["expected"], "got": new["parts"]})
        out["split_gold"] = {"wins": len(wins), "losses": len(losses), "loss_rows": losses}
    if baseline.get("documents") and candidate.get("documents"):
        def field_index(arm):
            return {(d["id"], key): v["status"] for d in arm["documents"]["field_details"]
                    for key, v in (d.get("fields") or {}).items() if v.get("status") in ("correct", "incorrect")}
        base_f, new_f = field_index(baseline), field_index(candidate)
        common = base_f.keys() & new_f.keys()
        field_losses = []
        new_details = {d["id"]: d for d in candidate["documents"]["field_details"]}
        for key in sorted(common):
            if base_f[key] == "correct" and new_f[key] == "incorrect":
                detail = new_details[key[0]]["fields"][key[1]]
                field_losses.append({"id": key[0], "field": key[1], "expected": detail.get("expected"), "got": detail.get("actual")})
        wins = sum(1 for key in common if base_f[key] == "incorrect" and new_f[key] == "correct")
        out["fields"] = {"common_values": len(common), "wins": wins, "losses": len(field_losses), "loss_rows": field_losses}
        base_s = {(r["id"], r["benchmark_id"]): r for r in baseline["documents"]["supra_details"]}
        new_s = {(r["id"], r["benchmark_id"]): r for r in candidate["documents"]["supra_details"]}
        good = {"exact", "anchor_error", "source_alias"}
        supra_losses = [{"id": k[0], "python": base_s[k]["outcome"], "new": new_s[k]["outcome"],
                         "expected": new_s[k]["expected_link"], "got": new_s[k]["emitted_link"]}
                        for k in sorted(base_s.keys() & new_s.keys())
                        if base_s[k]["outcome"] in good and new_s[k]["outcome"] not in good]
        supra_wins = sum(1 for k in base_s.keys() & new_s.keys()
                         if base_s[k]["outcome"] not in good and new_s[k]["outcome"] in good)
        out["supra"] = {"common": len(base_s.keys() & new_s.keys()), "wins": supra_wins,
                        "losses": len(supra_losses), "loss_rows": supra_losses}
    if baseline.get("quotes") and candidate.get("quotes"):
        base_miss = {m["id"] for m in baseline["quotes"]["misses"]}
        new_miss = {m["id"]: m for m in candidate["quotes"]["misses"]}
        out["quotes"] = {"wins": len(base_miss - new_miss.keys()), "losses": len(new_miss.keys() - base_miss),
                         "loss_rows": [new_miss[k] for k in sorted(new_miss.keys() - base_miss)]}
    return out


def align_footnote_ids(payload: dict, reference: dict | None) -> Counter:
    """Renumber an arm's rows to the reference app's footnote ids, matched by footnote text.

    Footnote ids are internal to each app; the gold and the Python records use the
    Python app's. A row whose footnote text matches exactly one reference footnote
    takes that footnote's id; the count of unmatched footnotes is reported.
    """
    stats: Counter = Counter()
    if not reference:
        return stats
    by_text: dict[str, list[int]] = defaultdict(list)
    for record in reference["records"]:
        by_text[loose(record["text"])].append(int(record["internal_id"]))
    texts: dict[int, str] = {}
    for row in payload["arm"]["rows"]:
        text = str(row.get("footnote_full") or row.get("Footnote Text") or "")
        if text.strip():
            texts.setdefault(int(row["footnote_id"]), text)
    mapping: dict[int, int] = {}
    for row in payload["arm"]["rows"]:
        fid = int(row["footnote_id"])
        if fid in mapping:
            continue
        same = by_text.get(loose(texts.get(fid, "")), [])
        mapping[fid] = same[0] if len(same) == 1 else fid
        stats["matched" if len(same) == 1 else "unmatched"] += 1
        stats["renumbered"] += len(same) == 1 and same[0] != fid
    for row in payload["arm"]["rows"]:
        row["footnote_id"] = mapping[int(row["footnote_id"])]
    return stats


def score_arm(name: str, oracle_modules, reference: dict[str, dict]) -> dict:
    live, hybrid, det, fast, correctness = oracle_modules
    payloads = load_arm(name)
    result: dict = {"documents_present": sorted(payloads), "footnote_alignment": {}}
    for stem, payload in payloads.items():
        result["footnote_alignment"][stem] = dict(align_footnote_ids(payload, reference.get(stem)))
    if "split-gold-footnotes" in payloads:
        result["split_gold"] = split_gold_lane(det, fast, payloads["split-gold-footnotes"])
    docs = {k: v for k, v in payloads.items() if k != "split-gold-footnotes"}
    if docs:
        result["documents"] = document_lane(live, hybrid, correctness, docs, reference)
    if (SUITE / "quotes" / "quote_gold.jsonl").exists() and docs:
        result["quotes"] = quote_lane(docs)
    result["perf"] = perf(payloads)
    return result


def regressions_markdown(results: dict[str, dict], baseline: str) -> str:
    lines = []
    for name, arm in results.items():
        if name == baseline or "paired" not in arm:
            continue
        p = arm["paired"]
        lines.append(f"\n### {name} vs {baseline}\n")
        for group, label in (("split_gold", "split partition (405 split-gold footnotes)"),
                             ("fields", "field gold values (real documents)"),
                             ("supra", "supra/ibid gold (real documents)"),
                             ("quotes", "quote-check gold")):
            if group not in p:
                continue
            g = p[group]
            lines.append(f"- {label}: {g['wins']} better, {g['losses']} worse")
            for item in g["loss_rows"][:60]:
                lines.append("  - " + json.dumps(item, ensure_ascii=False))
            if len(g["loss_rows"]) > 60:
                lines.append(f"  - ... {len(g['loss_rows']) - 60} more in report.json")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arms", nargs="*", help="arm folder names (default: all under arms/)")
    parser.add_argument("--baseline", default="python-free")
    args = parser.parse_args()
    modules = oracle()
    names = args.arms or sorted(p.name for p in ARMS.iterdir() if p.is_dir())
    reference = load_arm(args.baseline)
    results = {name: score_arm(name, modules, reference) for name in names}
    for name, arm in results.items():
        if name != args.baseline and args.baseline in results:
            arm["paired"] = paired(results[args.baseline], arm)
    report = {"metric_policy": modules[4].PRODUCT_METRIC_POLICY, "recorded_python_baselines": RECORDED, "arms": results}
    (SUITE / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str) + "\n", encoding="utf-8")
    table = group_tables(results) + live_document_table(results)
    (SUITE / "report.md").write_text(table + "\n", encoding="utf-8")
    print(table)
    regress = regressions_markdown(results, args.baseline)
    if REGRESSIONS.exists():
        text = REGRESSIONS.read_text(encoding="utf-8")
        head = text.split("## Regressions (expected vs got)")[0]
        REGRESSIONS.write_text(head + "## Regressions (expected vs got)\n\nGenerated by benchmarks/alr-verifier/score.py; "
                               "full detail in benchmarks/local-data/alr-verifier/report.json.\n"
                               + (regress or "\n(none)") + "\n", encoding="utf-8")
    print(regress)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
