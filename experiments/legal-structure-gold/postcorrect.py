"""Deterministic corrections the gold runner applies after the model's passes, each a rule the gold's
own conventions imply, recorded in the gold file under `postcorrections`.

Running heads: a page's running head is furniture, never a heading. A one-line heading unit at the
top or bottom edge of its page is a running head when the same words (a folio number before or
after them set aside) already stood at the edge of an earlier page and the gold calls most of their
other appearances furniture, and stands where they stand, as tall. A head that repeats unchanged
from the page that opens its part stays a heading there when it holds the part's units (the part's
title, as a schedule's or a resolution's), unless a copy already stood on an earlier page. The unit
becomes furniture; its children move to its parent; the correction keeps both, to be undone.

  python postcorrect.py GOLD_DIR [--sha PREFIX] [--dry-run]   correct existing golds from their inputs
"""
import argparse
import collections
import gzip
import hashlib
import json
import os
import re
from pathlib import Path

EDGE = 2  # a line among the first or last three of its page by height is at the edge


def words(text):
    found = re.sub(r"[^\w ]", " ", text.lower()).split()
    while found and found[0].isdigit():
        found.pop(0)
    while found and found[-1].isdigit():
        found.pop()
    return " ".join(found)


def edges(pages):
    """Each line's distance from its page's nearer edge (in lines ordered by height), its middle's
    height on the page (as a share of the page) and its own height."""
    out = {}
    for page in pages:
        ordered = sorted(page["lines"], key=lambda line: line["bbox"][1])
        tall = page.get("height") or max((line["bbox"][3] for line in ordered), default=1.0) or 1.0
        for rank, line in enumerate(ordered):
            x0, y0, x1, y1 = line["bbox"]
            out[line["id"]] = (min(rank, len(ordered) - 1 - rank), (y0 + y1) / 2 / tall, (y1 - y0) / tall)
    return out


def median(values):
    values = sorted(values)
    return values[len(values) // 2]


def running_heads(gold, edge):
    lines = gold["lines"]
    index = {line["id"]: k for k, line in enumerate(lines)}
    text = lambda k: lines[k].get("corrected") or lines[k]["text"]
    typed = gold["typed"]
    of_typed = [[index[s["line_id"]] for s in t["spans"] if s["line_id"] in index] for t in typed]
    region_of = {k: t["region"] for t, ks in zip(typed, of_typed) for k in ks}
    near = lambda k: edge.get(lines[k]["id"], (EDGE + 1, 0.0, 0.0))
    furniture = collections.defaultdict(list)
    for k, line in enumerate(lines):
        key = words(text(k))
        if len(key) >= 3 and near(k)[0] <= EDGE and region_of.get(k) == "furniture":
            furniture[key].append((line["page"], near(k)))
    corrections = []
    for u, unit in enumerate(gold["units"]):
        if {typed[t]["region"] for t in unit["lines"]} != {"heading"}:
            continue
        ks = sorted({k for t in unit["lines"] for k in of_typed[t]})
        if len(ks) != 1 or near(ks[0])[0] > EDGE:
            continue
        key = words(text(ks[0]))
        page = lines[ks[0]]["page"]
        copies = [place for p, place in furniture.get(key, []) if p != page]
        if len(key) < 3 or len(copies) < 2:
            continue
        # The furniture's own place and size: a running head stands where they stand, as tall.
        _, middle, tall = near(ks[0])
        at, size = median([c[1] for c in copies]), median([c[2] for c in copies])
        if abs(middle - at) > 0.015 or abs(tall - size) > 0.15 * max(size, 1e-6):
            continue
        # On the page that opens its part, the head that holds the part is the part's title.
        children = [v for v, other in enumerate(gold["units"]) if other.get("parent") == u]
        earlier = any(p < page for p, _ in furniture.get(key, []))
        if children and not earlier:
            continue
        corrections.append({"rule": "running_head", "unit": u, "page": page, "text": text(ks[0])[:120],
                            "parent": gold["units"][u].get("parent"), "children": children})
    for c in corrections:
        unit = gold["units"][c["unit"]]
        for t in unit["lines"]:
            typed[t]["region"] = "furniture"
        for v in c["children"]:
            gold["units"][v]["parent"] = c["parent"]
        unit["parent"] = None
    return corrections


RULES = (running_heads,)


def write(path, value):
    """As the runner writes its artifacts: sorted compact JSON, gzip without a timestamp, atomically."""
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(gzip.compress(data, mtime=0) if path.suffix == ".gz" else data)
    os.replace(temporary, path)


def apply(gold, pages):
    """Every rule over one gold, given its extraction's pages; the corrections, also kept in the gold."""
    edge = edges(pages)
    done = [c for rule in RULES for c in rule(gold, edge)]
    gold.setdefault("postcorrections", []).extend(done)
    return done


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("gold", type=Path)
    parser.add_argument("--sha", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    total = collections.Counter()
    for job in sorted((args.gold / "v4").iterdir()):
        path = job / "gold.json.gz"
        if not job.name.startswith(args.sha) or not path.is_file():
            continue
        gold = json.load(gzip.open(path))
        pages = json.load(gzip.open(args.gold / "inputs" / f"{job.name}.json.gz"))["pages"]
        done = apply(gold, pages)
        for c in done:
            total[c["rule"]] += 1
            print(job.name[:12], c["rule"], f"p{c['page']}", repr(c["text"][:70]))
        if done and not args.dry_run:
            write(path, gold)
            receipt = json.loads((job / "receipt.json").read_text(encoding="utf-8-sig"))
            receipt.update(gold_sha256=hashlib.sha256(path.read_bytes()).hexdigest(), postcorrections=len(gold["postcorrections"]))
            write(job / "receipt.json", receipt)
    print(dict(total), "(dry run)" if args.dry_run else "")


if __name__ == "__main__":
    main()
