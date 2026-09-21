"""Focused Jev promotion/demotion cases mirrored from structure tests."""
import json, os, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-1.13.0"
CASES = [
    ("clean-i", "heading_level_1"), ("clean-a", "heading_level_2"),
    ("clean-b", "heading_level_2"), ("clean-ii", "heading_level_1"),
    ("flow", "not_heading"), ("numeric-15", "not_heading"),
    ("numeric-16", "not_heading"), ("caps", "heading_level_1"),
    ("author", "not_heading"), ("wrap-i", "heading_level_1"),
    ("wrap-continuation", "continuation_of_previous_heading")
]
STATE = """These are independent miniature document fragments. PROPOSED ROLE is fallible evidence.

CLEAN LADDER (all proposed body):
[clean-i] I. First Part
[clean-a] A. First Issue
[clean-b] B. Second Issue
[clean-ii] II. Second Part

BODY FLOW:
Prior: Ordinary narrative text ends here.
[flow] proposed heading, bold: I. This Is Actually
Next: continued prose from the same sentence.

LONG NUMERIC RUN (both proposed heading):
Prior: Ordinary narrative text ends here.
[numeric-15] 15. Historical Note
[numeric-16] 16. Further Note
Next: Ordinary narrative text continues here.

DISPLAY AND AUTHOR (same visual style):
[caps] proposed body: CONSTITUTIONAL PRINCIPLES
[author] proposed heading: JANE EXAMPLE
Next: Ordinary narrative text begins here.

WRAPPED DISPLAY (both proposed body, same bold style, second line slightly inset):
[wrap-i] I. A Complete Account Of
[wrap-continuation] The Governing Framework
Next: Ordinary prose begins after the display heading."""
INSTRUCTION = """Correct the proposed role for the specified candidate using the whole miniature document.
Choose not_heading, heading_level_1, heading_level_2, heading_level_3,
continuation_of_previous_heading, or uncertain. A heading opens a semantic
section; a line merely resembling a numbered or uppercase heading does not.
Heading levels must form one coherent hierarchy within that miniature document."""

def main():
    key = os.environ["TYPESAFE_API_KEY"]
    criteria = {name: name.replace("_", " ") for name in ("not_heading", "heading_level_1", "heading_level_2", "heading_level_3", "continuation_of_previous_heading", "uncertain")}
    questions = {ident: {"type": "choice", "instructions": INSTRUCTION + f"\n\nClassify [{ident}].", "criteria": criteria} for ident, _ in CASES}
    body = json.dumps({"state": STATE, "model": MODEL, "questions": questions}).encode()
    started = time.perf_counter()
    req = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.load(response)
    results = []
    for ident, expected in CASES:
        answer = payload["answers"][ident]
        row = {"id": ident, "expected": expected, "choice": answer["choice"], "confidence": answer.get("confidence"), "correct": answer["choice"] == expected}
        results.append(row)
        print(f'{ident}: {row["choice"]} (expected {expected}, confidence {row["confidence"]})')
    summary = {"model": MODEL, "cases": len(results), "correct": sum(r["correct"] for r in results), "accuracy": sum(r["correct"] for r in results) / len(results), "seconds": time.perf_counter() - started, "state": STATE, "instruction": INSTRUCTION, "results": results}
    out = ROOT / "receipts" / "heading-grammar-latest.json"
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("cases", "correct", "accuracy", "seconds")}, indent=2))

if __name__ == "__main__":
    main()
