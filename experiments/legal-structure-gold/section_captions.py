"""A section's caption is its marginal note, not a heading (the gold's convention: marginal notes are not
headings, and a clause's caption belongs to its clause). Statutes, regulations and rules print the
caption beside the section or just above it; the federal golds type it marginal_note wherever it is
printed, while golds of other legislation typed the caption printed above the section heading. This
retypes those: in a legislation document, a heading unit that is a caption (a short title line, no
enumerator, not a part, division or schedule heading, not an amending act's heading naming the act
it amends nor the citation line over an amending provision), or a pair of them (a bilingual caption),
followed directly by a section that opens with its number and is the only numbered section before
the next heading or marginal note, becomes marginal_note and loses its heading level. A heading over
several sections, or over a section that has its own marginal note, is a heading and stays.

Each change is recorded in the gold's postcorrections (rule section_caption); the receipt takes the
new hash. Then register the store again. gold_checks.py's `captions` check flags any left.

  python experiments/legal-structure-gold/section_captions.py [--dry-run] [--examples N]
"""
import argparse
import collections
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "legal_pdf_corpus"))
import gold_store  # noqa: E402
from type_audit import openings, write_gzip  # noqa: E402

GROUP = re.compile(r"^\W*(part|partie|division|subdivision|sous-section|section|chapter|chapitre|title|titre|schedule|annexe?|"
                   r"appendix|form|formule|book|livre|article)\b", re.I)
ENUMERATOR = re.compile(r"^\W*([0-9]+|[ivxlc]+|[a-z])([.)\]]|\s|$)", re.I)
NUMBERED = re.compile(r"^\s*(\d+(\.\d+)*[A-Z]?|\(\d+(\.\d+)?\))(\s|$|\()")
# An amending act's heading naming the act it amends, and the citation line over an amending provision.
AMENDED = re.compile(r"(\bAct|\bCode|Regulations?|Rules)\s*$|^\W*(Loi|Code|Règlement|Règles)\b|^\s*[—–-]\s*\S*\d|\b(c|ch|s|art)\.\s*\d")
QUIET = {"furniture", "page_label", "line_label", "note"}


def regions(gold, unit):
    return {gold["typed"][t]["region"] for t in unit["lines"]}


def text(gold, unit, line_text):
    return " ".join(line_text[s["line_id"]] for t in unit["lines"] for s in gold["typed"][t]["spans"]).strip()


def caption(gold, unit, line_text):
    if regions(gold, unit) != {"heading"} or len(unit["lines"]) > 2:
        return False
    words = text(gold, unit, line_text)
    return bool(words) and len(words.split()) <= 14 and not GROUP.match(words) and not ENUMERATOR.match(words) \
        and not words.endswith((".", ";", ":")) and not words.isupper() and not AMENDED.search(words)


def section_captions(gold):
    """The unit indexes of the heading units that are section captions, per the rule above."""
    line_text = {line["id"]: line["text"] for line in gold["lines"]}
    units = gold["units"]
    opened = openings(gold)
    kind = {}
    for k, start in enumerate(opened):
        end = opened[k + 1] if k + 1 < len(opened) else len(units)
        for u in range(start, end):
            kind[u] = units[start].get("document_type")
    found = []
    u = 0
    while u < len(units):
        if kind.get(u) != "legislation" or not caption(gold, units[u], line_text):
            u += 1
            continue
        run = [u]
        v = u + 1
        while v < len(units) and len(run) < 2 and kind.get(v) == "legislation" and caption(gold, units[v], line_text):
            run.append(v); v += 1
        while v < len(units) and regions(gold, units[v]) <= QUIET:
            v += 1
        if v < len(units) and units[v].get("depth") == 1 and regions(gold, units[v]) & {"provision", "text", "list_item"} \
                and NUMBERED.match(text(gold, units[v], line_text)):
            sections = 0
            w = v
            while w < len(units) and not regions(gold, units[w]) & {"heading", "marginal_note", "title"} and kind.get(w) == "legislation":
                if units[w].get("depth") == 1 and NUMBERED.match(text(gold, units[w], line_text)):
                    sections += 1
                w += 1
            if sections == 1:
                found.extend(run)
        u = run[-1] + 1
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--examples", type=int, default=0)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    count = collections.Counter()
    examples = []
    for sha, path in gold_store.sources(gold_store.STRUCTURE):
        gold = gold_store.read(path)
        found = section_captions(gold)
        if not found:
            continue
        line_text = {line["id"]: line["text"] for line in gold["lines"]}
        count["sources"] += 1
        count["units"] += len(found)
        done = []
        for u in found:
            unit = gold["units"][u]
            words = text(gold, unit, line_text)
            if len(examples) < 10_000:
                nxt = next((text(gold, x, line_text) for x in gold["units"][u + 1:] if regions(gold, x) & {"provision", "text", "list_item"}), "")
                examples.append(f"{sha[:10]} | {words[:60]} ⏎ {nxt[:60]}")
            for t in unit["lines"]:
                gold["typed"][t]["region"] = "marginal_note"
            done.append({"rule": "section_caption", "unit": u, "level": unit.pop("level", None), "text": words})
        if not args.dry_run:
            gold.setdefault("postcorrections", []).extend(done)
            write_gzip(path, gold)
            receipt = path.with_name("receipt.json")
            if receipt.is_file():
                value = json.loads(receipt.read_text(encoding="utf-8-sig"))
                value["gold_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                value["postcorrections"] = len(gold["postcorrections"])
                receipt.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    if args.examples:
        import random
        random.seed(3)
        for e in random.sample(examples, min(args.examples, len(examples))):
            print("  " + e)
    print(json.dumps(dict(count)), "(dry run)" if args.dry_run else "")


if __name__ == "__main__":
    main()
