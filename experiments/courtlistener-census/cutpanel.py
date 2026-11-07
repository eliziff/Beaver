"""A small panel, so that a grade takes seconds: the packed opinions of the given cases and the pins, clusters and citations that go with them.

    python -I cutpanel.py CLUSTERS OUT_PREFIX PACK[,PACK] PINS CLUSTER_SHEET CITATION_SHEET

Writes OUT_PREFIX-pack.jsonl, -pins.jsonl, -clusters.jsonl, -citations.jsonl. Run from C:/courtlistener-structure.
"""
import json, re, sys

listing, prefix, packs, pins, clusters, citations = sys.argv[1:7]
wanted = {line.strip() for line in open(listing, encoding="utf-8") if line.strip()}
mark = re.compile(r'cluster_id\\": \\"(\d+)')
kept = 0
with open(prefix + "-pack.jsonl", "w", encoding="utf-8", newline="\n") as out:
    for pack in packs.split(","):
        for line in open(pack, encoding="utf-8"):
            found = mark.search(line, max(0, line.rfind('"fields.json"')))
            if found and found.group(1) in wanted:
                out.write(line)
                kept += 1
pinned = 0
with open(prefix + "-pins.jsonl", "w", encoding="utf-8", newline="\n") as out:
    for line in open(pins, encoding="utf-8"):
        found = re.search(r'"cluster":\s*"(\d+)"', line)
        if found and found.group(1) in wanted:
            out.write(line)
            pinned += 1
for name, sheet in (("clusters", clusters), ("citations", citations)):
    with open(f"{prefix}-{name}.jsonl", "w", encoding="utf-8", newline="\n") as out:
        for line in open(sheet, encoding="utf-8"):
            found = re.match(r'\{"id":\s*"?(\d+)', line)
            if found and found.group(1) in wanted:
                out.write(line)
print("opinions", kept, "pins", pinned)
