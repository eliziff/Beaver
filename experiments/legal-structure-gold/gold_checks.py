"""The gold's consistency checks, over every source's current structure gold in the gold store
(experiments/legal_pdf_corpus/gold_store.py). They report; none rewrites a gold.

  starts      the gold's documents start elsewhere than its source's split annotation says (a page
              start: a document opening on that page; a line start: on that line)
  types       a document's type is missing or outside the document pass's types
  recurring   a line printed at the same place on three or more pages typed as different regions
  headings    the same short text typed as a heading in one place and as another body region elsewhere

  python gold_checks.py [--examples N] [--flagged OUT.json]

--flagged writes the flagged sources and their checks.
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "legal_pdf_corpus"))
import gold_store  # noqa: E402
from prompts import DOCUMENT_TYPES  # noqa: E402


def recurring(lines):
    """The ids of lines among a page's first and last three that recur, numbers aside, among the
    first and last three of three or more pages of the document. A fact of the whole
    document, for the check that such a line is typed alike everywhere."""
    by_page = {}
    for line in lines: by_page.setdefault(line["page"], []).append(line)
    key = lambda text: re.sub(r"\d+", "#", " ".join(text.lower().split()))
    edges = [line for found in by_page.values() for line in {l["id"]: l for l in found[:3] + found[-3:]}.values()]
    pages_of = {}
    for line in edges:
        if key(line["text"]): pages_of.setdefault(key(line["text"]), set()).add(line["page"])
    return {line["id"] for line in edges if len(pages_of.get(key(line["text"]), ())) >= 3}


def flat(text):
    return " ".join(text.replace("\t", " ").split())


def own_starts(gold):
    """Where the gold's documents after its first open: [(page, line id)]."""
    page_of = {line["id"]: line["page"] for line in gold["lines"]}
    out = []
    for u in gold["units"][1:]:
        if u.get("starts_document"):
            line = next((s["line_id"] for t in u["lines"] for s in gold["typed"][t]["spans"]), None)
            out.append((page_of.get(line), line))
    return out


def same_starts(own, starts):
    """Whether the gold's starts are its split annotation's: one each, a page start on that page, a
    line start on that line."""
    if len(own) != len(starts):
        return False
    key = lambda s: (s["page"], s["line_id"]) if isinstance(s, dict) else (s, "")
    return all(page == (s["page"] if isinstance(s, dict) else s) and (not isinstance(s, dict) or line == s["line_id"])
               for (page, line), s in zip(sorted(own, key=lambda o: (o[0] or 0, o[1] or "")), sorted(starts, key=key)))


def check(gold, split=None):
    """{check: [what]} for one gold; split: its source's split annotation, or None."""
    typed, units = gold["typed"], gold["units"]
    groups = [u["lines"] for u in units]
    region = [typed[g[0]]["region"] for g in groups]
    first = [flat(typed[g[0]]["text"]) for g in groups]
    flags = defaultdict(list)
    own = own_starts(gold)
    if split is not None and not same_starts(own, split["document_starts"]):
        flags["starts"].append(f"gold {sorted(own, key=str)[:6]}, split annotation ({split['origin']}) {split['document_starts'][:6]}")
    openings = [u for u in range(len(units)) if u == 0 or units[u].get("starts_document")]
    flags["types"] += [f"unit {u}: {units[u].get('document_type')!r}" for u in openings if units[u].get("document_type") not in DOCUMENT_TYPES]
    # A line printed at the same place on several pages, typed as more than one region.
    by_line = {}
    for t in typed:
        for span in t["spans"]:
            by_line.setdefault(span["line_id"], t["region"])
    key = lambda text: re.sub(r"\d+", "#", " ".join(text.lower().split()))
    seen = defaultdict(set)
    repeated = recurring(gold["lines"])
    for line in gold["lines"]:
        if line["id"] in repeated and line["id"] in by_line:
            seen[key(line["text"])].add(by_line[line["id"]])
    flags["recurring"] += [f"{text[:60]}: {', '.join(sorted(regions))}" for text, regions in seen.items() if len(regions) > 1]
    # The same short text a heading in one place and a body unit in another.
    headed = {first[u] for u in range(len(units)) if region[u] == "heading" and len(first[u]) <= 80}
    flags["headings"] += sorted({first[u][:60] for u in range(len(units)) if region[u] in ("text", "list_item") and first[u] in headed})
    return {name: items for name, items in flags.items() if items}


def main(argv):
    option = lambda name, default=None: argv[argv.index(name) + 1] if name in argv else default
    shown = int(option("--examples", 2))
    totals, flagged = Counter(), {}
    structure = gold_store.sources(gold_store.STRUCTURE)
    for sha, path in structure:
        flags = check(gold_store.read(path), gold_store.split_of(sha))
        for name in flags:
            totals[name] += 1
        if flags:
            flagged[sha] = flags
    print(f"{len(structure)} current golds; flagged, by check:", dict(totals))
    for sha, flags in list(flagged.items())[: shown * 10]:
        print(sha[:10], {name: items[:3] for name, items in flags.items()})
    out = option("--flagged")
    if out:
        Path(out).write_text(json.dumps({"sources": [{"sha256": sha, "flags": flags} for sha, flags in flagged.items()]}, indent=1), encoding="utf-8")
        print(f"wrote {len(flagged)} flagged sources to {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
