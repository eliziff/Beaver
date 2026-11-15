"""Deterministic corrections the gold runner applies after the model's passes (author.py, before it
writes the gold), each a rule the gold's own conventions imply, recorded in the gold file under
`postcorrections`. The gold so corrected is the representation the grader scores, as stored: nothing
reads it through further rules.

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

Quoted numbers: a judgment numbers its own paragraphs one way, its spine (the style, "[12]", "12." or
"12", that most of its numbered text units print). A numbered text unit printing another style with a
number the spine also prints is not one of its paragraphs (a pinpoint "para 45" is the spine's 45) but
material it sets out (agreed facts, a list of issues, an order's terms, a quoted judgment's paragraphs):
it takes the region the gold gives the nearest earlier unit numbered in its style, else it is a list
item before the spine's first paragraph and a quote after it. A unit that also prints a spine number
stays. The A2AJ-aligned gold's paragraphs are A2AJ's own numbered paragraphs and stay.

Note labels: a note's label is the number or symbol its first line opens on ("1 It is not to be
inferred", "* Note: closing cash"); a note unit with no marker whose first line opens on one, set apart
by a space, takes it as its marker, so every note carries its label the one way.

Duplicate references: a reference mark is the whole printed mark. Where one line holds two references
one inside the other ("2" within "23", both inherited from a parser's split of the superscript), the
shorter goes, with any pair that names it.

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


NUMBERINGS = (("bracket", re.compile(r"^\[(\d{1,4})\]$")), ("dot", re.compile(r"^(\d{1,4})\.$")),
              ("paren", re.compile(r"^\((\d{1,4})\)$")), ("half", re.compile(r"^(\d{1,4})\)$")), ("bare", re.compile(r"^(\d{1,4})$")))


def numbering(marker):
    """A printed paragraph number's style and number ("[12]": bracket, 12), else None."""
    for style, form in NUMBERINGS:
        found = form.match(marker.strip())
        if found:
            return style, int(found.group(1))
    return None


def quoted_numbers(gold, edge=None):
    aligned = gold.get("label_source") == "a2aj-align"
    units, kind = gold["units"], kinds(gold)
    numbered = []  # per unit: its markers' (style, number) readings
    for unit in units:
        numbered.append([numbering(m) for m in printed_markers(gold, unit)] if unit["lines"] else [])
    starts = [u for u, unit in enumerate(units) if u == 0 or unit.get("starts_document")] + [len(units)]
    done = []
    for a, b in zip(starts, starts[1:]):
        if kind[a] != "judgment":
            continue
        text = [u for u in range(a, b) if regions(gold, units[u]) == {"text"} and numbered[u] and numbered[u][0]]
        printed = collections.defaultdict(set)
        for u in text:
            printed[numbered[u][0][0]].add(numbered[u][0][1])
        if not printed:
            continue
        spine = max(printed, key=lambda style: len(printed[style]))
        if len(printed[spine]) < 3:
            continue
        # Numbering that spans under
        # three tenths of a judgment of four pages or more, or prints fewer numbers than a third of the pages it
        # spans, is no paragraph numbering; its units are lists.
        page = {line["id"]: line["page"] for line in gold["lines"]}
        def pages_of(us):
            return [page[s["line_id"]] for u in us for t in units[u]["lines"] for s in gold["typed"][t]["spans"][:1] if s["line_id"] in page]
        spine_pages, document_pages = pages_of([u for u in text if numbered[u][0][0] == spine]), set(pages_of(range(a, b)))
        spanned = max(spine_pages) - min(spine_pages) + 1 if spine_pages else 0
        if len(document_pages) >= 4 and (spanned * 10 < len(document_pages) * 3 or len(printed[spine]) * 3 < spanned):
            for u in text:
                for t in units[u]["lines"]:
                    if gold["typed"][t]["region"] == "text":
                        gold["typed"][t]["region"] = "list_item"
                done.append({"rule": "no_paragraph_numbering", "unit": u, "spine": spine, "to": "list_item", "text": unit_text(gold, units[u])[:80]})
            continue
        if aligned:
            continue
        first = min(u for u in text if numbered[u][0][0] == spine)
        for u in text:
            style, number = numbered[u][0]
            if style == spine or number not in printed[spine] or any(n and n[0] == spine for n in numbered[u]):
                continue
            # The gold's own reading of the same numbering nearby, else a list before the reasons, a quote within them.
            same = [v for v in range(u - 1, a - 1, -1) if numbered[v] and numbered[v][0] and numbered[v][0][0] == style
                    and regions(gold, units[v]) & {"quote", "list_item"}]
            to = gold["typed"][units[same[0]]["lines"][0]]["region"] if same else "list_item" if u < first else "quote"
            for t in units[u]["lines"]:
                if gold["typed"][t]["region"] == "text":
                    gold["typed"][t]["region"] = to
            done.append({"rule": "quoted_number", "unit": u, "spine": spine, "to": to, "text": unit_text(gold, units[u])[:80]})
    return done


def margin_numbers(gold, edge=None):
    """A law report's paragraph number printed alone in the margin numbers the row beside it, in every column: a
    parallel report's English and French paragraphs opening level with it are both that paragraph. Each text unit
    opening on the number's row without a marker of its own takes the number (a unit that goes on from another, or
    a number in the column's text, is left as it is)."""
    lines = {line["id"]: line for line in gold["lines"]}
    typed, kind = gold["typed"], kinds(gold)
    unit_of = {t: u for u, unit in enumerate(gold["units"]) for t in unit["lines"]}
    by_page = collections.defaultdict(list)
    for line in gold["lines"]:
        by_page[line["page"]].append(line)
    prose = {page: [l["bbox"] for l in ls if len(l["text"].strip()) >= 20] for page, ls in by_page.items()}
    done = []
    for t, entry in enumerate(typed):
        if entry["region"] != "text" or not entry["markers"] or kind[unit_of.get(t, 0)] != "judgment":
            continue
        span = entry["markers"][0][0] if isinstance(entry["markers"][0], list) else entry["markers"][0]
        number_line = lines.get(span["line_id"])
        if number_line is None or not re.fullmatch(r"\[?\d{1,4}\]?", number_line["text"].strip()):
            continue
        boxes = prose.get(number_line["page"], [])
        if not boxes:
            continue
        x0, y0, x1, y1 = number_line["bbox"]
        if not (x1 < min(b[0] for b in boxes) - 2 or x0 > max(b[2] for b in boxes) + 2):
            continue
        middle, height = (y0 + y1) / 2, max(y1 - y0, 1.0)
        for other, row in enumerate(typed):
            if other == t or row["region"] != "text" or row["markers"] or not row.get("start") or not row["spans"]:
                continue
            first = lines.get(row["spans"][0]["line_id"])
            if first is None or first["page"] != number_line["page"] or len(first["text"].strip()) < 6:
                continue
            if abs((first["bbox"][1] + first["bbox"][3]) / 2 - middle) <= height * 0.6:
                row["markers"] = [[dict(span)]]
                done.append({"rule": "margin_number", "unit": unit_of.get(other), "number": number_line["text"].strip(),
                             "text": row["text"][:80]})
    return done


CONCURRENCE = re.compile(r"^\s*(Concurred in|Concurring|I concur|Je souscris|Souscrivent)\s*:\s*$", re.I)


def concurrence_lines(gold, edge=None):
    """A judgment's concurrence line after its reasons ("Concurred in:") opens the signature matter: it goes on with
    no paragraph. A text unit holding one after its first line is split there, the line opening a unit of its own."""
    typed, kind = gold["typed"], kinds(gold)
    done = []
    for u in range(len(gold["units"]) - 1, -1, -1):
        unit = gold["units"][u]
        if kind[u] != "judgment":
            continue
        cut = next((k for k, t in enumerate(unit["lines"]) if k > 0 and typed[t]["region"] == "text"
                    and CONCURRENCE.match(typed[t]["text"])), None)
        if cut is None:
            continue
        typed[unit["lines"][cut]]["start"] = True
        rest = {k: v for k, v in unit.items() if k not in ("lines", "document_type", "starts_document")}
        gold["units"][u:u + 1] = [{**unit, "lines": unit["lines"][:cut]}, {**rest, "starts_document": False, "lines": unit["lines"][cut:]}]
        done.append({"rule": "concurrence_line", "unit": u, "text": typed[unit["lines"][cut]]["text"][:80]})
    return done


def bracket_number_lines(gold, edge=None):
    """A judgment's bracketed paragraph number printed alone on its line ("[1]") opens the paragraph under it: no
    transcript's line number. A line-label unit of only that number, before a text unit of no marker, joins it as its
    first line, and its number becomes the unit's marker."""
    typed, kind = gold["typed"], kinds(gold)
    done = []
    for u in range(len(gold["units"]) - 2, -1, -1):
        unit, after = gold["units"][u], gold["units"][u + 1]
        if len(unit["lines"]) != 1 or not after["lines"] or kind[u] != "judgment":
            continue
        entry, opening = typed[unit["lines"][0]], typed[after["lines"][0]]
        found = re.fullmatch(r"\s*(\[\d{1,4}\])\s*", entry["text"])
        if entry["region"] != "line_label" or not found or not entry["spans"] or opening["region"] != "text" or opening["markers"]:
            continue
        span = entry["spans"][0]
        line = next(l for l in gold["lines"] if l["id"] == span["line_id"])
        start = line["text"].find(found.group(1))
        if start < 0:
            continue
        entry["region"] = "text"
        entry["markers"] = [[{"line_id": span["line_id"], "start": start, "end": start + len(found.group(1))}]]
        opening["start"] = False
        merged = {**{k: v for k, v in after.items() if k != "lines"}, **{k: v for k, v in unit.items() if k != "lines" and v},
                  "lines": unit["lines"] + after["lines"]}
        gold["units"][u:u + 2] = [merged]
        done.append({"rule": "bracket_number_line", "unit": u, "number": found.group(1), "text": opening["text"][:80]})
    return done


NOTE_LABEL = re.compile(r"^(\s*)(\d{1,3}|[*\u2020\u2021\u00a7\u00b6]{1,3})(?=\s)")


def note_labels(gold, edge=None):
    texts = {line["id"]: line.get("corrected") or line["text"] for line in gold["lines"]}
    done = []
    for u, unit in enumerate(gold["units"]):
        if not unit["lines"]:
            continue
        head = gold["typed"][unit["lines"][0]]
        if head["region"] != "note" or head["markers"] or not head["spans"]:
            continue
        span = head["spans"][0]
        text = texts.get(span["line_id"], "")[span["start"]:span["end"]]
        found = NOTE_LABEL.match(text)
        if not found:
            continue
        start = span["start"] + len(found.group(1))
        head["markers"] = [[{"line_id": span["line_id"], "start": start, "end": start + len(found.group(2))}]]
        done.append({"rule": "note_label", "unit": u, "label": found.group(2), "text": text[:80]})
    return done


def duplicate_references(gold, edge=None):
    done = []
    for t, typed in enumerate(gold["typed"]):
        references = typed.get("references") or []
        spans = [(r["spans"][0]["line_id"], r["spans"][0]["start"], r["spans"][0]["end"]) if r.get("spans") else None for r in references]
        drop = set()
        for i, a in enumerate(spans):
            for j, b in enumerate(spans):
                if i != j and a and b and a[0] == b[0] and b[1] <= a[1] and a[2] <= b[2] and (a[2] - a[1]) < (b[2] - b[1]):
                    drop.add(i)
        if not drop:
            continue
        kept = [i for i in range(len(references)) if i not in drop]
        moved = {old: new for new, old in enumerate(kept)}
        for i in sorted(drop):
            done.append({"rule": "duplicate_reference", "typed": t, "label": references[i].get("label"), "span": list(spans[i][1:])})
        typed["references"] = [references[i] for i in kept]
        gold["notes"] = [n if n["line"] != t else dict(n, reference=moved[n["reference"]]) for n in gold.get("notes", [])
                         if n["line"] != t or n["reference"] in moved]
    return done


RULES = (running_heads, section_captions, numbered_captions, type_regions, bracket_number_lines, concurrence_lines, margin_numbers, quoted_numbers,
         note_labels, duplicate_references)


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
