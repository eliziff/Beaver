"""The structure yardstick: one grade of the frozen gold, reduced to the layers that matter, as one
row of the ledger. Rows are comparable because the gold and the document set never change under
them: the ledger names its gold commit and its documents, and refuses a grade of anything else.

  python ledger.py GRADE.json --label NAME --code COMMIT --gold COMMIT [--write]
  python ledger.py GRADE.json --freeze --gold COMMIT        # start a ledger on this grade's documents

GRADE.json is a `structure-gold grade STORE` output. Without --write the row is printed only.
"""
import argparse
import hashlib
import json
from pathlib import Path

HOME = Path(__file__).resolve().parents[3] / "benchmarks" / "local-data" / "structure-ledger"
# Primary addressable units first (paragraph numbers, sections), then headings, then the rest.
LAYERS = ["markers_text", "markers_provision", "units_provision", "depth_steps",
          "units_heading", "heading_steps", "markers_heading", "units_note", "note_references", "hierarchy"]
BY_TYPE = "units_heading"


def f1(e, p, c):
    return 2 * c / (e + p) if e + p else float("nan")


def reduce(grade, documents):
    runs = [r for r in grade["per_run"] if r["run"] in documents]
    row = {}
    for layer in LAYERS:
        e = p = c = 0
        per_doc = []
        for r in runs:
            m = r["metrics"].get(layer)
            if not m:
                continue
            e += m["expected"]; p += m["predicted"]; c += m["correct"]
            if m["expected"] >= 5:  # a typical document, not a 300-page one weighed 300 times
                per_doc.append(f1(m["expected"], m["predicted"], m["correct"]))
        per_doc.sort()
        row[layer] = (f1(e, p, c), c / p if p else float("nan"), c / e if e else float("nan"),
                      per_doc[len(per_doc) // 2] if per_doc else float("nan"))
    types = {}
    for r in runs:
        m = r["metrics"].get(BY_TYPE)
        if m:
            t = types.setdefault(r["genre_group"], [0, 0, 0])
            t[0] += m["expected"]; t[1] += m["predicted"]; t[2] += m["correct"]
    return len(runs), row, {k: f1(*v) for k, v in sorted(types.items())}


def main():
    a = argparse.ArgumentParser()
    a.add_argument("grade")
    a.add_argument("--label")
    a.add_argument("--code")
    a.add_argument("--gold", required=True)
    a.add_argument("--freeze", action="store_true")
    a.add_argument("--write", action="store_true")
    args = a.parse_args()
    grade = json.load(open(args.grade, encoding="utf-8"))
    frozen = HOME / "documents.txt"
    if args.freeze:
        if frozen.exists():
            raise SystemExit(f"{frozen} exists: the yardstick is already frozen")
        HOME.mkdir(parents=True, exist_ok=True)
        frozen.write_text("".join(f"{r['run']}\n" for r in sorted(grade["per_run"], key=lambda r: r["run"])), encoding="utf-8")
        (HOME / "gold.txt").write_text(args.gold + "\n", encoding="utf-8")
        print(f"froze {len(grade['per_run'])} documents on gold {args.gold}")
        return
    gold = (HOME / "gold.txt").read_text(encoding="utf-8").strip()
    if not args.gold.startswith(gold[:7]) and not gold.startswith(args.gold[:7]):
        raise SystemExit(f"grade is of gold {args.gold}; the ledger is frozen on {gold}")
    documents = set(frozen.read_text(encoding="utf-8").split())
    graded = {r["run"] for r in grade["per_run"]}
    if documents - graded:
        raise SystemExit(f"{len(documents - graded)} frozen documents missing from the grade (e.g. {sorted(documents - graded)[0]})")
    n, row, types = reduce(grade, documents)
    digest = hashlib.sha256("".join(sorted(documents)).encode()).hexdigest()[:8]
    lines = [f"## {args.label} (code {args.code}, gold {gold[:7]}, {n} documents {digest})", "",
             "| layer | F1 | P | R | median doc |", "|---|---|---|---|---|"]
    lines += [f"| {k} | {v[0]:.3f} | {v[1]:.3f} | {v[2]:.3f} | {v[3]:.3f} |" for k, v in row.items()]
    lines += ["", "headings by type: " + ", ".join(f"{k} {v:.2f}" for k, v in types.items()), "", ""]
    text = "\n".join(lines)
    print(text)
    if args.write:
        with open(HOME / "LEDGER.md", "a", encoding="utf-8") as out:
            out.write(text)


main()
