"""The gold's states inside a line: pieces past a line's first, which the parser's moves (one a line) do not make. How many
open a unit or change region, by the regions at the line's start and at the piece, and a sample of each.
python doc_pieces.py GOLD_JSONL"""
import collections, json, sys

REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote", "marginal_note",
           "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
name = lambda r: REGIONS[1 if r == 101 else max(r, 0)]
tally, sample = collections.Counter(), {}
total = 0
for raw in open(sys.argv[1], encoding="utf-8"):
    doc = json.loads(raw)
    rows = dict(zip(doc["ids"], doc["labels"]))
    for piece, label in rows.items():
        line, offset = piece.rsplit("@", 1)
        if offset == "0":
            continue
        total += 1
        first = rows.get(line + "@0")
        before = name(first[0]) if first else "?"
        key = (before, name(label[0]), "opens" if label[1] == 1 else "resumes" if label[1] == 2 else "goes on", "marked" if label[5] == 1 else "")
        tally[key] += 1
        sample.setdefault(key, (doc["sha256"][:12], piece))
print(total, "pieces past a line's first")
for key, count in tally.most_common(30):
    print(count, key, sample[key])
