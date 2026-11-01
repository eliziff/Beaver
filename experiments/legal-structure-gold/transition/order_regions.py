"""Which gold regions a parse's out-of-order lines sit in: for each document in a dump, per page, the lines the parse
reads out of the gold's order (those outside a longest common subsequence of the two orders), counted by the gold's
typed region; and the same count again with the order compared only within each region family (body, note, table,
furniture), the order a consumer reads. python order_regions.py DUMP_DIR STORE"""
import collections, glob, gzip, json, os, sys
dump, store = sys.argv[1:3]
FAMILY = {"note": "note", "footnote": "note", "table": "table", "header": "furniture", "footer": "furniture",
          "page_number": "furniture", "running_header": "furniture"}


def lcs_keep(a, b):
    """The ids of a kept by a longest common subsequence of a and b."""
    n, m = len(a), len(b)
    t = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            t[i][j] = t[i + 1][j + 1] + 1 if a[i] == b[j] else max(t[i + 1][j], t[i][j + 1])
    keep, i, j = set(), 0, 0
    while i < n and j < m:
        if a[i] == b[j]:
            keep.add(a[i]); i += 1; j += 1
        elif t[i + 1][j] >= t[i][j + 1]:
            i += 1
        else:
            j += 1
    return keep


for path in sorted(glob.glob(os.path.join(dump, "*.pages.json.gz"))):
    sha = os.path.basename(path).split(".")[0]
    gold = json.load(gzip.open(sorted(glob.glob(os.path.join(store, sha, "structure", "*", "gold.json.gz")))[-1], "rt", encoding="utf-8"))
    region = {}
    for t in gold["typed"]:
        for s in t["spans"]:
            region.setdefault(s["line_id"], t["region"])
    pages = json.load(gzip.open(path, "rt", encoding="utf-8"))
    pages = pages.get("pages", pages) if isinstance(pages, dict) else pages
    parsed, page_of = {}, {}
    for page in pages:
        for line in sorted(page["lines"], key=lambda l: l.get("reading_order", 0)):
            parsed.setdefault(page["index"], []).append(line["id"])
            page_of[line["id"]] = page["index"]
    gold_by_page = collections.defaultdict(list)
    for line in gold["lines"]:
        if line["id"] in page_of:
            gold_by_page[page_of[line["id"]]].append(line["id"])
    whole, within, total = collections.Counter(), collections.Counter(), collections.Counter()
    for p, ids in gold_by_page.items():
        mine = [i for i in parsed[p] if i in set(ids)]
        kept = lcs_keep(ids, mine)
        for i in ids:
            total[region.get(i, "?")] += 1
            if i not in kept:
                whole[region.get(i, "?")] += 1
        for fam in {FAMILY.get(region.get(i, "?"), "body") for i in ids}:
            g = [i for i in ids if FAMILY.get(region.get(i, "?"), "body") == fam]
            m = [i for i in mine if FAMILY.get(region.get(i, "?"), "body") == fam]
            k = lcs_keep(g, m)
            for i in g:
                if i not in k:
                    within[region.get(i, "?")] += 1
    print(sha[:8], "lines", sum(total.values()), "out of order", sum(whole.values()), "within family", sum(within.values()))
    print("   by region:", {r: (whole[r], within[r], total[r]) for r in sorted(total, key=lambda r: -whole[r])})
