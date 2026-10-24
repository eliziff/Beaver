"""How consistently the gold labels numbered runs (numbering.runs). Within a document, a run labelled
both ways is an inconsistency outright. Across documents, each run is described by its pattern
(numbering family, what introduces it, whether it starts its count) and the patterns are tallied
with their labels, so a pattern labelled both ways shows where the convention is applied unevenly.

python numbered_census.py STORE GROUPS_JSON [--examples N]
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numbering


def kind(family):
    if family == "num" or family.startswith("dec") or family == "sec":
        return "number"
    return {"al": "letter", "AU": "letter", "rl": "roman", "RU": "roman", "bullet": "bullet"}.get(family, "other")


def lead(typed, groups, unit):
    before = numbering.lead(typed, groups, unit)
    if before is None:
        return "start"
    if before[0] == "heading":
        return "heading"
    return "colon" if numbering.LEAD.search(before[1]) else "text"


def main(argv):
    store, groups_of = Path(argv[0]), json.loads(Path(argv[1]).read_text(encoding="utf-8"))["sources"]
    shown = int(argv[argv.index("--examples") + 1]) if "--examples" in argv else 2
    cells, docs, examples = defaultdict(Counter), defaultdict(lambda: defaultdict(set)), defaultdict(lambda: defaultdict(list))
    split_runs = split_docs = 0
    for path in sorted((store / "v4").glob("*/gold.json.gz")):
        sha = path.parent.name
        if groups_of.get(sha, {}).get("label_source", "model") != "model":
            continue
        gold = numbering.load(path)
        typed, groups = gold["typed"], [u["lines"] for u in gold["units"]]
        split_here = 0
        for run in numbering.runs(numbering.numbered(typed, groups)):
            labels = Counter(typed[groups[u][0]]["region"] for u, *_ in run)
            split_here += len(labels) > 1
            unit, family, marker, text = run[0]
            first = numbering.count(marker, family)
            starts = "first" if first in ((1,), (ord("a"),)) or family == "bullet" else "later"
            key = (kind(family), lead(typed, groups, unit), starts)
            cells[key] += labels
            for region in labels:
                docs[key][region].add(sha)
                if len(examples[key][region]) < shown:
                    examples[key][region].append(f"{sha[:10]} {groups_of.get(sha, {}).get('genre', '?')}: {text[:90]}")
        split_runs += split_here
        split_docs += split_here > 0
    print(f"runs labelled both ways inside one document: {split_runs} in {split_docs} documents")
    print(f"{'pattern (family, lead, start)':34} {'text':>7} {'list':>7}  docs text/list")
    minority_units = 0
    for key, c in sorted(cells.items(), key=lambda kv: -sum(kv[1].values())):
        t, l = c["text"], c["list_item"]
        mixed = min(t, l) and min(t, l) / (t + l) >= 0.05
        minority_units += min(t, l) if mixed else 0
        print(f"{' '.join(key):34} {t:7} {l:7}  {len(docs[key]['text']):4}/{len(docs[key]['list_item']):<4}{'  MIXED' if mixed else ''}")
        if mixed:
            for region in ("text", "list_item"):
                for e in examples[key][region]:
                    print(f"      {region:9} {e}")
    print(f"units on the minority side of mixed patterns: {minority_units}")


if __name__ == "__main__":
    main(sys.argv[1:])
