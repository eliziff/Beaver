"""Where a parse's reading order leaves the gold's: for a document, its lines in the parse's order (the dump's
pages, each page's lines by reading_order) against the gold's (gold.json's lines in order), page by page:
the share of each page's lines out of the gold's order (longest common subsequence), and for the worst pages
the lines in both orders with their boxes. python order_diff.py DUMP_DIR STORE SHA_PREFIX [PAGES]"""
import glob, gzip, json, os, sys
dump, store, prefix = sys.argv[1:4]
show = int(sys.argv[4]) if len(sys.argv) > 4 else 3
sha = next(n for n in os.listdir(store) if n.startswith(prefix))
gold = json.load(gzip.open(sorted(glob.glob(os.path.join(store, sha, "structure", "*", "gold.json.gz")))[-1], "rt", encoding="utf-8"))
pages = json.load(gzip.open(os.path.join(dump, f"{sha}.pages.json.gz"), "rt", encoding="utf-8"))
pages = pages.get("pages", pages) if isinstance(pages, dict) else pages
parsed = {}
boxes = {}
for page in pages:
    for line in sorted(page["lines"], key=lambda l: l.get("reading_order", 0)):
        parsed.setdefault(page["index"], []).append(line["id"])
        boxes[line["id"]] = (page["index"], [round(v) for v in line["bbox"]], line["text"][:60])
gold_by_page = {}
for line in gold["lines"]:
    if line["id"] in boxes:
        gold_by_page.setdefault(boxes[line["id"]][0], []).append(line["id"])


def lcs(a, b):
    """Length of the longest common subsequence of two id lists."""
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1]


rows = []
for p, ids in gold_by_page.items():
    mine = [i for i in parsed.get(p, []) if i in set(ids)]
    out = len(ids) - lcs(ids, mine)
    rows.append((out, p, len(ids)))
rows.sort(reverse=True)
total = sum(r[2] for r in rows)
print(f"{sha[:8]}: {len(rows)} pages, {total} lines, out of order {sum(r[0] for r in rows)}")
print("worst pages:", [(p, out, n) for out, p, n in rows[:10]])
for out, p, n in rows[:show]:
    if not out:
        break
    print(f"\n== page {p}: {out} of {n} out of order")
    gold_ids, mine = gold_by_page[p], [i for i in parsed[p] if i in set(gold_by_page[p])]
    for k in range(min(len(gold_ids), 40)):
        g, m = gold_ids[k], mine[k] if k < len(mine) else None
        gb, mb = boxes[g], boxes.get(m)
        mark = "  " if g == m else "<>"
        print(f"{mark} gold {gb[1]} {gb[2]!r:62} | parse {mb[1] if mb else ''} {mb[2] if mb else ''!r}")
