"""Score model-authored structure golds' footnotes against the human journal footnote gold.

The truth is olj-footnote-gold.v1 (experiments/footnote-gold): scanned law-journal
articles whose every note reference and note label was placed by hand on its printed
glyph, one reference and one label per note. Each gold of a RUN in the gold store
(experiments/legal_pdf_corpus/gold_store.py: structure/<batch>-<run>/; run a is the current gold,
other letters are model trials) whose source is a MANIFEST article with a truth record is
compared with it:

  references   a model note reference on the truth reference's page, with its label,
               at its place on the line (strict); `references_page_label` drops the place
  notes        a model note label (the printed marker of a typed `note` line) on the
               truth label's page, with its value
  pairs        a strictly matched reference paired (gold["notes"]) with the note unit
               whose label is the truth note's page and value; `pair_accuracy` is the
               share of strictly matched references paired right
  false refs   model references with no truth reference of that page and label at all:
               superscript numbers, exponents, citation numbers typed as note references

Place is text context, not geometry: the truth records each marker as an offset into
its line's text, with no box, so a model reference is in place when one of the three
words before it, or one of the three after it, matches one on the same side of the
truth marker (ratio >= 0.75, the footnote-gold scorer's rule), or when either line has
no word around the mark. Labels are normalized as the
footnote-gold scorer does. Totals are micro-averaged over the scored documents.

  python experiments/legal-structure-gold/arms/truth_notes.py MANIFEST [--runs a b ...]
         [--truth DIR] [--out FILE] [--show]

Each run is scored as its own arm. Summary JSON: --out, default truth-notes.json beside the manifest.
"""
import argparse
from collections import Counter
import difflib
import gzip
import json
from pathlib import Path
import re
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "experiments/legal_pdf_corpus"))
import gold_store  # noqa: E402
TRUTH = ROOT / "benchmarks/local-data/olj-footnote-gold/gold"
SYMBOLS = {"∗": "*", "": "*", "＊": "*"}
LAYERS = ("references", "references_page_label", "notes", "pairs")


def label_key(value: str) -> str:
    # experiments/footnote-gold/score.py's normalization.
    value = unicodedata.normalize("NFKC", value or "").strip().strip(".)]([:,;^")
    value = "".join(SYMBOLS.get(c, c) for c in value)
    return str(int(value)) if value.isdigit() else value


def words(text: str) -> list[str]:
    return re.findall(r"[^\W\d_]{2,}", unicodedata.normalize("NFKC", text).lower())


def context(text: str, start: int, end: int) -> tuple:
    return words(text[:start])[-3:], words(text[end:])[:3]


def alike(a: list, b: list) -> bool:
    return any(difflib.SequenceMatcher(None, x, y).ratio() >= 0.75 for x in a for y in b)


def in_place(model, truth: tuple) -> bool:
    if model is None:
        return False
    (mb, ma), (tb, ta) = model, truth
    if mb and tb and alike(mb, tb) or ma and ta and alike(ma, ta):
        return True
    # No word on one side's line to compare: the place cannot be told apart.
    return not (mb or ma) or not (tb or ta)


def load(path: Path) -> dict:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def truth_items(truth: dict):
    notes, refs = [], []
    for pair in truth["notes"]:
        label = label_key(pair["note_id"])
        home = pair["labels"][0]["page"] if pair["labels"] else None
        for marker in pair["labels"]:
            notes.append({"page": marker["page"], "label": label})
        for marker in pair["refs"]:
            refs.append({"page": marker["page"], "label": label, "note": (home, label),
                         "context": context(marker["line_text"], marker["start"], marker["end"]),
                         "text": marker["line_text"]})
    return notes, refs


def model_items(value: dict):
    """The gold's note labels {typed index: (page, label)}, its references, and its pairs
    {(typed index, reference index): (note page, note label) or None}."""
    texts = {line["id"]: line.get("corrected", line["text"]) for line in value["lines"]}
    pages = {line["id"]: line["page"] for line in value["lines"]}
    typed = value["typed"]
    labels = {}
    for n, line in enumerate(typed):
        if line["region"] == "note" and line.get("markers") and line["markers"][0]:
            span = line["markers"][0][0]
            labels[n] = (line["page"], label_key(texts[span["line_id"]][span["start"]:span["end"]]))
    unit_label = {}
    for u, unit in enumerate(value["units"]):
        found = [labels[n] for n in unit["lines"] if n in labels]
        if found:
            unit_label[u] = found[0]
    refs = []
    for n, line in enumerate(typed):
        for r, ref in enumerate(line.get("references") or []):
            # A reference with no span was never placed on a line: its page and label count, not its place.
            span = (ref.get("spans") or [None])[0]
            text = texts.get(span["line_id"], "") if span else line["text"]
            refs.append({"key": (n, r), "page": pages.get(span["line_id"], line["page"]) if span else line["page"],
                         "label": label_key(ref["label"]), "region": line["region"], "text": text,
                         "context": context(text, span["start"], span["end"]) if span else None})
    pairs = {}
    for pair in value.get("notes") or []:
        if pair.get("reference") is not None:
            pairs[(pair["line"], pair["reference"])] = unit_label.get(pair["note"]) if pair.get("note") is not None else None
    unresolved = sum(1 for pair in value.get("notes") or [] if pair.get("reference") is None)
    return list(labels.values()), refs, pairs, unresolved


def tally(expected, predicted, correct):
    return {"expected": expected, "predicted": predicted, "correct": correct}


def compare(truth: dict, value: dict) -> dict:
    gold_notes, gold_refs = truth_items(truth)
    # A gold authored over a document's first pages only is scored on those pages.
    covered = value.get("page_count") or max((line["page"] for line in value["lines"]), default=0)
    gold_notes = [n for n in gold_notes if n["page"] <= covered]
    gold_refs = [r for r in gold_refs if r["page"] <= covered]
    notes, refs, pairs, unresolved = model_items(value)
    want = Counter((n["page"], n["label"]) for n in gold_notes)
    got = Counter(notes)
    # Strict: page, label and place; then the rest by page and label alone.
    pool = {}
    for t in gold_refs:
        pool.setdefault((t["page"], t["label"]), []).append(t)
    strict, loose = {}, {}
    for m in refs:
        options = pool.get((m["page"], m["label"]), [])
        hit = next((t for t in options if in_place(m["context"], t["context"])), None)
        if hit:
            options.remove(hit); strict[m["key"]] = hit
    for m in refs:
        options = pool.get((m["page"], m["label"]), [])
        if m["key"] not in strict and options:
            loose[m["key"]] = options.pop(0)
    labels_in_truth = {t["label"] for t in gold_refs}
    false_refs = [{"page": m["page"], "label": m["label"], "region": m["region"], "text": m["text"][:120],
                   "kind": "label is a truth note elsewhere" if m["label"] in labels_in_truth else "no truth note has this label"}
                  for m in refs if m["key"] not in strict and m["key"] not in loose]
    misplaced = [{"page": m["page"], "label": m["label"], "model": m["text"][:120], "truth": loose[m["key"]]["text"][:120]}
                 for m in refs if m["key"] in loose]
    missed = [{"page": t["page"], "label": t["label"], "text": t["text"][:120]} for options in pool.values() for t in options]
    paired = sum(1 for key, hit in strict.items() if pairs.get(key) == hit["note"])
    predicted_pairs = sum(1 for note in pairs.values() if note is not None) + unresolved
    metrics = {"references": tally(len(gold_refs), len(refs), len(strict)),
               "references_page_label": tally(len(gold_refs), len(refs), len(strict) + len(loose)),
               "notes": tally(sum(want.values()), sum(got.values()), sum((want & got).values())),
               "pairs": tally(len(gold_refs), predicted_pairs, paired)}
    return {"metrics": metrics, "matched_references": len(strict), "paired_right": paired,
            "unresolved_pairs": unresolved, "false_references": false_refs, "misplaced_references": misplaced,
            "missed_references": missed,
            "missed_notes": [{"page": p, "label": l} for (p, l), k in (want - got).items() for _ in range(k)],
            "false_notes": [{"page": p, "label": l} for (p, l), k in (got - want).items() for _ in range(k)]}


def aggregate(rows):
    totals = {name: tally(0, 0, 0) for name in LAYERS}
    for row in rows:
        for name in LAYERS:
            for key in ("expected", "predicted", "correct"):
                totals[name][key] += row["metrics"][name][key]
    for total in totals.values():
        p = total["correct"] / total["predicted"] if total["predicted"] else 1.0
        r = total["correct"] / total["expected"] if total["expected"] else 1.0
        total.update(precision=round(p, 4), recall=round(r, 4), f1=round(2 * p * r / (p + r), 4) if p + r else 0.0)
    matched = sum(r["matched_references"] for r in rows)
    false = [f for r in rows for f in r["false_references"]]
    return {"layers": totals, "pair_accuracy": round(sum(r["paired_right"] for r in rows) / matched, 4) if matched else None,
            "false_references": len(false), "false_reference_kinds": dict(Counter(f["kind"] for f in false)),
            "false_reference_regions": dict(Counter(f["region"] for f in false)),
            "misplaced_references": sum(len(r["misplaced_references"]) for r in rows),
            "unresolved_pairs": sum(r["unresolved_pairs"] for r in rows)}


def run_gold(sha: str, run: str):
    """The source's gold of one run in the gold store, or None."""
    found = [p for p in gold_store.structure_runs(gold_store.ROOT / sha) if p.name.rsplit("-", 1)[1] == run]
    return found[-1] / "gold.json.gz" if found else None


def score_run(run: str, rows: list, truth_dir: Path) -> dict:
    per_document, absent = [], []
    for row in rows:
        path, truth_path = run_gold(row["sha256"], run), truth_dir / row["sha256"] / "gold.json"
        if not truth_path.is_file():
            continue
        if path is None:
            absent.append(row["sha256"]); continue
        truth = load(truth_path)
        try:
            result = compare(truth, load(path))
        except Exception as error:
            per_document.append({"sha256": row["sha256"], "article": f"{truth['dataset']}:{truth['article_id']}",
                                 "error": f"{type(error).__name__}: {error}"[:500]}); continue
        per_document.append({"sha256": row["sha256"], "article": f"{truth['dataset']}:{truth['article_id']}",
                             "pages": truth["pages"], **result})
    scored = [r for r in per_document if "metrics" in r]
    return {"run": run, "scored": len(scored), "not_authored": absent,
            "errors": [r for r in per_document if "error" in r], "totals": aggregate(scored), "per_document": scored}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--runs", nargs="+", default=[gold_store.CURRENT_RUN], help="The gold store's runs to score (default: the current gold)")
    parser.add_argument("--truth", type=Path, default=TRUTH, help="olj-footnote-gold gold/ directory")
    parser.add_argument("--out", type=Path, help="Summary JSON (default: truth-notes.json beside the manifest)")
    parser.add_argument("--show", action="store_true", help="Print each false, misplaced and missed reference")
    args = parser.parse_args()
    manifest = args.manifest
    rows = load(manifest)["documents"]
    results = {run: score_run(run, rows, args.truth) for run in args.runs}
    out = args.out or manifest.parent / "truth-notes.json"
    out.write_text(json.dumps({"manifest": str(manifest), "truth": str(args.truth), "place": "text context",
                               "arms": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    head = f"{'arm':16} {'docs':>4}  " + "  ".join(f"{n[:10]:>10} P/R" for n in LAYERS) + f"  {'pairacc':>7} {'falseref':>8}"
    print(head)
    for arm, result in results.items():
        t = result["totals"]
        if not result["scored"]:
            print(f"{arm:16} {0:4}  ({len(result['not_authored'])} not authored, {len(result['errors'])} errors)")
            continue
        cells = "  ".join(f"{t['layers'][n]['precision']:6.3f}/{t['layers'][n]['recall']:.3f}" for n in LAYERS)
        accuracy = f"{t['pair_accuracy']:.3f}" if t["pair_accuracy"] is not None else "-"
        print(f"{arm:16} {result['scored']:4}  {cells}  {accuracy:>7} {t['false_references']:8}"
              + (f"   ({len(result['not_authored'])} not authored, {len(result['errors'])} errors)" if result["not_authored"] or result["errors"] else ""))
    if args.show:
        for arm, result in results.items():
            for row in result["per_document"]:
                for kind in ("false_references", "misplaced_references", "missed_references"):
                    for item in row[kind]:
                        print(arm, row["article"], kind.split("_")[0].upper(), json.dumps(item, ensure_ascii=False))
    for result in results.values():
        for error in result["errors"]:
            print("ERROR", error["article"], error["error"], file=sys.stderr)
    print(f"-> {out}")


if __name__ == "__main__":
    main()
