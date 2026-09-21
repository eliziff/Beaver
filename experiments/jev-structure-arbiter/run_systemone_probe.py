"""Run bounded multi-task Jev structure decisions."""
import json, os, time, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-1.13.0"

def main():
    key = os.environ["TYPESAFE_API_KEY"]
    cases = json.loads((ROOT / "systemone_cases.json").read_text(encoding="utf-8"))
    results, started = [], time.perf_counter()
    for case in cases:
        body = json.dumps({"state": case["state"], "model": MODEL, "questions": {"decision": {"type": "choice", "instructions": case["instruction"], "criteria": case["criteria"]}}}).encode()
        request = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        answer = payload["answers"]["decision"]
        row = {**case, "choice": answer["choice"], "confidence": answer.get("confidence"), "correct": answer["choice"] == case["expected"]}
        results.append(row)
        print(f'{case["slice"]}/{case["id"]}: {row["choice"]} (expected {case["expected"]}, confidence {row["confidence"]})')
    by_slice = defaultdict(Counter)
    for row in results:
        by_slice[row["slice"]].update(total=1, correct=int(row["correct"]))
    summary = {"model": MODEL, "cases": len(results), "correct": sum(r["correct"] for r in results), "accuracy": sum(r["correct"] for r in results) / len(results), "seconds": time.perf_counter() - started, "slices": {name: dict(counts) for name, counts in by_slice.items()}, "results": results}
    out = ROOT / "receipts" / "systemone-probe-latest.json"
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("cases", "correct", "accuracy", "seconds", "slices")}, indent=2))

if __name__ == "__main__":
    main()
