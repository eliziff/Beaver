"""Per-run scoring receipt: merge scores.json + metrics.json + beaver-receipts.json.

The judge writes scores.json (verdict), the runner writes metrics.json (tokens,
exposure) and beaver-receipts.json (tool calls, deltas, surface). Reading them
separately is the friction this module removes: one call yields the single
receipt that matters for a run comparison, and the judge emits it
automatically at the end of run_eval.

CLI:
    uv run python -m evaluation.receipt --run-id <id>            # one run
    uv run python -m evaluation.receipt --task <task> [--arm a]  # stratum table

The receipt file (receipt.json / receipt.txt) is written into the run dir on
the first pass and never clobbered without --force, mirroring scores.json.
"""

import argparse
import json
import sys
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = BENCH_ROOT / "results"

# fields pulled straight through from metrics.json; these are the ones a run
# comparison actually reads. Everything else (145 keys) stays in the source.
METRIC_FIELDS = [
    ("model", "model"),
    ("input_tokens", "tokens_in"),
    ("output_tokens", "tokens_out"),
    ("uncached_input_tokens", "uncached"),
    ("cache_read_input_tokens", "cached"),
    ("cache_adjusted_input_token_equivalent", "cacheadj"),
    ("wall_clock_seconds", "wall_sec"),
    ("tool_call_count", "tool_calls"),
    ("research_tool_calls", "research_calls"),
    ("drafting_tool_calls", "drafting_calls"),
    ("compaction_count", "compactions"),
    ("deliverable_chars", "deliverable_chars"),
    ("documents_read", "docs_read"),
    ("total_documents", "docs_total"),
]

# *_delta keys whose value is a non-None generation tag. These identify which
# mechanisms were live on the run without inspecting 40 surface flags.
DELTA_SUFFIX = "_delta"

# Always-on levers that every run of an arm accumulates (the consolidated v5
# base). They add no signal when comparing runs within an arm, so they are
# filtered out of the "deltas" list — differential levers (draft_edit_*,
# exposure_echo_*, future mechanisms) are what the receipt highlights.
BASE_DELTAS = {
    "lean_batch_delta",
    "coding_markdown_delta",
    "coding_neutral_prompt_delta",
    "coding_markdown_v2_delta",
    "coding_parity_delta",
    "coding_markdown_v3_delta",
    "grep_section_context_delta",
    "coding_markdown_v4_delta",
    "coding_toc_files_delta",
    "coding_markdown_v5_delta",
    "grep_per_file_budget_delta",
    "triage_workflow_prompt_delta",
}


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}


def _edit_totals(receipts: dict) -> dict:
    """Count Edit/generate_docx tool calls and how many returned ok.

    tool_calls/tool_results are id-paired lists; a result without a matching
    call (or a call without a result) is counted as not-ok rather than
    guessed at.
    """
    calls = {c.get("id"): c for c in receipts.get("tool_calls", [])}
    results = {r.get("id"): r for r in receipts.get("tool_results", [])}
    out = {}
    for name in ("Edit", "generate_docx"):
        matched = [
            (cid, c) for cid, c in calls.items() if c.get("name") == name
        ]
        ok = sum(1 for cid, _ in matched if results.get(cid, {}).get("ok"))
        out[name] = {"calls": len(matched), "ok": ok}
    return out


def build_receipt(run_dir: Path) -> dict:
    """Merge the three run artifacts into one flat receipt dict.

    Never raises on a missing artifact — a run without scores (unjudged) or
    without beaver-receipts (native/old arm) still yields a partial receipt,
    with the absent side reported as None.
    """
    scores = _load_json(run_dir / "scores.majority.json") or _load_json(
        run_dir / "scores.json"
    )
    metrics = _load_json(run_dir / "metrics.json")
    receipts = _load_json(run_dir / "beaver-receipts.json")

    run_id = (
        scores.get("run_id")
        or metrics.get("run_id")
        or str(run_dir.relative_to(RESULTS_DIR))
    )

    receipt = {
        "run_id": run_id,
        "task": scores.get("task") or metrics.get("task"),
        "arm": metrics.get("arm"),
        "n_passed": scores.get("n_passed"),
        "n_criteria": scores.get("n_criteria"),
        "score": scores.get("score"),
        "all_pass": scores.get("all_pass"),
        "judge_model": scores.get("judge_model"),
        "judge_effort": scores.get("judge_effort"),
        "judged": (
            scores.get("scored_at") is not None
            or scores.get("aggregated_at") is not None
        ),
        "deliverable_match": scores.get("deliverable_match"),
        "draft_edit_delta": receipts.get("draft_edit_delta"),
        "exposure_echo_delta": receipts.get("exposure_echo_delta"),
        "final_arm": receipts.get("final_arm_receipt"),
        "deltas": sorted(
            v
            for k, v in receipts.items()
            if k.endswith(DELTA_SUFFIX) and v and k not in BASE_DELTAS
        ),
        "surface": {
            k: receipts.get("surface", {}).get(k)
            for k in (
                "draft_edit",
                "exposure_echo",
                "structure_index",
                "coding_toc_files",
                "terminal_authoring",
                "final_arm",
                "signal_gate",
                "grep_body_exposure",
                "source_immutable",
                "composition_check_shadow",
            )
        },
        "tools": _edit_totals(receipts),
    }
    for src_key, dst_key in METRIC_FIELDS:
        receipt[dst_key] = metrics.get(src_key)
    receipt["compactions"] = metrics.get("compaction_count")
    return receipt


def format_receipt(r: dict) -> str:
    """Human-readable receipt: one line per fact, None stripped."""
    lines = []
    if r["n_criteria"] is not None:
        lines.append(
            f"SCORE  {r['n_passed']}/{r['n_criteria']}"
            + ("" if r["all_pass"] else f"  (missed {r['n_criteria'] - r['n_passed']})")
            + (f"  judge={r['judge_model']}" if r["judge_model"] else "")
        )
    elif not r["judged"]:
        lines.append("SCORE  unjudged")
    if r["cacheadj"] is not None:
        lines.append(
            f"COST   {r['cacheadj']:,.0f} cacheadj"
            f"  ({r['uncached']:,} unc + {r['cached']:,} cached)"
            f"  {r['tokens_out']:,} out"
            f"  {r['wall_sec']:.0f}s wall"
        )
    tools = r["tools"]
    edits = tools.get("Edit", {})
    gd = tools.get("generate_docx", {})
    if edits:
        lines.append(f"EDITS  {edits['ok']}/{edits['calls']} ok on draft")
    if gd:
        lines.append(f"DOCX   {gd['ok']}/{gd['calls']} rendered")
    if r["deliverable_chars"] is not None:
        lines.append(f"DELIV  {r['deliverable_chars']:,} chars")
    if r["docs_read"] is not None and r["docs_total"]:
        lines.append(f"DOCS   {r['docs_read']}/{r['docs_total']} read")
    if r["compactions"]:
        lines.append(f"CTX    {r['compactions']} compactions")
    if r["draft_edit_delta"] or r["exposure_echo_delta"]:
        tags = [t for t in (r["draft_edit_delta"], r["exposure_echo_delta"]) if t]
        lines.append("LEVER  " + ", ".join(tags))
    return "\n".join(lines)


def write_receipt(run_dir: Path, force: bool = False) -> Path:
    """Write receipt.json + receipt.txt into run_dir; returns the json path."""
    receipt = build_receipt(run_dir)
    json_path = run_dir / "receipt.json"
    if json_path.exists() and not force:
        return json_path
    json_path.write_text(json.dumps(receipt, indent=2, default=str))
    (run_dir / "receipt.txt").write_text(
        format_receipt(receipt) + "\n", encoding="utf-8"
    )
    return json_path


def _stratum_table(task: str, arm: str | None) -> None:
    task_dir = RESULTS_DIR / task
    if not task_dir.exists():
        print(f"no results for task: {task}")
        return
    rows = []
    for arm_dir in sorted(task_dir.iterdir()):
        if arm and arm_dir.name != arm:
            continue
        if not arm_dir.is_dir():
            continue
        for run_dir in sorted(arm_dir.iterdir()):
            if not run_dir.is_dir():
                continue
            r = build_receipt(run_dir)
            if r["n_criteria"] is None and not r["judged"]:
                continue  # skip unjudged/empty dirs
            rows.append((run_dir.name, r))
    if not rows:
        print(f"no judged runs for {task}/{arm or '*'}")
        return
    header = (
        f"{'ts':<18} {'score':<7} {'cacheadj':>9} {'tokens':>10} {'edits':>7} "
        f"{'levers':<30}"
    )
    print(header)
    print("-" * len(header))
    for ts, r in rows:
        score = (
            f"{r['n_passed']}/{r['n_criteria']}"
            if r["n_criteria"] is not None
            else "unjudged"
        )
        edits = r["tools"].get("Edit", {})
        edit_s = f"{edits['ok']}/{edits['calls']}" if edits else "-"
        levers = ",".join(r["deltas"]) or "-"
        print(
            f"{ts:<18} {score:<7} {r['cacheadj']:>9,.0f} "
            f"{r['tokens_in'] or 0:>10,} {edit_s:>7} {levers:<30}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", help="Print (and write) the receipt for one run")
    parser.add_argument("--task", help="Print the stratum table for a task (results/<task>)")
    parser.add_argument("--arm", help="With --task: restrict to one arm directory")
    parser.add_argument("--force", action="store_true", help="Overwrite existing receipt")
    args = parser.parse_args()

    if args.run_id:
        run_dir = RESULTS_DIR / args.run_id
        if not run_dir.exists():
            print(f"run dir not found: {run_dir}")
            sys.exit(1)
        write_receipt(run_dir, force=args.force)
        print(format_receipt(build_receipt(run_dir)))
    elif args.task:
        _stratum_table(args.task, args.arm)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
