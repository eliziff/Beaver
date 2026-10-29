"""The gold's consistency checks. They report; none rewrites a gold. Run over the whole store at
every integration: the batches a gold was authored in are provenance, not conventions.

The store's conventions:
  unsplit     the gold was authored without a split annotation (the document pass decided where its
              documents start): only the splitter decides that; author it again with --splits
  unsplit_same  as unsplit, but its documents start on the pages the splitter's annotation names
  starts      the starts the gold was cut at differ from the splitter's current annotation (--splits):
              author it again with --splits --again
  types       a document's type is missing or outside the document pass's types
Within each model-authored gold:
  recurring   a line printed at the same place on three or more pages typed as different regions
  headings    the same short text typed as a heading in one place and as another body region elsewhere

  python gold_checks.py STORE GROUPS_JSON [--splits SPLITS.json[,MORE.json]] [--manifest MANIFEST] [--flagged OUT.json] [--examples N]

STORE is one run folder (holding v4/) or a folder of batches (b5/a/v4, ...). --flagged writes the
flagged documents as a manifest (rows of MANIFEST) for the passes to read again.
"""
import gzip
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from prompts import DOCUMENT_TYPES


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


def starts_of(starts):
    """A split annotation's starts as comparable (page, line id or None) pairs."""
    return {(s["page"], s.get("line_id")) if isinstance(s, dict) else (s, None) for s in starts or ()}


def check(gold, split=None):
    """{check: [what]} for one gold; split: the splitter's current starts for its file, or None."""
    typed, units = gold["typed"], gold["units"]
    groups = [u["lines"] for u in units]
    region = [typed[g[0]]["region"] for g in groups]
    first = [flat(typed[g[0]]["text"]) for g in groups]
    flags = defaultdict(list)
    # Where its documents start: the splitter's, as the gold was cut, and still the splitter's.
    cut = gold.get("authoring", {}).get("document_starts")
    if cut is None:
        # The pages its documents start on, against the splitter's: the same pages need only the
        # annotation recorded; others need the file authored again.
        page_of = {line["id"]: line["page"] for line in gold["lines"]}
        own = {page_of.get(next((s["line_id"] for t in u["lines"] for s in typed[t]["spans"]), None)) for u in units[1:] if u.get("starts_document")}
        same = split is not None and own == {s["page"] if isinstance(s, dict) else s for s in split}
        flags["unsplit_same" if same else "unsplit"].append(f"document pass started pages {sorted(own, key=str)[:6]}"
                                                            + ("" if split is None else f", splitter {sorted(starts_of(split), key=str)[:6]}"))
    elif split is not None and starts_of(cut) != starts_of(split):
        flags["starts"].append(f"cut at {sorted(starts_of(cut), key=str)[:6]}, splitter now {sorted(starts_of(split), key=str)[:6]}")
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
    store, groups_of = Path(argv[0]), json.loads(Path(argv[1]).read_text(encoding="utf-8"))["sources"]
    option = lambda name, default=None: argv[argv.index(name) + 1] if name in argv else default
    shown = int(option("--examples", 2))
    splits = {}
    for name in (option("--splits") or "").split(","):
        for part in json.loads(Path(name).read_text(encoding="utf-8"))["sources"] if name else ():
            if "document_starts" in part:
                splits.setdefault(part["sha256"], []).extend(part["document_starts"])
    totals, flagged, golds, by_folder = Counter(), {}, Counter(), defaultdict(Counter)
    for path in sorted((store / "v4").glob("*/gold.json.gz")) or sorted(store.glob("*/*/v4/*/gold.json.gz")):
        sha = path.parent.name
        if groups_of.get(sha, {}).get("label_source", "model") != "model":
            continue
        flags = check(json.loads(gzip.decompress(path.read_bytes())), splits.get(sha) if option("--splits") else None)
        folder = path.parent.parent.parent.relative_to(store).as_posix() or "."
        for name in flags:
            totals[name] += 1
            by_folder[folder][name] += 1
        golds[folder] += 1
        if flags:
            flagged[sha] = flags
    print("documents flagged, by check:", dict(totals))
    for folder in sorted(golds):
        print(f"  {folder}: {golds[folder]} golds;", dict(by_folder[folder]))
    for sha, flags in list(flagged.items())[: shown * 10]:
        print(sha[:10], {name: items[:3] for name, items in flags.items()})
    out = option("--flagged")
    if out:
        manifest = option("--manifest")
        rows = {r["sha256"]: r for r in json.loads(Path(manifest).read_text(encoding="utf-8"))["documents"]} if manifest else {}
        documents = [{**rows.get(sha, {"sha256": sha}), "flags": sorted(flags)} for sha, flags in flagged.items()]
        Path(out).write_text(json.dumps({"documents": documents}, indent=1), encoding="utf-8")
        print(f"wrote {len(documents)} flagged documents to {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
