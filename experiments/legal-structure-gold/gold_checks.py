"""The gold's consistency checks. They report; none rewrites a gold.

Within each model-authored gold:
  recurring   a line printed at the same place on three or more pages typed as different regions
  headings    the same short text typed as a heading in one place and as another body region elsewhere

  python gold_checks.py STORE GROUPS_JSON [--manifest MANIFEST] [--flagged OUT.json] [--examples N]

--flagged writes the flagged documents as a manifest (rows of MANIFEST) for the passes to read again.
"""
import gzip
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path



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


def check(gold):
    """{check: [what]} for one gold."""
    typed, units = gold["typed"], gold["units"]
    groups = [u["lines"] for u in units]
    region = [typed[g[0]]["region"] for g in groups]
    first = [flat(typed[g[0]]["text"]) for g in groups]
    flags = defaultdict(list)
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
    totals, flagged = Counter(), {}
    for path in sorted((store / "v4").glob("*/gold.json.gz")):
        sha = path.parent.name
        if groups_of.get(sha, {}).get("label_source", "model") != "model":
            continue
        flags = check(json.loads(gzip.decompress(path.read_bytes())))
        for name in flags:
            totals[name] += 1
        if flags:
            flagged[sha] = flags
    print("documents flagged, by check:", dict(totals))
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
