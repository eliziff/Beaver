"""The gold's hierarchy as a deterministic function of regions, heading levels, numbering families
and document boundaries (CONVENTIONS.md sections 2 and 3). Used by the runner for new gold and, as
the post-correction `hierarchy_from_headings`, over existing gold.

  python conventions.py GOLD_DIR [--sha PREFIX] [--dry-run] [--report]

For an existing gold the heading levels are read from its own heading ancestry (one plus the number
of heading ancestors), then every unit's parent is rebuilt by the rules. The correction is recorded
under `postcorrections` with the parents it replaced, and the receipt's gold digest is refreshed.
"""
import argparse
import gzip
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

RANKED = {"text", "list_item", "heading", "quote", "table", "caption", "headnote"}
HEADING_FOLLOWERS = {"text", "table", "caption", "headnote"}

WORD_OUTER = re.compile(r"^(PART|PARTIE|BOOK|LIVRE|TITLE|TITRE|VOLUME)\b", re.I)
WORD_INNER = re.compile(r"^(ARTICLE|CHAPTER|CHAPITRE|DIVISION|SECTION|SCHEDULE|ANNEX|ANNEXE|APPENDIX|TAB|RULE|R[ÈE]GLE|CLAUSE|FORM|FORMULE)\b", re.I)
SEC = re.compile(r"^(\d+(?:\.\d+)?)\s*\(\d+\)")
DOTTED = re.compile(r"^(\d+(?:\.\d+)+)\.?(?=\s|$)")
NUM = re.compile(r"^(?:\(|\[)?(\d+)(?:[.)\]:]|(?=\s))(?=\s|$)")
ROMAN = re.compile(r"^\(?([IVXLCivxlc]{1,6})[.)\]:](?=\s|$)")
ALPHA = re.compile(r"^\(?([A-Za-z]{1,2})[.)\]](?=\s|$)")
BULLET = re.compile(r"^[•·▪–—\-*●○■□►]\s")
ROMANS = {"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii",
          "xviii", "xix", "xx", "xxi", "xxii", "xxiii", "xxiv", "xxv", "xxx", "xl", "l"}


def family(text, open_letter=None):
    """The numbering family a unit opens with ('' for none). `open_letter` is the last lower-case
    letter of an open letter list, so 'i' after 'h' reads as a letter, not a numeral."""
    t = text.lstrip()
    if WORD_OUTER.match(t):
        return "word_outer"
    if WORD_INNER.match(t):
        return "word_inner"
    if SEC.match(t):
        return "sec"
    m = DOTTED.match(t)
    if m:
        return f"dec{min(m.group(1).count('.') + 1, 4)}"
    if NUM.match(t):
        return "num"
    m = ROMAN.match(t)
    if m:
        token = m.group(1)
        lower = token.islower()
        if len(token) == 1 and token.lower() in "ivxlc":
            if open_letter == chr(ord(token.lower()) - 1):
                return "al" if lower else "AU"
            return "rl" if lower else "RU"
        if token.lower() in ROMANS:
            return "rl" if lower else "RU"
    m = ALPHA.match(t)
    if m:
        token = m.group(1)
        if len(token) == 2 and token[0] != token[1]:
            return ""
        return "al" if token.islower() else "AU"
    if BULLET.match(t):
        return "bullet"
    return ""


def assemble(regions, texts, levels, starts_document):
    """Parents for units in reading order. regions[u], texts[u] (first line), levels[u] (heading
    level or None), starts_document[u]. Returns [parent unit index or None]."""
    parents = [None] * len(regions)
    heading_stack = []  # (level, unit)
    list_stack = []  # (family, unit, parent)
    prev = None
    open_letter = None
    for u, region in enumerate(regions):
        if region not in RANKED:
            continue
        if starts_document[u]:
            heading_stack, list_stack, prev, open_letter = [], [], None, None
        if region == "heading":
            level = levels[u] if levels[u] is not None else 1
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            parent = heading_stack[-1][1] if heading_stack else None
            heading_stack.append((level, u))
            list_stack, open_letter = [], None
        elif region in HEADING_FOLLOWERS:
            parent = heading_stack[-1][1] if heading_stack else None
            if region == "text":
                list_stack, open_letter = [], None
        elif region == "list_item":
            fam = family(texts[u], open_letter)
            found = next((k for k in range(len(list_stack) - 1, -1, -1) if fam and list_stack[k][0] == fam), None)
            if found is not None:
                parent = list_stack[found][2]
                del list_stack[found + 1:]
                list_stack[found] = (fam, u, parent)
            elif not fam and list_stack:
                parent = list_stack[-1][2]
                list_stack[-1] = (list_stack[-1][0], u, parent)
            else:
                parent = prev if prev is not None else (heading_stack[-1][1] if heading_stack else None)
                list_stack.append((fam, u, parent))
            if fam == "al":
                m = ALPHA.match(texts[u].lstrip())
                open_letter = m.group(1).lower() if m else None
        else:  # quote
            parent = parents[prev] if prev is not None and regions[prev] == "quote" else prev
        parents[u] = parent
        prev = u
    return parents


def heading_levels_from_ancestry(units, regions):
    """For existing gold: a heading's level is one plus its number of heading ancestors."""
    levels = [None] * len(units)
    depth = {}
    for u, unit in enumerate(units):
        if regions[u] != "heading":
            continue
        count, at, seen = 0, unit.get("parent"), set()
        while at is not None and at not in seen and at < len(units):
            seen.add(at)
            if regions[at] == "heading":
                count += 1
            at = units[at].get("parent")
        levels[u] = count + 1
        depth[u] = levels[u]
    return levels


def unit_fields(gold):
    typed = gold["typed"]
    regions, texts = [], []
    for unit in gold["units"]:
        first = typed[unit["lines"][0]]
        regions.append(first["region"])
        texts.append(" ".join(first.get("text", "").split()))
    return regions, texts


def hierarchy_from_headings(gold):
    """Rebuild every unit's parent from heading levels; returns the correction record or None."""
    regions, texts = unit_fields(gold)
    units = gold["units"]
    levels = heading_levels_from_ancestry(units, regions)
    starts = [bool(u.get("starts_document")) for u in units]
    parents = assemble(regions, texts, levels, starts)
    changes = []
    for u, unit in enumerate(units):
        if regions[u] in RANKED and unit.get("parent") != parents[u]:
            changes.append([u, unit.get("parent"), parents[u]])
            unit["parent"] = parents[u]
        if regions[u] == "heading":
            unit["level"] = levels[u]
    if not changes:
        return None
    return {"name": "hierarchy_from_headings", "module_sha256": MODULE_SHA, "changes": changes,
            "changed": len(changes), "units": len(units)}


MODULE_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def write_gzip_json(path, value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as stream:
        stream.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("gold", type=Path)
    parser.add_argument("--sha", help="only sources whose sha256 starts with this")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--report", action="store_true", help="print the census of changed parents by unit region")
    args = parser.parse_args()
    changed_docs = total_docs = 0
    census = Counter()
    for job in sorted(args.gold.joinpath("v4").iterdir()):
        if args.sha and not job.name.startswith(args.sha):
            continue
        path = job / "gold.json.gz"
        if not path.is_file():
            continue
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            gold = json.load(stream)
        if any(c.get("name") == "hierarchy_from_headings" for c in gold.get("postcorrections", [])):
            continue
        total_docs += 1
        regions, _ = unit_fields(gold)
        record = hierarchy_from_headings(gold)
        if record is None:
            gold.setdefault("postcorrections", []).append({"name": "hierarchy_from_headings", "module_sha256": MODULE_SHA,
                                                           "changes": [], "changed": 0, "units": len(gold["units"])})
        else:
            changed_docs += 1
            for u, _, _ in record["changes"]:
                census[regions[u]] += 1
            gold.setdefault("postcorrections", []).append(record)
        if args.dry_run:
            continue
        write_gzip_json(path, gold)
        receipt_path = job / "receipt.json"
        if receipt_path.is_file():
            receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
            receipt.update(gold_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                           postcorrections=len(gold["postcorrections"]))
            receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{total_docs} golds read, {changed_docs} with parent changes{' (dry run)' if args.dry_run else ''}")
    if args.report or args.dry_run:
        print("changed parents by unit region:", dict(census.most_common()))


if __name__ == "__main__":
    main()
