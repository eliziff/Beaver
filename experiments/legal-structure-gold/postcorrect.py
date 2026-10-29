"""Deterministic corrections the gold runner applies after the model's passes (author.py, before it
writes the gold), each a rule the gold's own conventions imply, recorded in the gold file under
`postcorrections`. The gold so corrected is the representation the tagger trains on and the grader
scores, as stored: nothing reads it through further rules.

Running heads: a page's running head is furniture, never a heading. A one-line heading unit at the
top or bottom edge of its page is a running head when the same words (a folio number before or
after them set aside) already stood at the edge of an earlier page and the gold calls most of their
other appearances furniture, and stands where they stand, as tall. A head that repeats unchanged
from the page that opens its part stays a heading there when it holds the part's units (the part's
title, as a schedule's or a resolution's), unless a copy already stood on an earlier page. The unit
becomes furniture; its children move to its parent; the correction keeps both, to be undone.

Section captions: a section's caption is its marginal note, not a heading (marginal notes are not
headings; a clause's caption belongs to its clause). In a legislation document, a heading unit that
is a caption (a short title line with no enumerator; not a part, division or schedule heading, an
amending act's heading naming the act it amends, nor the citation line over an amending provision),
or a pair of them (a bilingual caption), directly over a section that opens with its number and is
the only numbered section before the next heading or marginal note, becomes marginal_note and loses
its heading level. A heading over several sections, or over a section with its own marginal note,
stays.

Numbered captions: in a contract or legislation, a clause or section's number with its caption on a
line of its own ("19. EVIDENCE OF INDEBTEDNESS", "2.0 TERM") opens that provision; it is not a
heading (a heading is a part's, division's, article's or chapter's, or unnumbered). A heading unit
so numbered becomes a provision: it takes a depth (one per printed marker) where it had a level,
and every unit it held goes as much deeper. Innermost first, so a numbered caption over others
converts after them; one holding a heading of another kind stays.

Body regions by document type: what a numbered body unit is follows from what the document is.
In a contract or legislation a text or list unit opening with a printed number or letter (not a
bullet) is a provision, and a provision with no printed number is text; in a judgment, submission
or article a provision is an instrument set out in it, a quote. Elsewhere (a schedule split from its
contract, a practice direction typed other) the region stands.

  python postcorrect.py [--sha PREFIX] [--inputs DIR] [--dry-run]   correct the store's current golds
  (running heads only where --inputs holds the extraction's pages, <sha>.json.gz)
"""
import argparse
import collections
import copy
import gzip
import hashlib
import json
import os
import re
import sys
from pathlib import Path

EDGE = 2  # a line among the first or last three of its page by height is at the edge
INSTRUMENTS = ("contract", "legislation")
QUOTING = ("judgment", "submission", "article")
BODY = ("text", "list_item", "provision")


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
    if edge is None:
        return []
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


def kinds(gold):
    """Each unit's document type: its document's, given on the document's first unit."""
    out, kind = [], None
    for unit in gold["units"]:
        kind = unit.get("document_type") or kind
        out.append(kind)
    return out


def regions(gold, unit):
    return {gold["typed"][t]["region"] for t in unit["lines"]}


def unit_text(gold, unit):
    return " ".join(gold["typed"][t]["text"].strip() for t in unit["lines"]).strip()


def printed_markers(gold, unit):
    """The unit's printed markers' texts (a bullet is no number: only markers with a letter or digit)."""
    texts = {line["id"]: line.get("corrected") or line["text"] for line in gold["lines"]}
    found = []
    for t in unit["lines"]:
        for marker in gold["typed"][t]["markers"] or []:
            spans = marker if isinstance(marker, list) else [marker]
            value = "".join(texts.get(s["line_id"], "")[s["start"]:s["end"]] for s in spans if s)
            if any(c.isalnum() for c in value):
                found.append(value)
    return found


GROUP = re.compile(r"^\W*(part|partie|division|subdivision|sous-section|section|chapter|chapitre|title|titre|schedule|annexe?|"
                   r"appendix|form|formule|book|livre|article)\b", re.I)
ENUMERATOR = re.compile(r"^\W*([0-9]+|[ivxlc]+|[a-z])([.)\]]|\s|$)", re.I)
NUMBERED = re.compile(r"^\s*(\d+(\.\d+)*[A-Z]?|\(\d+(\.\d+)?\))(\s|$|\()")
# An amending act's heading naming the act it amends, and the citation line over an amending provision.
AMENDED = re.compile(r"(\bAct|\bCode|Regulations?|Rules)\s*$|^\W*(Loi|Code|Règlement|Règles)\b|^\s*[—–-]\s*\S*\d|\b(c|ch|s|art)\.\s*\d")
QUIET = {"furniture", "page_label", "line_label", "note"}


def section_captions(gold, edge=None):
    units, kind = gold["units"], kinds(gold)

    def caption(unit):
        if regions(gold, unit) != {"heading"} or len(unit["lines"]) > 2:
            return False
        said = unit_text(gold, unit)
        return bool(said) and len(said.split()) <= 14 and not GROUP.match(said) and not ENUMERATOR.match(said) \
            and not said.endswith((".", ";", ":")) and not said.isupper() and not AMENDED.search(said)

    found, u = [], 0
    while u < len(units):
        if kind[u] != "legislation" or not caption(units[u]):
            u += 1
            continue
        run, v = [u], u + 1
        while v < len(units) and len(run) < 2 and kind[v] == "legislation" and caption(units[v]):
            run.append(v)
            v += 1
        while v < len(units) and regions(gold, units[v]) <= QUIET:
            v += 1
        if v < len(units) and units[v].get("depth") == 1 and regions(gold, units[v]) & set(BODY) and NUMBERED.match(unit_text(gold, units[v])):
            sections, w = 0, v
            while w < len(units) and not regions(gold, units[w]) & {"heading", "marginal_note", "title"} and kind[w] == "legislation":
                sections += units[w].get("depth") == 1 and bool(NUMBERED.match(unit_text(gold, units[w])))
                w += 1
            if sections == 1:
                found.extend(run)
        u = run[-1] + 1
    done = []
    for u in found:
        unit = units[u]
        for t in unit["lines"]:
            gold["typed"][t]["region"] = "marginal_note"
        done.append({"rule": "section_caption", "unit": u, "level": unit.pop("level", None), "text": unit_text(gold, unit)[:120]})
    return done


CLAUSE = re.compile(r"^\s*\d+(\.\d+)*\.?\s+\S")


def numbered_captions(gold, edge=None):
    units, kind = gold["units"], kinds(gold)
    done, changed = [], True
    while changed:
        changed = False
        for u, unit in enumerate(units):
            said = unit_text(gold, unit)
            if kind[u] not in INSTRUMENTS or "level" not in unit or regions(gold, unit) != {"heading"} \
                    or not CLAUSE.match(said) or len(said.split()) > 12 or not printed_markers(gold, unit):
                continue
            scope = []
            for v in range(u + 1, len(units)):
                if units[v].get("starts_document"):
                    break
                if "level" in units[v]:
                    if units[v]["level"] > unit["level"]:
                        scope = None
                    break
                scope.append(v)
            if scope is None:
                continue
            depths = list(range(1, len(printed_markers(gold, unit)) + 1))
            for v in scope:
                if "depth" in units[v]:
                    units[v]["depth"] += depths[-1]
                    units[v]["marker_depths"] = [d + depths[-1] for d in units[v].get("marker_depths", [])]
            level = unit.pop("level")
            unit.update(depth=depths[-1], marker_depths=depths)
            for t in unit["lines"]:
                gold["typed"][t]["region"] = "provision"
            done.append({"rule": "numbered_caption", "unit": u, "level": level, "held": len(scope), "text": said[:120]})
            changed = True
    return done


def type_regions(gold, edge=None):
    units, kind = gold["units"], kinds(gold)
    if not any(kind):
        return []
    done = []
    for u, unit in enumerate(units):
        region = gold["typed"][unit["lines"][0]]["region"]
        if region not in BODY:
            continue
        numbered = bool(printed_markers(gold, unit))
        if kind[u] in INSTRUMENTS:
            to = "provision" if numbered else "text" if region == "provision" else region
        else:
            to = "quote" if region == "provision" and kind[u] in QUOTING else region
        if to == region:
            continue
        for t in unit["lines"]:
            if gold["typed"][t]["region"] in BODY:
                gold["typed"][t]["region"] = to
        done.append({"rule": "type_region", "unit": u, "from": region, "to": to, "text": unit_text(gold, unit)[:80]})
    return done


RULES = (running_heads, section_captions, numbered_captions, type_regions)


def write(path, value):
    """As the runner writes its artifacts: sorted compact JSON, gzip without a timestamp, atomically."""
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(gzip.compress(data, mtime=0) if path.suffix == ".gz" else data)
    os.replace(temporary, path)


def apply(gold, pages=None):
    """Every rule over one gold, given its extraction's pages (None: the rules that need none); the
    corrections, also kept in the gold."""
    edge = edges(pages) if pages is not None else None
    done = [c for rule in RULES for c in rule(gold, edge)]
    gold.setdefault("postcorrections", []).extend(done)
    return done


def pending(gold):
    """The corrections the page-free rules would still make to a gold, which is left as it is."""
    return apply(copy.deepcopy(gold))


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "legal_pdf_corpus"))
    import gold_store
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha", default="")
    parser.add_argument("--inputs", type=Path, help="extraction pages (<sha>.json.gz) for the running-heads rule")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    total, sources = collections.Counter(), collections.Counter()
    for sha, path in gold_store.sources(gold_store.STRUCTURE):
        if not sha.startswith(args.sha):
            continue
        gold = gold_store.read(path)
        inputs = args.inputs / f"{sha}.json.gz" if args.inputs else None
        pages = json.load(gzip.open(inputs))["pages"] if inputs and inputs.is_file() else None
        done = apply(gold, pages)
        for c in done:
            total[c["rule"]] += 1
        for rule in {c["rule"] for c in done}:
            sources[rule] += 1
        if done and not args.dry_run:
            write(path, gold)
            receipt_path = path.with_name("receipt.json")
            receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
            receipt.update(gold_sha256=hashlib.sha256(path.read_bytes()).hexdigest(), postcorrections=len(gold["postcorrections"]))
            write(receipt_path, receipt)
    print("units", dict(total), "sources", dict(sources), "(dry run)" if args.dry_run else "")


if __name__ == "__main__":
    main()
