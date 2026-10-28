"""Failure census over the rows: every gold unit (a region's run of pieces from a start) against the
parser's reading of the same pieces, classed as exact, split, merged, split+merged, or read as another
region; and the parser's own units no gold unit matches (false positives), by gold region and mode.

  python census.py ROWS_DIR [split] [samples_per_class]
"""
import collections
import json
import random
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
R = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
     "marginal_note", "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
root = sys.argv[1]
split = sys.argv[2] if len(sys.argv) > 2 else "development"
samples = int(sys.argv[3]) if len(sys.argv) > 3 else 8


def units(labels):
    """(region, first, last) runs: a start opens one, an inside piece of the open unit's region extends it."""
    out, open_ = [], None
    for k, lab in enumerate(labels):
        if lab is None:
            continue
        r, s = lab[0], lab[1]
        if r == 0:
            continue
        if s != 0 or open_ is None or open_[0] != r:
            if open_:
                out.append(tuple(open_))
            open_ = [r, k, k]
        else:
            open_[2] = k
    if open_:
        out.append(tuple(open_))
    return out


def classify(unit, other_labels, other_units_at):
    r, a, b = unit
    regions = collections.Counter(other_labels[k][0] for k in range(a, b + 1) if other_labels[k] is not None)
    if not regions:
        return "unlabelled", None
    major, _ = regions.most_common(1)[0]
    if major != r:
        return "region", R[major]
    holder = other_units_at.get(a)
    if holder and holder[0] == r and holder[1] == a and holder[2] == b:
        return "exact", None
    inner = sum(1 for k in range(a + 1, b + 1) if other_labels[k] is not None and other_labels[k][0] == r and other_labels[k][1] != 0)
    late = other_labels[a] is not None and other_labels[a][1] == 0 and (holder is None or holder[1] < a)
    over = holder is not None and holder[0] == r and holder[2] > b
    split, merged = inner > 0, late or over
    if split and merged:
        return "split+merged", None
    if split:
        return "split", None
    if merged:
        return "merged", None
    return "shifted", None


counts = collections.defaultdict(collections.Counter)      # (region, mode) -> class -> n
fp = collections.defaultdict(collections.Counter)          # (region, mode) -> gold region -> n
examples = collections.defaultdict(list)
docs = 0
keys_shown = False
for line in open(rf"{root}\rows-{split}.jsonl", encoding="utf-8"):
    doc = json.loads(line)
    if not keys_shown:
        print("row keys:", sorted(doc.keys()))
        keys_shown = True
    docs += 1
    mode = doc.get("mode", "?")
    text, t0, gold, pages = doc["text"], doc["tier0"], doc["gold"], doc["pages"]
    gu, pu = units(gold), units(t0)
    pu_at = {}
    for u in pu:
        for k in range(u[1], u[2] + 1):
            pu_at[k] = u
    gu_at = {}
    for u in gu:
        for k in range(u[1], u[2] + 1):
            gu_at[k] = u
    for u in gu:
        cls, detail = classify(u, t0, pu_at)
        key = cls if detail is None else f"{cls}:{detail}"
        counts[(R[u[0]], mode)][key] += 1
        counts[(R[u[0]], "all")][key] += 1
        if cls != "exact":
            examples[(R[u[0]], mode, key)].append((doc["sha256"][:8], pages[u[1]] + 1, u[2] - u[1] + 1, text[u[1]][0][:90], text[u[1]][4]))
    for u in pu:
        cls, detail = classify(u, gold, gu_at)
        if cls != "exact":
            fp[(R[u[0]], mode)][cls if detail is None else f"{cls}:{detail}"] += 1
            fp[(R[u[0]], "all")][cls if detail is None else f"{cls}:{detail}"] += 1

print(f"{docs} documents, split {split}\n")
print("GOLD UNITS by region and mode: n, exact share, then how the rest are lost")
for (region, mode), c in sorted(counts.items(), key=lambda kv: (-sum(kv[1].values()) if kv[0][1] == "all" else 0, kv[0])):
    n = sum(c.values())
    if n < 40:
        continue
    rest = ", ".join(f"{k} {v / n:.2f}" for k, v in c.most_common(7) if k != "exact")
    print(f"  {region:13} {mode:12} {n:7}  exact {c['exact'] / n:.2f}  | {rest}")
print("\nPARSER UNITS no gold unit matches exactly (false positives / misreadings), by parser region and mode")
for (region, mode), c in sorted(fp.items(), key=lambda kv: -sum(kv[1].values())):
    n = sum(c.values())
    if n < 40:
        continue
    print(f"  {region:13} {mode:12} {n:7}  " + ", ".join(f"{k} {v}" for k, v in c.most_common(6)))
random.seed(3)
print("\nSAMPLES (sha page pieces | first piece text | trail)")
for region in ("heading", "text", "quote", "list_item"):
    for mode in ("digitalborn", "ocr"):
        keys = [k for k in examples if k[0] == region and k[1] == mode]
        keys.sort(key=lambda k: -len(examples[k]))
        for key in keys[:3]:
            print(f"\n== gold {region} / {mode} / {key[2]}  ({len(examples[key])})")
            for sha, page, size, first, trail in random.sample(examples[key], min(samples, len(examples[key]))):
                print(f"   {sha} p{page:<3} {size:3} | {first:90} | {trail}")
