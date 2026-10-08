"""Score the installed parser's footnotes against the journal footnote gold.

Each gold PDF registered as `olj-footnote-gold.v1` in the corpus gold catalog is
parsed by the current native addon with the app's own PDF profile
(experiments/legal-structure-gold/extract.mjs) and its structure notes are
compared with the gold pairs:

  notes       printed label on the label's page (body-start agreement is reported)
  references  reference marker value on its page
  positions   references whose preceding word matches the gold line
  pairs       reference page + label page + note value

Totals are micro-averaged. The summary goes to <out>/score/latest.json, and with
--save NAME also to <out>/score/NAME.json; --against prints the change from an
earlier summary over the documents both scored.

  python experiments/footnote-gold/score.py [--addon DLL] [--limit N] [--save NAME] [--against FILE] [--show]
"""
import argparse
from collections import Counter
import difflib
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "experiments/legal_pdf_corpus"))
import corpus_store  # noqa: E402

DATASET = "olj-footnote-gold.v1"
EXTRACT = ROOT / "experiments/legal-structure-gold/extract.mjs"
LAYERS = ("notes", "references", "positions", "pairs")
SYMBOLS = {"∗": "*", "": "*", "＊": "*"}


def label_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "").strip().strip(".)]([:,;")
    value = "".join(SYMBOLS.get(c, c) for c in value)
    return str(int(value)) if value.isdigit() else value


def words(text: str) -> list[str]:
    return re.findall(r"[^\W\d_]{2,}", unicodedata.normalize("NFKC", text).lower())


def gold_records(limit: int):
    with corpus_store.connect() as db:
        rows = db.execute("select r.sha256, f.path, a.path from gold_records r join files f on f.sha256=r.sha256"
                          " join gold_artifacts a on a.run_id=r.run_id and a.role='gold'"
                          " where r.dataset=? and r.status='complete' order by f.pages, r.sha256", (DATASET,)).fetchall()
    return rows[:limit] if limit else rows


def addon_sha256() -> str:
    # The binary extract.mjs loads: a pinned addon, else the most recently built one.
    pinned = os.environ.get("LEGAL_STRUCTURE_ADDON")
    built = [ROOT / "native/legal-structure-node/target" / profile / "legal_structure_node.dll" for profile in ("debug", "release")]
    chosen = Path(pinned) if pinned else max((path for path in built if path.exists()), key=lambda path: path.stat().st_mtime)
    return hashlib.sha256(chosen.read_bytes()).hexdigest()


def parse(pdf: Path, cache: Path, sha: str, binary: str) -> dict:
    # Carry an earlier binary's OCR forward: its cache key names the OCR code,
    # so recognition is reused while extraction and structure run again.
    previous = sorted((cache / sha).glob("*/*/parse-v1"))
    if previous and not (cache / sha / binary).exists():
        target = cache / sha / binary / previous[-1].parent.name / "parse-v1"
        if (previous[-1] / "recognition").is_dir():
            target.mkdir(parents=True, exist_ok=True)
            shutil.move(previous[-1] / "recognition", target / "recognition")
    process = subprocess.run(["node", str(EXTRACT), str(pdf), str(cache), "ocr"], capture_output=True, text=True,
                             encoding="utf-8", creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS if sys.platform == "win32" else 0)
    if process.returncode:
        raise RuntimeError(process.stderr[-1500:])
    output = Path(process.stdout.strip().splitlines()[-1])
    # Keep only this binary's parse of the PDF: one latest candidate per source.
    for stale in output.parents[2].iterdir():
        if stale != output.parents[1]:
            shutil.rmtree(stale, ignore_errors=True)
    with gzip.open(output) as stream:
        return json.load(stream)


def predicted(candidate: dict):
    structure = candidate["structure"]
    text = structure["text"]
    nodes = {node["id"]: node for node in structure["nodes"]}
    notes, refs = [], []
    for note in structure.get("notes", []):
        node = nodes.get(note.get("node_id"), {})
        page = (node.get("page_indexes") or [0])[0] + 1
        label = label_key(text[note["label_range"]["start"]:note["label_range"]["end"]]) if note.get("label_range") else ""
        body = text[note["body_range"]["start"]:note["body_range"]["end"]]
        notes.append({"page": page, "label": label, "kind": note.get("kind"), "body": body[:160]})
        for ref in note.get("references", []):
            start, end = ref["range"]["start"], ref["range"]["end"]
            refs.append({"page": (ref.get("page_indexes") or [0])[0] + 1, "label": label_key(text[start:end]),
                         "note_page": page, "note_label": label, "before": words(text[max(0, start - 60):start])[-2:]})
    return notes, refs


def expected(gold: dict):
    notes, refs = [], []
    for pair in gold["notes"]:
        label = next(iter(pair["labels"]), None)
        for marker in pair["labels"]:
            notes.append({"page": marker["page"], "label": label_key(pair["note_id"]),
                          "body": marker["line_text"][marker["end"]:][:160]})
        for marker in pair["refs"]:
            refs.append({"page": marker["page"], "label": label_key(pair["note_id"]),
                         "note_page": label["page"] if label else None, "note_label": label_key(pair["note_id"]),
                         "before": words(marker["line_text"][:marker["start"]])[-2:]})
    return notes, refs


def count(gold_items, predicted_items, key):
    want, got = Counter(map(key, gold_items)), Counter(map(key, predicted_items))
    return {"expected": sum(want.values()), "predicted": sum(got.values()), "correct": sum((want & got).values())}


def compare(gold: dict, candidate: dict) -> dict:
    gold_notes, gold_refs = expected(gold)
    notes, refs = predicted(candidate)
    metrics = {
        "notes": count(gold_notes, notes, lambda n: (n["page"], n["label"])),
        "references": count(gold_refs, refs, lambda r: (r["page"], r["label"])),
        "pairs": count(gold_refs, refs, lambda r: (r["page"], r["label"], r["note_page"], r["note_label"])),
    }
    # A reference is in position when one of the two words before it matches the gold line's.
    position = {"expected": len(gold_refs), "predicted": len(refs), "correct": 0}
    pool = {}
    for ref in gold_refs:
        pool.setdefault((ref["page"], ref["label"]), []).append(ref["before"])
    for ref in refs:
        options = pool.get((ref["page"], ref["label"]), [])
        for index, before in enumerate(options):
            if any(difflib.SequenceMatcher(None, a, b).ratio() >= 0.75 for a in before for b in ref["before"]) or (not before and not ref["before"]):
                position["correct"] += 1
                options.pop(index)
                break
    metrics["positions"] = position
    # Body-start agreement of label-matched notes, and the unmatched predictions for inspection.
    pool, bodies, agreed, false_notes = {}, 0, 0, []
    for note in gold_notes:
        pool.setdefault((note["page"], note["label"]), []).append(note["body"])
    for note in notes:
        options = pool.get((note["page"], note["label"]))
        if options:
            gold_body = options.pop(0)
            bodies += 1
            a, b = words(gold_body)[:8], words(note["body"])[:10]
            agreed += bool(a) and sum(1 for w in a if w in b) >= 0.6 * len(a) or not a
        else:
            false_notes.append({"page": note["page"], "label": note["label"], "body": note["body"][:100]})
    missed = [{"page": p, "label": l, "body": bs[0][:100]} for (p, l), bs in pool.items() for _ in bs]
    return {"metrics": metrics, "bodies": {"matched": bodies, "agreed": agreed},
            "false_notes": false_notes, "missed_notes": missed}


def aggregate(rows):
    totals = {name: {"expected": 0, "predicted": 0, "correct": 0} for name in LAYERS}
    for row in rows:
        for name in LAYERS:
            for key in ("expected", "predicted", "correct"):
                totals[name][key] += row["metrics"][name][key]
    for total in totals.values():
        p = total["correct"] / total["predicted"] if total["predicted"] else 1.0
        r = total["correct"] / total["expected"] if total["expected"] else 1.0
        total.update(precision=p, recall=r, f1=2 * p * r / (p + r) if p + r else 0.0)
    return totals


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=ROOT / "benchmarks/local-data/olj-footnote-gold")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--save")
    parser.add_argument("--addon", type=Path, help="Built addon to load instead of the most recent build")
    parser.add_argument("--against", type=Path)
    parser.add_argument("--show", action="store_true", help="Print per-document results and false notes")
    args = parser.parse_args()
    if args.addon:
        os.environ["LEGAL_STRUCTURE_ADDON"] = str(args.addon.resolve())
    results, binary = [], addon_sha256()
    for sha, rel, gold_path in gold_records(args.limit):
        gold = json.loads(Path(gold_path).read_text(encoding="utf-8"))
        name = f"{gold['dataset']}:{gold['article_id']}"
        try:
            candidate = parse(corpus_store.HOME / rel, args.out / "candidates", sha, binary)
            lines = [(line["text"], line["bbox"]) for page in candidate["extraction"]["pages"] for line in page["lines"]]
            row = {"document": name, "sha256": sha, "pages": gold["pages"], **compare(gold, candidate),
                   "binary_sha256": candidate["parser"]["binary_sha256"],
                   "input_sha256": hashlib.sha256(json.dumps(lines).encode()).hexdigest()}
        except Exception as error:
            row = {"document": name, "sha256": sha, "error": str(error)[-600:]}
        results.append(row)
        print(name, "ERROR" if "error" in row else " ".join(
            f"{k}={v['correct']}/{v['expected']}/{v['predicted']}" for k, v in row["metrics"].items()), flush=True)
    scored = [r for r in results if "metrics" in r]
    summary = {"dataset": DATASET, "documents": len(results), "pages": sum(r.get("pages") or 0 for r in results),
               "binaries": sorted({r["binary_sha256"] for r in scored}), "errors": [r for r in results if "error" in r],
               "totals": aggregate(scored),
               "bodies": {k: sum(r["bodies"][k] for r in scored) for k in ("matched", "agreed")}, "per_document": scored}
    for name in ["latest"] + ([args.save] if args.save else []):
        destination = args.out / "score" / f"{name}.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    before = None
    if args.against:
        earlier = {r["document"]: r for r in json.loads(args.against.read_text(encoding="utf-8"))["per_document"]}
        common = [r for r in scored if r["document"] in earlier]
        same = sum(earlier[r["document"]].get("input_sha256") == r["input_sha256"] for r in common)
        print(f"{same}/{len(common)} documents read the same lines as before")
        before, now = aggregate([earlier[r["document"]] for r in common]), aggregate(common)
        print(f"{len(common)} documents in common with {args.against.name}")
    print(f"{summary['documents']} documents, {summary['pages']} pages, {len(summary['errors'])} errors;"
          f" bodies agreeing {summary['bodies']['agreed']}/{summary['bodies']['matched']}")
    print(f"{'layer':12} {'exp':>6} {'pred':>6} {'ok':>6} {'P':>6} {'R':>6} {'F1':>6}" + ("     dP     dR" if before else ""))
    for name, t in summary["totals"].items():
        delta = f" {now[name]['precision'] - before[name]['precision']:+6.3f} {now[name]['recall'] - before[name]['recall']:+6.3f}" if before else ""
        print(f"{name:12} {t['expected']:6} {t['predicted']:6} {t['correct']:6} {t['precision']:6.3f} {t['recall']:6.3f} {t['f1']:6.3f}{delta}")
    if args.show:
        for row in scored:
            for note in row["false_notes"]:
                print("FALSE", row["document"], note)
            for note in row["missed_notes"]:
                print("MISSED", row["document"], note)
    for error in summary["errors"]:
        print("ERROR", error["document"], error["error"], file=sys.stderr)


if __name__ == "__main__":
    main()
