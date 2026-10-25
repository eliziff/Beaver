"""Score source-page boundary probabilities, including abstentions and whole packets."""
import argparse
import json
import math
from pathlib import Path

from boundary_data import DEFAULT_OUT, atomic_json, check_partitions, digest, measure, read_json


def decisions(rows, low, high):
    if not 0 <= low <= high <= 1:
        raise ValueError("Require 0 <= low <= high <= 1")
    result = {}
    for row in rows:
        sha = row["sha256"]
        if sha in result:
            raise ValueError("Repeated prediction source")
        result[sha] = {}
        for page, probability in row["probabilities"].items():
            if (type(probability) not in (int, float) or not math.isfinite(probability)
                    or not 0 <= probability <= 1 or str(int(page)) != page):
                raise ValueError("Invalid physical gap or probability")
            if probability >= high:
                result[sha][int(page)] = 1
            elif probability <= low:
                result[sha][int(page)] = 0
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("predictions", type=Path)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_OUT / "dataset.json")
    parser.add_argument("--split", choices=("train", "development", "test", "unassigned"), default="development")
    parser.add_argument("--low", type=float, default=0.5)
    parser.add_argument("--high", type=float, default=0.5)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT / "score.json")
    args = parser.parse_args()
    dataset = read_json(args.dataset)
    check_partitions(dataset["sources"])
    sources = [r for r in dataset["sources"] if r["split"] == args.split]
    rows = read_json(args.predictions)["sources"]
    counts = {r["sha256"]: r["page_count"] for r in sources}
    for row in rows:
        if row["sha256"] not in counts:
            raise ValueError("Predictions include sources outside the requested partition")
        if any(not 2 <= int(p) <= counts[row["sha256"]] for p in row["probabilities"]):
            raise ValueError("Prediction gap is outside the original PDF")
    predicted = decisions(rows, args.low, args.high)
    report = {"split": args.split, "low": args.low, "high": args.high,
              "dataset_sha256": digest(args.dataset), "predictions_sha256": digest(args.predictions),
              "partition_status": dataset["report"]["partition_status"], **measure(sources, predicted)}
    atomic_json(args.out, report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
