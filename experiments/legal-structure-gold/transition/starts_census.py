"""How the gold labels mark document starts: per document, the pieces with label[2] == 1, their place in
the document's pieces and whether the first piece is one; and over all, how many documents have any start
past the first piece. python starts_census.py GOLD_LABELS.jsonl"""
import json, sys
docs = starts_first = multi = 0
places = []
for raw in open(sys.argv[1], encoding="utf-8"):
    row = json.loads(raw)
    labels = row["labels"]
    starts = [k for k, l in enumerate(labels) if l[2] == 1]
    docs += 1
    starts_first += bool(starts and starts[0] == 0)
    if any(k > 0 for k in starts):
        multi += 1
        places.append((row["sha256"][:8], len(labels), starts[:8], len(starts)))
print(f"{docs} documents, first piece a start in {starts_first}, a start past the first piece in {multi}")
for p in places[:5]:
    print(p)
# Each start's place on its page: how many of the document's pieces on the same page come before it.
import collections
rank = collections.Counter()
for raw in open(sys.argv[1], encoding="utf-8"):
    row = json.loads(raw)
    seen = collections.Counter()
    for piece, label in zip(row["ids"], row["labels"]):
        page = piece.split("-")[0].removeprefix("parser:")
        if label[2] == 1:
            rank[min(seen[page], 10)] += 1
        seen[page] += 1
total = sum(rank.values())
print("starts by place on page (10 = 10 or more):", sorted(rank.items()), "of", total)
print("within the first 3:", sum(v for k, v in rank.items() if k < 3) / max(total, 1))
