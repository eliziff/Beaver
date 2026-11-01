"""How recognition misreads a line's opening marker, counted over the gold store's corrected lines (a gold line's
`text` as recognized beside its `corrected`): for each opening token the correction changes, where the corrected
token reads as a marker (figures, a roman numeral, a letter, in brackets or parentheses or before a point) and the
two are of one length, each character the recognition read in place of another. Written as {read: {meant: p}},
p the share of the read character's occurrences in such tokens that meant the other, for the parser's
LEGALPDF_TRANSITION_CONFUSIONS; train documents only. python ocr_confusions.py STORE OUT.json"""
import collections, glob, gzip, json, os, re, sys
store, out = sys.argv[1:3]
MARKER = re.compile(r"^[\[(]?(\d{1,4}|[ivxlcdmIVXLCDM]{1,6}|[A-Za-z])[\])\.:]?$")
pairs = seen = 0
swaps = collections.defaultdict(collections.Counter)
kept = collections.Counter()
for sha in os.listdir(store):
    try:
        if json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8")).get("partition") != "train":
            continue
        path = sorted(glob.glob(os.path.join(store, sha, "structure", "*", "gold.json.gz")))[-1]
        gold = json.load(gzip.open(path, "rt", encoding="utf-8"))
    except (OSError, ValueError, IndexError):
        continue
    for line in gold.get("lines", []):
        raw, fixed = line.get("text", "").split(), line.get("corrected", line.get("text", "")).split()
        if not raw or not fixed:
            continue
        a, b = raw[0], fixed[0]
        if not MARKER.match(b):
            continue
        seen += 1
        for c in a:
            kept[c] += 1
        if a == b or len(a) != len(b):
            continue
        pairs += 1
        for x, y in zip(a, b):
            if x != y:
                swaps[x][y] += 1
table = {x: {y: round(n / kept[x], 4) for y, n in ys.items() if n >= 3 and n / kept[x] >= 0.01} for x, ys in swaps.items()}
table = {x: ys for x, ys in table.items() if ys}
json.dump(table, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{seen} marker openings, {pairs} misread at one length; {len(table)} characters misread:")
for x, ys in sorted(table.items(), key=lambda kv: -sum(swaps[kv[0]].values()))[:25]:
    print(repr(x), ys)
