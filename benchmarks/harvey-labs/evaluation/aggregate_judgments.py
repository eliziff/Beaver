"""Aggregate k-fold judge samples into per-criterion majority verdicts.

Reads results/<run-id>/scores.k*.json (written by run_eval --judge-samples K)
and writes scores.majority.json: majority verdict per criterion, plus flip
telemetry — which criteria the judge disagrees with itself on, and how often.
The flip rate IS the judge noise floor; nothing else in the pipeline measures
it.

Usage:
    uv run python -m evaluation.aggregate_judgments --run-id <id>
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = BENCH_ROOT / "results"


def aggregate_run(run_dir: Path) -> dict:
    """Aggregate every scores.k*.json in run_dir into scores.majority.json."""
    run_dir = Path(run_dir)
    sample_paths = sorted(
        run_dir.glob("scores.k*.json"),
        key=lambda p: int(p.stem.split("k")[-1]),
    )
    if len(sample_paths) < 2:
        raise ValueError(
            f"{run_dir}: need at least 2 scores.k*.json samples, found {len(sample_paths)}"
        )

    samples = [json.loads(p.read_text(encoding="utf-8")) for p in sample_paths]

    judge_models = {s.get("judge_model") for s in samples}
    if len(judge_models) != 1:
        raise ValueError(
            f"{run_dir}: samples were judged by different models: {judge_models} — "
            "majority across judges is not a defined quantity"
        )
    judge_efforts = {s.get("judge_effort") for s in samples}
    if len(judge_efforts) != 1:
        raise ValueError(
            f"{run_dir}: samples used different judge efforts: {judge_efforts}"
        )

    # Criterion order and titles from the first sample; every sample must
    # cover the identical criterion set.
    base = samples[0]["criteria_results"]
    ids = [c["id"] for c in base]
    for s in samples[1:]:
        if [c["id"] for c in s["criteria_results"]] != ids:
            raise ValueError(f"{run_dir}: samples disagree on the criterion set")

    criteria_results = []
    n_flipping = 0
    for i, criterion in enumerate(base):
        verdicts = [s["criteria_results"][i]["verdict"] for s in samples]
        passes = sum(1 for v in verdicts if v == "pass")
        majority = "pass" if passes * 2 > len(verdicts) else "fail"
        flips = 0 < passes < len(verdicts)
        if flips:
            n_flipping += 1
        criteria_results.append(
            {
                "id": criterion["id"],
                "title": criterion["title"],
                "verdict": majority,
                "sample_verdicts": verdicts,
                "pass_votes": passes,
                "n_samples": len(verdicts),
                "unanimous": not flips,
            }
        )

    n_criteria = len(criteria_results)
    n_passed = sum(1 for c in criteria_results if c["verdict"] == "pass")
    majority_scores = {
        "run_id": samples[0].get("run_id"),
        "task": samples[0].get("task"),
        "judge_model": samples[0].get("judge_model"),
        "judge_effort": samples[0].get("judge_effort"),
        "aggregation": "majority",
        "n_samples": len(samples),
        "sample_files": [p.name for p in sample_paths],
        "sample_n_passed": [s.get("n_passed") for s in samples],
        "n_criteria": n_criteria,
        "n_passed": n_passed,
        "all_pass": n_criteria > 0 and n_passed == n_criteria,
        "n_flipping_criteria": n_flipping,
        "criterion_flip_rate": n_flipping / n_criteria if n_criteria else 0.0,
        "criteria_results": criteria_results,
        "aggregated_at": datetime.now(timezone.utc).isoformat(),
    }

    out_path = run_dir / "scores.majority.json"
    out_path.write_text(json.dumps(majority_scores, indent=2))
    return majority_scores


def main():
    parser = argparse.ArgumentParser(
        description="Aggregate scores.k*.json samples into majority verdicts"
    )
    parser.add_argument("--run-id", required=True, help="Run ID under results/")
    args = parser.parse_args()

    majority = aggregate_run(RESULTS_DIR / args.run_id)
    print(
        f"{majority['run_id']}: majority {majority['n_passed']}/{majority['n_criteria']} "
        f"over {majority['n_samples']} samples "
        f"(sample n_passed: {majority['sample_n_passed']}; "
        f"{majority['n_flipping_criteria']} flipping criteria, "
        f"flip rate {majority['criterion_flip_rate']:.3f})"
    )


if __name__ == "__main__":
    main()
