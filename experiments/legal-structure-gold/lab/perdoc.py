"""Where the tagger's lost units sit: per document (is the loss a few long documents' conventions or
spread thin?) and, for gold text units read merged, their shape (one-line units in blocks of short
lines, or paragraphs proper).

  python perdoc.py ROWS_DIR PREDICTIONS.jsonl
"""
import collections
import json
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
R = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
     "marginal_note", "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
RI = {r: k for k, r in enumerate(R)}
BODY = {RI["text"], RI["provision"], RI["list_item"]}
CONTENTS, NOTE = RI["contents"], RI["note"]
root, pred_path = sys.argv[1], sys.argv[2]
predicted = {}
for line in open(pred_path, encoding="utf-8"):
    d = json.loads(line)
    predicted[d["sha256"]] = dict(zip(d["ids"], d["labels"]))


def units(labels):
    out, open_ = [], None
    for k, lab in enumerate(labels):
        if lab is None or lab[0] == 0:
            continue
        r, s = lab[0], lab[1]
        if s != 0 or open_ is None or open_[0] != r:
            if open_:
                out.append(tuple(open_))
            open_ = [r, k, k]
        else:
            open_[2] = k
    if open_:
        out.append(tuple(open_))
    return out


KINDS = ["heading", "body", "quote", "list_item", "table", "title"]
per_doc = []  # (sha, mode, pages, {kind: (expected, predicted, correct)})
merged_shape = collections.Counter()
merged_examples = collections.defaultdict(list)
for line in open(rf"{root}\rows-development.jsonl", encoding="utf-8"):
    doc = json.loads(line)
    sha = doc["sha256"]
    if sha not in predicted:
        continue
    own = predicted[sha]
    t0 = doc["tier0"]
    tagged = []
    for id_, lab0 in zip(doc["ids"], t0):
        lab = own.get(id_)
        tagged.append(lab0 if lab is None or lab0[0] in (CONTENTS, NOTE) or lab[0] == NOTE else lab)
    gu, pu = set(units(doc["gold"])), set(units(tagged))
    tallies = {}
    for kind in KINDS:
        if kind == "body":
            g = {(-2, a, b) for r, a, b in gu if r in BODY}
            p = {(-2, a, b) for r, a, b in pu if r in BODY}
        else:
            g = {u for u in gu if u[0] == RI[kind]}
            p = {u for u in pu if u[0] == RI[kind]}
        tallies[kind] = (len(g), len(p), len(g & p))
    per_doc.append((sha[:8], doc.get("mode", "?"), int(max(doc["pages"]) + 1) if doc["pages"] else 0, tallies))
    # Gold text units the tagger read merged into the unit before: the unit's size in pieces, and
    # whether its neighbours are one-liners too (a block of short lines) or paragraphs.
    pu_at = {}
    for u in pu:
        for k in range(u[1], u[2] + 1):
            pu_at[k] = u
    gold_sorted = sorted(u for u in gu if u[0] == RI["text"])
    for n, (r, a, b) in enumerate(gold_sorted):
        holder = pu_at.get(a)
        if holder is None or holder[0] != r or holder[1] >= a:
            continue
        size = b - a + 1
        prev_size = gold_sorted[n - 1][2] - gold_sorted[n - 1][1] + 1 if n else 0
        chars = sum(len(doc["text"][k][0]) for k in range(a, b + 1))
        shape = ("1-piece" if size == 1 else "2-3 pieces" if size <= 3 else "4+ pieces") + (" after 1-piece" if prev_size == 1 else " after longer")
        merged_shape[(doc.get("mode", "?"), shape)] += 1
        merged_shape[("all", shape)] += 1
        if chars < 40:
            merged_shape[("all", "short (<40 chars)")] += 1
        merged_examples[shape].append((sha[:8], doc["pages"][a] + 1, doc["text"][a][0][:70], doc["text"][gold_sorted[n - 1][1]][0][:50] if n else ""))

print(f"{len(per_doc)} development documents\n")
for kind in KINDS:
    rows = [(sha, mode, pages, t[kind]) for sha, mode, pages, t in per_doc if t[kind][0] + t[kind][1]]
    E = sum(t[0] for *_, t in rows); P = sum(t[1] for *_, t in rows); C = sum(t[2] for *_, t in rows)
    lost = [(t[0] - t[2] + t[1] - t[2], sha, mode, pages, t) for sha, mode, pages, t in rows]
    lost.sort(reverse=True)
    total_lost = sum(l for l, *_ in lost) or 1
    f1s = [2 * t[2] / max(t[0] + t[1], 1) for *_, t in rows if t[0] >= 5]
    print(f"== {kind}: pooled F1 {2 * C / max(E + P, 1):.3f} (E {E} P {P} C {C}); docs with >=5 gold units: {len(f1s)}, "
          f"median doc F1 {np.median(f1s):.3f}, mean {np.mean(f1s):.3f}, quartiles {np.percentile(f1s, 25):.2f}/{np.percentile(f1s, 75):.2f}")
    cum = 0
    for rank, (l, sha, mode, pages, t) in enumerate(lost[:12]):
        cum += l
        print(f"   {rank + 1:2} {sha} {mode:11} {pages:4}p  E {t[0]:5} P {t[1]:5} C {t[2]:5}  lost {l:5}  cum {cum / total_lost:.2f}")
    for n in (10, 25, 50):
        print(f"   top {n} docs hold {sum(l for l, *_ in lost[:n]) / total_lost:.2f} of the FN+FP")
    print()

print("GOLD TEXT UNITS READ MERGED, by shape (size in pieces, what precedes) and mode")
for (mode, shape), n in sorted(merged_shape.items()):
    print(f"   {mode:11} {shape:28} {n}")
import random
random.seed(1)
for shape, ex in merged_examples.items():
    print(f"\n   -- {shape} ({len(ex)})")
    for sha, page, first, prev in random.sample(ex, min(6, len(ex))):
        print(f"      {sha} p{page:<3} | {first:70} | after: {prev}")
