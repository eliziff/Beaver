"""Numbered paragraphs and list items in the gold, decided once per document.

The lines pass labels three pages per call, so one running sequence of numbered paragraphs could
come back as text on some pages and list_item on others. The convention (prompts.LINES): a
paragraph numbered in the document's own running sequence is text, however its number is written;
a list_item is one item of a list inside or after a paragraph.

`list` writes each gold's numbered body units as runs (consecutive numbered units of one numbering
family and one label, unnumbered units between them not breaking the run) into batch files for
review, with each run's member units in a sidecar. `apply` reads the reviewed decisions
({sha256: [{"run": "R3", "region": "text"}, ...]}, runs to relabel only), relabels the units,
recomputes parents with hierarchy.assemble and writes a ledger.

python numbered_units.py list STORE GROUPS_JSON OUT_DIR [--batch-chars N]
python numbered_units.py apply STORE OUT_DIR LEDGER
"""
import gzip
import json
import sys
import time
from pathlib import Path

import hierarchy

BODY = ("text", "list_item")


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def flat(text):
    return " ".join(text.split())


def numbered(gold):
    """[(unit, region, family, marker, first-line text)] for body units that open with a marker."""
    typed, found, open_letter = gold["typed"], [], None
    for u, unit in enumerate(gold["units"]):
        first = typed[unit["lines"][0]]
        if first["region"] not in BODY or not first.get("markers"):
            continue
        text = first["text"]
        marker = text.split("\t", 1)[0].strip() if "\t" in text else flat(text)[:8]
        family = hierarchy.numbering(text, open_letter) or "other"
        if family == "al":
            open_letter = marker.strip("().[]").lower()[-1:] or None
        found.append((u, first["region"], family, marker, flat(text.replace("\t", " "))))
    return found


ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100}


def count(marker, family):
    """The marker's place in its count (a tuple for decimal numbering), or None when uncounted."""
    token = marker.strip("()[].:- ")
    if family == "num" and token.isdigit():
        return (int(token),)
    if family.startswith("dec"):
        parts = [p for p in token.split(".") if p]
        return tuple(int(p) for p in parts) if all(p.isdigit() for p in parts) else None
    if family in ("al", "AU") and len(token) == 1:
        return (ord(token.lower()),)
    if family in ("rl", "RU") and token and all(c in ROMAN for c in token.lower()):
        values = [ROMAN[c] for c in token.lower()]
        return (sum(-v if k + 1 < len(values) and v < values[k + 1] else v for k, v in enumerate(values)),)
    return None


def follows(before, after):
    """Whether a count continues: n then n+1, or 2.3 then 2.4 or 3 / 3.1."""
    if before is None or after is None:
        return True
    if len(before) == 1 and len(after) == 1:
        return after[0] == before[0] + 1
    if len(after) == len(before) and after[:-1] == before[:-1]:
        return after[-1] == before[-1] + 1
    return after[0] == before[0] + 1 or (after[0] == before[0] and len(after) > len(before))


def runs(found):
    """Consecutive numbered units of one label and family whose count continues."""
    result = []
    for item in found:
        last = result[-1][-1] if result else None
        if last and last[1:3] == item[1:3] and follows(count(last[3], last[2]), count(item[3], item[2])):
            result[-1].append(item)
        else:
            result.append([item])
    return result


def listing(sha, group, gold):
    typed, units = gold["typed"], gold["units"]
    found = numbered(gold)
    if not found:
        return None, {}
    out = [f"# {sha} | {group.get('genre', '?')} | {group.get('mode', '?')} | {group.get('language_layout', '?')} | "
           f"{len(units)} units, {len(found)} numbered"]
    members = {}
    for k, run in enumerate(runs(found), 1):
        name = f"R{k}"
        members[name] = [u for u, *_ in run]
        first_unit, region, family = run[0][0], run[0][1], run[0][2]
        pages = (typed[units[first_unit]["lines"][0]]["page"], typed[units[run[-1][0]]["lines"][0]]["page"])
        out.append(f"{name} {region} {family} n={len(run)} pages {pages[0]}-{pages[1]} markers {run[0][3]} .. {run[-1][3]}")
        if first_unit > 0:
            before = typed[units[first_unit - 1]["lines"][-1]]
            out.append(f"   before [{before['region']}]: ...{flat(before['text'])[-70:]}")
        shown = [run[0], run[1]] if len(run) > 1 else [run[0]]
        if len(run) > 2:
            shown.append(run[-1])
        for item in shown:
            out.append(f"   {item[4][:100]}")
    return "\n".join(out), members


def list_command(store, groups_path, out_dir, batch_chars):
    groups = json.loads(Path(groups_path).read_text(encoding="utf-8"))["sources"]
    out_dir.mkdir(parents=True, exist_ok=True)
    batches, current, size, sidecar, docs = [], [], 0, {}, 0
    for path in sorted((store / "v4").glob("*/gold.json.gz")):
        sha = path.parent.name
        group = groups.get(sha, {})
        if group.get("label_source", "model") != "model":
            continue
        text, members = listing(sha, group, load(path))
        if text is None:
            continue
        docs += 1
        sidecar[sha] = members
        if current and size + len(text) > batch_chars:
            batches.append(current); current, size = [], 0
        current.append(text); size += len(text)
    if current:
        batches.append(current)
    for n, batch in enumerate(batches, 1):
        (out_dir / f"batch-{n:03}.txt").write_text("\n\n".join(batch) + "\n", encoding="utf-8")
    (out_dir / "runs.json").write_text(json.dumps(sidecar), encoding="utf-8")
    print(f"{docs} golds with numbered units in {len(batches)} batches -> {out_dir}")


def apply_command(store, out_dir, ledger_path):
    sidecar = json.loads((out_dir / "runs.json").read_text(encoding="utf-8"))
    decisions = {}
    for path in sorted(out_dir.glob("decisions-*.json")):
        decisions.update(json.loads(path.read_text(encoding="utf-8")))
    ledger, changed = [], 0
    for sha, chosen in sorted(decisions.items()):
        if not chosen:
            continue
        path = store / "v4" / sha / "gold.json.gz"
        gold = load(path)
        typed, units = gold["typed"], gold["units"]
        for decision in chosen:
            region = decision["region"]
            if region not in BODY:
                raise ValueError(f"{sha} {decision}: region must be text or list_item")
            for u in sidecar[sha][decision["run"]]:
                old = typed[units[u]["lines"][0]]["region"]
                if old == region:
                    continue
                for t in units[u]["lines"]:
                    typed[t]["region"] = region
                ledger.append({"sha256": sha, "unit": u, "run": decision["run"], "from": old, "to": region,
                               "text": flat(typed[units[u]["lines"][0]]["text"])[:80]})
        parents = hierarchy.assemble([typed[u["lines"][0]]["region"] for u in units],
                                     [flat(typed[u["lines"][0]]["text"]) for u in units],
                                     [u.get("level") for u in units],
                                     [u.get("starts_document", False) for u in units])
        for u, unit in enumerate(units):
            unit["parent"] = parents[u]
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(gold, f, ensure_ascii=False)
        changed += 1
    Path(ledger_path).write_text(json.dumps({"applied_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "changes": ledger},
                                            indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{changed} golds rewritten, {len(ledger)} units relabelled -> {ledger_path}")


def main(argv):
    if argv[:1] == ["list"] and len(argv) >= 4:
        chars = int(argv[argv.index("--batch-chars") + 1]) if "--batch-chars" in argv else 200_000
        list_command(Path(argv[1]), argv[2], Path(argv[3]), chars)
    elif argv[:1] == ["apply"] and len(argv) == 4:
        apply_command(Path(argv[1]), Path(argv[2]), argv[3])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
