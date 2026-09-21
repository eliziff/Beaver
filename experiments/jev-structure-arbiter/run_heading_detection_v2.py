"""Broader text-only Jev heading-function probe."""
import json, os, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-1.13.0"
INSTRUCTION = """Does CURRENT CANDIDATE itself begin a new semantic section of the article?

heading: CURRENT CANDIDATE opens a distinct topic or subdivision, and the following material is organized under that scope.
not_heading: CURRENT CANDIDATE is ordinary prose, grammatically continues an adjacent block, is a paragraph/list item rather than an article section, is article metadata or title material, or occurs in a table of contents rather than opening the section itself.
continuation: CURRENT CANDIDATE is another line belonging to the immediately preceding or following heading, not a new heading.
uncertain: the supplied text is insufficient to decide.

Numbering, capitalization, and shortness are not enough. Test the structural function: would CURRENT CANDIDATE be a meaningful navigation entry governing subsequent article content? Use only the supplied text and continuity."""
CRITERIA = {
    "heading": "Begins a distinct semantic section governing subsequent content.",
    "not_heading": "Does not function as an article section heading.",
    "continuation": "Continues an adjacent heading rather than starting another one.",
    "uncertain": "Insufficient textual evidence."
}

def main():
    key = os.environ["TYPESAFE_API_KEY"]
    cases = json.loads((ROOT / "heading_detection_cases.json").read_text(encoding="utf-8"))
    results, started = [], time.perf_counter()
    for case in cases:
        state = f'PREVIOUS BLOCK:\n{case["previous"]}\n\nCURRENT CANDIDATE:\n{case["current"]}\n\nNEXT BLOCK:\n{case["next"]}'
        body = json.dumps({"state": state, "model": MODEL, "questions": {"decision": {"type": "choice", "instructions": INSTRUCTION, "criteria": CRITERIA}}}).encode()
        request = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        answer = payload["answers"]["decision"]
        row = {**case, "choice": answer["choice"], "confidence": answer.get("confidence"), "correct": answer["choice"] == case["expected"], "state_sent": state}
        results.append(row)
        print(f'{case["id"]}: {row["choice"]} (expected {case["expected"]}, confidence {row["confidence"]})')
    summary = {"model": MODEL, "cases": len(results), "correct": sum(r["correct"] for r in results), "accuracy": sum(r["correct"] for r in results) / len(results), "seconds": time.perf_counter() - started, "instruction": INSTRUCTION, "results": results}
    out = ROOT / "receipts" / "heading-detection-v2-latest.json"
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("cases", "correct", "accuracy", "seconds")}, indent=2))

if __name__ == "__main__":
    main()
