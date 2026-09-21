"""Run the bounded Jev structure-arbitration probe."""

import json
import os
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
MODEL = "jev-1.13.0"
URL = "https://api.typesafe.ai/v1/systemone"


def main() -> int:
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        raise SystemExit("TYPESAFE_API_KEY is not set")
    cases = json.loads((ROOT / "cases.json").read_text(encoding="utf-8"))
    results = []
    for case in cases:
        question = {
            "decision": {
                "type": "choice",
                "instructions": (
                    "Choose the best supported structural action from the supplied evidence. "
                    "Do not invent another order or role; choose uncertain when the evidence does not distinguish the options."
                ),
                "criteria": case["criteria"],
            }
        }
        body = json.dumps({"state": case["state"], "model": MODEL, "questions": question}).encode()
        request = urllib.request.Request(
            URL,
            data=body,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"HTTP {error.code}: {error.read().decode(errors='replace')}") from error
        elapsed = time.perf_counter() - started
        answer = payload["answers"]["decision"]
        choice = answer["choice"]
        row = {
            "id": case["id"], "kind": case["kind"], "expected": case["expected"],
            "choice": choice, "correct": choice == case["expected"], "elapsed_seconds": elapsed,
            "answer": answer, "usage": payload.get("usage"),
        }
        results.append(row)
        print(f"{case['id']}: {choice} (expected {case['expected']}) {elapsed:.3f}s")
    summary = {
        "model": MODEL,
        "cases": len(results),
        "correct": sum(row["correct"] for row in results),
        "accuracy": sum(row["correct"] for row in results) / len(results),
        "median_seconds": statistics.median(row["elapsed_seconds"] for row in results),
        "results": results,
    }
    output = ROOT / "receipts" / "latest.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: summary[key] for key in ("model", "cases", "correct", "accuracy", "median_seconds")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
