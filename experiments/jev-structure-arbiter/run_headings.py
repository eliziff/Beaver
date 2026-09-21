"""Jev heading detection and global hierarchy probe over one complete OAJD article."""
import argparse, json, os, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
MODEL = "jev-1.13.0"
URL = "https://api.typesafe.ai/v1/systemone"
SOURCE = Path(r"C:\Users\elias\Desktop\Open Access Journals Database\data\final_contracts\ALTA-L-REV\63\3\8845\pages.jsonl")

EXPECTED = [
    ("introduction", "INTRODUCTION", "heading_level_1"),
    ("conflicts", "I. CONFLICTS OF LAWS IN CANADA", "heading_level_1"),
    ("recent-cases", "RECENT CRIMINAL CONTEMPT CASES IN BRITISH COLUMBIA", "heading_level_2"),
    ("tools", "TOOLS EXIST TO MANAGE CONFLICTS OF LAWS IN OTHER", "heading_level_2"),
    ("indigenous-law", "II. INDIGENOUS LAW HAS UNIQUE SOURCES AND", "heading_level_1"),
    ("indigenous-wrap-1", "RECOGNIZED STATUS, BUT RECEIVES MIXED", "continuation_of_previous_heading"),
    ("indigenous-wrap-2", "TREATMENT", "continuation_of_previous_heading"),
    ("blameworthiness", "III. MORAL BLAMEWORTHINESS, PROPORTIONALITY, AND", "heading_level_1"),
    ("role", "THE ROLE OF MORAL BLAMEWORTHINESS", "heading_level_2"),
    ("conflict", "CONFLICT WITH INDIGENOUS LAW CHANGES THE NATURE OF", "heading_level_2"),
    ("proportionality", "IV. IGNORING THE MORAL DILEMMA COMPROMISES", "heading_level_1"),
    ("danger", "THE DANGER OF MIXING THE ELEMENTS OF PROPORTIONALITY", "heading_level_2"),
    ("moving", "V. MOVING FORWARD", "heading_level_1"),
    ("systems", "GIVE EACH LEGAL SYSTEM A ROLE", "heading_level_2"),
    ("burden", "GENEROUS, FLEXIBLE EVIDENTIARY BURDEN TIED TO", "heading_level_2"),
    ("objections", "VI. ADDRESSING OBJECTIONS", "heading_level_1"),
    ("conclusion", "VII. CONCLUSION", "heading_level_1"),
    ("prose-1", "Clarity about this proposal and its consequences should ease concerns that may arise.", "not_heading"),
    ("prose-2", "This proposal may come across as wishful thinking for those who argue that there is no", "not_heading"),
]

INSTRUCTIONS = """Assign the semantic article-structure role of the specified candidate.

not_heading: ordinary article prose or another non-heading element.
heading_level_1: a top-level section of the article. The article title is not level 1.
heading_level_2: a subsection within the current level-1 section.
heading_level_3: a subsection within the current level-2 section.
continuation_of_previous_heading: this candidate is another visual line of the immediately preceding heading, not a new heading.
uncertain: the article context does not support a reliable assignment.

Infer one coherent hierarchy across the whole article. Numbering is evidence, not an infallible answer: use semantic scope, sequence, neighboring prose, repeated patterns, and source-page line geometry. Do not create a heading merely because text is uppercase or short."""

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", choices=("full", "outline", "local"), default="full")
    args = parser.parse_args()
    key = os.environ["TYPESAFE_API_KEY"]
    rows = [json.loads(line) for line in SOURCE.read_text(encoding="utf-8").splitlines()]
    candidate_lines = []
    local_states = {}
    for ident, text, _ in EXPECTED:
        found = None
        for row in rows:
            for index, region in enumerate(row["regions"]):
                if text in region.get("text", ""):
                    found = (row["pdf_page"], index, region, row["regions"])
                    break
            if found:
                break
        if not found:
            raise RuntimeError(f"candidate not found: {ident}")
        page, index, region, regions = found
        geometry = []
        for line in region.get("lines", []):
            box = line.get("bbox")
            if box:
                geometry.append(f'{box["x0"]:.1f},{box["y0"]:.1f},{box["x1"]:.1f},{box["y1"]:.1f}')
        candidate_lines.append(f'[{ident}] page={page} bbox={";".join(geometry)} text={region["text"].replace(chr(10), " / ")}')
        local_states[ident] = "\n\n".join([
            f'PREVIOUS BLOCK:\n{regions[index - 1]["text"]}' if index else "PREVIOUS BLOCK:\n",
            f'CURRENT CANDIDATE [{ident}]:\n{region["text"]}\nSOURCE BBOXES: {";".join(geometry)}',
            f'NEXT BLOCK:\n{regions[index + 1]["text"]}' if index + 1 < len(regions) else "NEXT BLOCK:\n"
        ])
    article = "\n\n".join(f'--- PAGE {row["pdf_page"]} ---\n{row["text"]}' for row in rows)
    outline = "ARTICLE TITLE:\n" + rows[0]["title"] + "\n\nORDERED CANDIDATES:\n" + "\n".join(candidate_lines)
    state = outline + ("\n\nFULL ARTICLE TEXT:\n" + article if args.context == "full" else "")
    criteria = {
        "not_heading": "Ordinary prose or another non-heading element.",
        "heading_level_1": "Top-level article section.",
        "heading_level_2": "Subsection within the current level-1 section.",
        "heading_level_3": "Subsection within the current level-2 section.",
        "continuation_of_previous_heading": "Visual continuation of the immediately previous heading.",
        "uncertain": "Insufficient evidence."
    }
    questions = {
        ident: {
            "type": "choice",
            "instructions": INSTRUCTIONS + f"\n\nClassify the candidate labelled [{ident}] in ORDERED CANDIDATES.",
            "criteria": criteria
        }
        for ident, _, _ in EXPECTED
    }
    started = time.perf_counter()
    if args.context != "local":
        body = json.dumps({"state": state, "model": MODEL, "questions": questions}).encode()
        req = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as response:
            payload = json.load(response)
        answers, usage = payload["answers"], payload.get("usage")
    else:
        answers, usage = {}, []
        for ident, _, _ in EXPECTED:
            body = json.dumps({"state": local_states[ident], "model": MODEL, "questions": {ident: questions[ident]}}).encode()
            req = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=30) as response:
                payload = json.load(response)
            answers[ident] = payload["answers"][ident]
            usage.append(payload.get("usage"))
    elapsed = time.perf_counter() - started
    results = []
    for ident, text, expected in EXPECTED:
        answer = answers[ident]
        results.append({"id": ident, "text": text, "expected": expected, "choice": answer["choice"], "confidence": answer.get("confidence"), "correct": answer["choice"] == expected})
        print(f'{ident}: {answer["choice"]} (expected {expected}, confidence {answer.get("confidence")})')
    summary = {"model": MODEL, "context": args.context, "source": str(SOURCE), "full_article_characters": len(article) if args.context == "full" else 0, "request_seconds": elapsed, "cases": len(results), "correct": sum(r["correct"] for r in results), "accuracy": sum(r["correct"] for r in results) / len(results), "instructions": INSTRUCTIONS, "results": results, "usage": usage}
    out = ROOT / "receipts" / f"headings-{args.context}-latest.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("cases", "correct", "accuracy", "request_seconds", "full_article_characters")}, indent=2))

if __name__ == "__main__":
    main()
