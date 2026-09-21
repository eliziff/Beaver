"""Text-only journal block-quotation discrimination probe."""
import argparse, difflib, json, os, re, statistics, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
MODEL = "jev-1.13.0"
URL = "https://api.typesafe.ai/v1/systemone"
QUESTION = """Classify CURRENT BLOCK by its semantic role in the reconstructed article.

block_quotation: a distinct, extended reproduction of external source material, such as quoted interview speech, a judgment, legislation, or another publication. It is separate from the article author's narrative, even if quotation marks are absent.
article_prose: the article author's own narrative or analysis. This includes prose containing a short inline quotation or paraphrase.
other_structure: a heading, byline, citation, footnote, list, table, or other non-prose structure.
uncertain: the supplied text is insufficient to distinguish these roles.

Use only the supplied words and textual continuity. Choose the single best role for CURRENT BLOCK."""

OAJD = Path(os.environ.get("OAJD_FINAL_CONTRACTS", r"C:\Users\elias\Desktop\Open Access Journals Database\data\final_contracts"))

def normalized(value):
    return re.sub(r"\W+", "", value).lower()

def geometry_state(case):
    path, page_text = case["source"].rsplit(" p", 1)
    rows = [json.loads(line) for line in (OAJD / path / "pages.jsonl").read_text(encoding="utf-8").splitlines()]
    row = next(item for item in rows if int(item["pdf_page"]) == int(page_text))
    regions = row["regions"]
    wanted = normalized(case["current"])
    index = max(range(len(regions)), key=lambda i: difflib.SequenceMatcher(None, wanted, normalized(regions[i].get("text", ""))).ratio())
    boxes = [line["bbox"] for region in regions for line in region.get("lines", []) if line.get("bbox")]
    width = max(box["x1"] for box in boxes)
    height = max(box["y1"] for box in boxes)
    def describe(label, region):
        lines = []
        for line in region.get("lines", []):
            box = line.get("bbox")
            if box:
                coords = [box["x0"] / width, box["y0"] / height, box["x1"] / width, box["y1"] / height]
                lines.append(f'  bbox={coords[0]:.3f},{coords[1]:.3f},{coords[2]:.3f},{coords[3]:.3f} text={line["text"]}')
        return label + ":\n" + ("\n".join(lines) if lines else region.get("text", ""))
    selected = regions[max(0, index - 1):min(len(regions), index + 2)]
    labels = ["PREVIOUS BLOCK", "CURRENT BLOCK", "NEXT BLOCK"][-index if index == 0 else 0:]
    if index == 0:
        labels = ["CURRENT BLOCK", "NEXT BLOCK"]
    elif index == len(regions) - 1:
        labels = ["PREVIOUS BLOCK", "CURRENT BLOCK"]
    return "SOURCE PAGE LINE GEOMETRY (normalized x0,y0,x1,y1; top-left origin):\n" + "\n\n".join(describe(label, region) for label, region in zip(labels, selected))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", choices=("text", "geometry"), default="text")
    args = parser.parse_args()
    key = os.environ["TYPESAFE_API_KEY"]
    cases = json.loads((ROOT / "journal_cases.json").read_text(encoding="utf-8"))
    results = []
    for case in cases:
        state = geometry_state(case) if args.arm == "geometry" else "PREVIOUS BLOCK:\n" + case["previous"] + "\n\nCURRENT BLOCK:\n" + case["current"] + "\n\nNEXT BLOCK:\n" + case["next"]
        criteria = {
            "block_quotation": "A distinct extended reproduction of external source material.",
            "article_prose": "The article author's own narrative or analysis, including inline quotation.",
            "other_structure": "A heading, byline, citation, footnote, list, table, or other structure.",
            "uncertain": "The supplied text is insufficient to decide."
        }
        instructions = QUESTION
        if args.arm == "geometry":
            instructions += "\n\nThe bbox values are observations from the source page, not proposed output formatting. You may use differences in line position, width, and spacing relative to neighboring blocks as evidence, but no geometric pattern by itself defines a block quotation."
        body = json.dumps({"state": state, "model": MODEL, "questions": {"role": {"type": "choice", "instructions": instructions, "criteria": criteria}}}).encode()
        req = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
        started = time.perf_counter()
        with urllib.request.urlopen(req, timeout=20) as response:
            payload = json.load(response)
        answer = payload["answers"]["role"]
        choice = answer["choice"]
        row = {**case, "state_sent": state, "choice": choice, "correct": choice == case["expected"], "seconds": time.perf_counter() - started, "answer": answer}
        results.append(row)
        print(f'{case["id"]}: {choice} (expected {case["expected"]})')
    summary = {"model": MODEL, "arm": args.arm, "question": QUESTION, "input_fields": ["previous", "current", "next"] if args.arm == "text" else ["line_text", "normalized_line_bbox", "source_order", "candidate_boundaries"], "cases": len(results), "correct": sum(r["correct"] for r in results), "accuracy": sum(r["correct"] for r in results) / len(results), "median_seconds": statistics.median(r["seconds"] for r in results), "results": results}
    out = ROOT / "receipts" / f"journal-{args.arm}-latest.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("model", "cases", "correct", "accuracy", "median_seconds")}, indent=2))

if __name__ == "__main__":
    main()
