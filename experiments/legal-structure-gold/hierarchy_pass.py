"""The document hierarchy of completed structure gold runs, decided over the whole document.

The structure gold is annotated page window by page window, so a document's outline can drift at a
page break: one count's paragraphs ("23.", "24.", ...) take different parents on different pages.
This second pass reads every heading, numbered paragraph and list item of one document at once (its
page, role, printed marker, opening words, indent, and the parent the first pass gave it) and decides
each unit's parent; its level follows, the parent's plus one. It also rules out the heading blocks
that are no part of the outline, a statute's marginal notes and a reported case's headnotes, which
the page annotator was never told apart from headings. The page-level gold is never changed:
the decision is a separate layer, `hierarchy.json.gz` beside the run's gold, which the scorer applies
where it exists.

  python experiments/legal-structure-gold/hierarchy_pass.py [--runs SHA_PREFIX...] [--limit N] --run
"""
import argparse, gzip, hashlib, json, re, sys, tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import evaluate, gold, worker  # noqa: E402
from codex_exec import _atomic_json, _invoke  # noqa: E402

ROOT = HERE.parents[1]
OUT = ROOT / "benchmarks/local-data/legal-structure-gold"
LAYER = "hierarchy.json.gz"
VERSION = "legal-structure-gold.hierarchy.v2"
OUTSIDE = ("marginal_note", "headnote", "caption", "text")
KINDS = ("heading", "list_item", "numbered_paragraph")
SCHEMA = {
    "type": "object",
    "properties": {"parents": {"type": "array", "items": {
        "type": "object",
        "properties": {"id": {"type": "string"}, "parent": {"type": ["string", "null"]},
                       "role": {"type": "string", "enum": ["unit", *OUTSIDE]},
                       "kind": {"type": "string", "enum": list(KINDS)}},
        "required": ["id", "parent", "role", "kind"], "additionalProperties": False}}},
    "required": ["parents"], "additionalProperties": False,
}
PROMPT = """Below is every heading, numbered paragraph and list item of one legal document, in reading
order: its id, page, role, printed marker, opening words, left indent on its page, the quotation it
stands in if any, and the parent a page-by-page annotator gave it. Page-by-page annotation drifts where a page breaks. Decide each unit's
parent over the whole document, as the document's own outline has it:

- A unit's parent is the nearest earlier unit that contains it: a heading over the units of its
  section, a numbered paragraph over the lists that complete it, a list item over its sub-list.
  A unit that nothing contains has parent null.
- Units of one count are siblings with one parent: (a), (b), (c); 1., 2., 3.; i., ii.; bullets of
  one kind and indent. A heading between them gives the later ones that heading as parent.
- A heading's parent is the nearest earlier heading of a higher rank in the document's heading
  scheme (its numbering, wording and indent), the same scheme on every page.
- Numbering inside a quotation (a statute or judgment quoted at length) is the quoted text's own:
  a unit quoted in a quotation takes as parent only a unit quoted in the same quotation, or null.
- A "heading" that is a statute's marginal note (a short gloss set in the margin beside a
  provision; "beside" names the provision line level with it) or a reported case's headnote (its
  catchwords or summary of the points decided, printed between the case's title and its syllabus
  or opinion) is no part of the outline: give it role marginal_note or headnote and parent null,
  and no unit takes it as parent. Every other unit has role unit.
- A "heading" that is a line of the document's caption or a form's furniture is no part of the
  outline: the court's or tribunal's name over the parties ("IN THE SUPREME COURT OF INDIA",
  "UNITED STATES DISTRICT COURT"), a file or case number, a form's number or identifier standing
  alone ("Form 59.16C", "FORM 5", "NO. 28"), a party's label ("Applicant", "BETWEEN:"), a date or
  place line. Give it role caption and parent null. These stay units, never caption: a heading
  naming a section of the document's own text ("ORDER OF THE COURT", "Reasons for Judgment"); the
  document's own title, a form's title included ("FORM 10b (Judgment Allowing Appeal ...)" is the
  form's title; "FORM 10b" alone is caption); a part of the document ("SCHEDULE 4", "PART II",
  "APPENDIX A", "EXHIBIT A" heading an exhibit's own text); a reported case's title in a law
  report ("Oswald, administrator, v. State of New York."), which heads that case. When unsure,
  keep the annotator's role. A unit shown with role caption may be restored: give it role unit and
  its kind where it is in fact a heading.
- A unit that is no heading, numbered paragraph or list item at all (ordinary running text set
  apart, a label or a line of a form's field, a stray number or a signature line) is demoted to
  the document's text: give it role text and parent null.
- Each unit's kind, the same for every unit of one count throughout the document:
  heading, a title over a section of text, numbered or not ("4. Status Reports", a short title
  followed by its section's text, is a heading); numbered_paragraph, a paragraph of the document's
  body numbered in sequence (an affidavit's, a judgment's, an agreement's or a statute's own
  numbered paragraphs and provisions, "1.", "2.", "(1)", standing as paragraphs); list_item, an
  item of a list, enumerated after a lead-in or within a paragraph ("(a)", "(i)", bullets), or a
  short item of a numbered list that is no paragraph of the body. Its current kind is shown; keep
  it unless it is clearly wrong.
- Keep the annotator's parent wherever it agrees with the whole document.

Return every id exactly once with its role, its kind and its parent's id or null; a parent always
comes earlier.

Units:
"""


PROVISION = re.compile(r"^\s*(\(?\d{1,4}[A-Za-z]?(\.\d+)*[.)]?|\(\d{1,3}\)|[Ss](ec)?\.?\s*\d+)\s")
CASE_TITLE = re.compile(r"\bv\.?\s+[A-Z]|\bvs?\.\s")


def beside_provisions(state):
    """The heading blocks set in a side margin, each with the provision line level with its first
    line: narrow, most of its lines beside body text, opening level with a numbered provision."""
    lines = {l["id"]: l for l in state["lines"] if l.get("box")}
    kinds = {i: g["kind"] for g in state["groups"] for i in g["line_ids"]}
    body = lambda i: kinds.get(i) in ("prose", "list_item")
    pages = {}
    for i, line in lines.items():
        pages.setdefault(line["page"], []).append(i)
    measure = {}
    for page, ids in pages.items():
        boxes = [lines[i]["box"] for i in ids if body(i)]
        if boxes:
            lefts = sorted(b[0] for b in boxes); rights = sorted(b[2] for b in boxes)
            measure[page] = rights[-1 - len(rights) // 10] - lefts[len(lefts) // 10]

    def level_with(i, provision):
        x0, y0, x1, y1 = lines[i]["box"]
        for j in pages[lines[i]["page"]]:
            a0, b0, a1, b1 = lines[j]["box"]
            if not body(j) or not (a0 >= x1 - 1 or a1 <= x0 + 1):
                continue
            if provision and abs(b0 - y0) <= 1.2 * (y1 - y0) and PROVISION.match(lines[j]["text"]):
                return lines[j]["text"][:90]
            if not provision and min(y1, b1) - max(y0, b0) > 0.3 * (y1 - y0):
                return lines[j]["text"]
        return None

    found = {}
    for group in state["groups"]:
        ids = [i for i in group["line_ids"] if i in lines]
        if group["kind"] != "heading" or not ids or lines[ids[0]]["page"] not in measure:
            continue
        width = max(lines[i]["box"][2] for i in ids) - min(lines[i]["box"][0] for i in ids)
        if width <= 0.35 * measure[lines[ids[0]]["page"]] and sum(level_with(i, False) is not None for i in ids) * 2 > len(ids):
            provision = level_with(ids[0], True)
            if provision:
                found[group["line_ids"][0]] = provision
    return found


def units_of(state):
    lines = {l["id"]: l for l in state["lines"]}
    beside = beside_provisions(state)
    pos = {i: n for n, i in enumerate(state["reading_order"])}
    quotes = gold.quotations(state)
    units = []
    for group in state["groups"]:
        attrs = group["attributes"]
        if group["kind"] not in ("heading", "caption") and not attrs.get("marker"):
            continue
        first = group["line_ids"][0]
        line = lines[first]
        marker = "".join(lines[s["line_id"]]["text"][s["start"]:s["end"]] for s in attrs.get("marker", []))
        words = " ".join(lines[i]["text"] for i in group["line_ids"])[:90]
        units.append({"id": first, "page": line["page"], "role": group["kind"],
                      "kind": group["kind"] if group["kind"] in KINDS else "numbered_paragraph", "marker": marker.strip(),
                      "words": words, "indent": round(line["box"][0]) if line.get("box") else None,
                      "quotation": gold.quotation_scope(group, quotes, lines),
                      **({"beside": beside[first]} if first in beside else {}),
                      "annotated_parent": attrs.get("parent")})
    units.sort(key=lambda unit: pos.get(unit["id"], 10**9))
    return units


def validated(units, response):
    order = {unit["id"]: n for n, unit in enumerate(units)}
    parents, roles = {}, {row["id"]: row["role"] for row in response["parents"]}
    for row in response["parents"]:
        worker.require(row["id"] in order and row["id"] not in parents, f"Unknown or repeated id {row['id']}")
        parent = row["parent"]
        worker.require(row["role"] in ("unit", "text") or units[order[row["id"]]]["role"] in ("heading", "caption"),
                       f"Only a heading can be ruled a {row['role']}: {row['id']}")
        worker.require(roles.get(parent, "unit") == "unit", f"Parent {parent} of {row['id']} is ruled out of the outline")
        worker.require(row["role"] == "unit" or parent is None, f"{row['id']} is ruled out of the outline and takes no parent")
        worker.require(parent is None or (parent in order and order[parent] < order[row["id"]]),
                       f"Parent {parent} of {row['id']} is not an earlier unit")
        worker.require(parent is None or units[order[parent]]["quotation"] == units[order[row["id"]]]["quotation"],
                       f"Parent {parent} of {row['id']} stands outside its quotation")
        parents[row["id"]] = parent
    worker.require(len(parents) == len(units), "Every unit needs a parent decision")
    items = levels_of(units, parents, roles)
    for row in response["parents"]:
        items[row["id"]]["kind"] = row.get("kind", units[order[row["id"]]]["kind"])
    return items


ROMAN = re.compile(r"^(?=[ivxlc]+$)c{0,3}(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$", re.I)
BULLETS = "•-–—*▪◦●○■□➢✓·"


def family(marker):
    """A marker's counting family and value: ("()", "a") and 2 for "(b)"; a bullet has no value."""
    text = marker.strip()
    if len(text) == 1 and text in BULLETS:
        return ("•", "bullet"), None
    for wrap, opening, closing in (("()", "(", ")"), ("[]", "[", "]")):
        if text.startswith(opening) and text.endswith(closing):
            inner = text[1:-1]
            break
    else:
        if text.endswith(")"):
            wrap, inner = ")", text[:-1]
        elif text.endswith("."):
            wrap, inner = ".", text[:-1]
        else:
            wrap, inner = "", text
    inner = inner.strip()
    if inner.isdigit():
        return (wrap, "1"), int(inner)
    if len(inner) == 1 and inner.isalpha():
        return (wrap, "A" if inner.isupper() else "a"), ord(inner.lower()) - 96
    if ROMAN.match(inner):
        return (wrap, "I" if inner.isupper() else "i"), None
    return None, None


def repaired(units):
    """The parents the document's own numbering settles, and whether any stays in doubt.

    Successive units of one count ((a) then (b), 23. then 24.), in one quotation and with no
    heading between them, are siblings: they take the parent most of them were given, the earliest
    on a tie. A count whose units were given parents with no clear majority is in doubt.
    """
    order = {unit["id"]: n for n, unit in enumerate(units)}
    parents = {}
    for unit in units:
        parent = unit["annotated_parent"]
        parents[unit["id"]] = parent if parent in order and order[parent] < order[unit["id"]] else None
    headings = [n for n, unit in enumerate(units) if unit["role"] == "heading"]
    chains, last = [], {}
    for n, unit in enumerate(units):
        if unit["role"] == "heading":
            continue
        fam, value = family(unit["marker"])
        if fam is None:
            continue
        key = (fam, unit["quotation"])
        prior = last.get(key)
        if prior is not None:
            m, last_value, chain = prior
            if not any(m < h < n for h in headings) and (value is None or last_value is None or value == last_value + 1):
                chains[chain].append(n)
                last[key] = (n, value, chain)
                continue
        chains.append([n])
        last[key] = (n, value, len(chains) - 1)
    doubt = False
    for chain in chains:
        if len(chain) < 2:
            continue
        given = [parents[units[n]["id"]] for n in chain]
        counts = Counter(given)
        best = max(counts.values())
        choice = next(parent for parent in given if counts[parent] == best)
        if best * 5 < len(chain) * 3:
            doubt = True
        if choice is not None and order[choice] >= order[units[chain[0]]["id"]]:
            continue
        for n in chain:
            parents[units[n]["id"]] = choice
    return parents, doubt


def levels_of(units, parents, roles=None):
    roles = roles or {}
    levels = {}
    for unit in units:
        parent = parents[unit["id"]]
        levels[unit["id"]] = 1 if parent is None else levels[parent] + 1
    return {ident: {"parent": parents[ident], "level": levels[ident], "role": roles.get(ident, "unit")} for ident in parents}


def write_layer(job, gold_path, units, items, source, attempts=0):
    changed = sum(1 for unit in units if items[unit["id"]]["parent"] != unit["annotated_parent"])
    layer = {"schema_version": VERSION, "gold_sha256": worker.digest(gold_path), "source": source,
             "attempts": attempts, "changed": changed, "items": items}
    (job / LAYER).write_bytes(gzip.compress(json.dumps(layer, ensure_ascii=False).encode(), mtime=0))
    return f"{source}: {changed}/{len(units)} parents changed"


def decide(job, args):
    gold_path = job / "gold.json.gz"
    try:
        _, state = evaluate.state_of(worker.read_json(gold_path))
    except Exception as exc:
        return f"unreadable: {str(exc)[-80:]}"
    units = units_of(state)
    if len(units) < 2:
        return "skipped"
    parents, doubt = repaired(units)
    # A heading set beside a provision, or headings in a reported case, may be no heading at all.
    doubt = doubt or any("beside" in unit for unit in units) or any(
        unit["role"] == "heading" and CASE_TITLE.search(unit["words"]) for unit in units) or args.conventions
    items = levels_of(units, parents)
    if not doubt or not args.run:
        if not args.write:
            return "in doubt" if doubt else "settled"
        return write_layer(job, gold_path, units, items, "deterministic")
    # What the numbering leaves in doubt goes to the model, the settled parents its starting point.
    for unit in units:
        unit["annotated_parent"] = parents[unit["id"]]
    prompt = PROMPT + "\n".join(json.dumps(unit, ensure_ascii=False) for unit in units)
    error, attempts = "", []
    with tempfile.TemporaryDirectory() as temp:
        schema = Path(temp) / "schema.json"
        schema.write_text(json.dumps(SCHEMA), encoding="utf-8")
        instructions = Path(temp) / "instructions.md"
        instructions.write_text(worker.INSTRUCTIONS, encoding="utf-8")
        extra = ["--ignore-rules", "-c", "model_instructions_file=" + json.dumps(instructions.resolve().as_posix())]
        for name, value in worker.CONFIG.items():
            extra.extend(["-c", name + "=" + json.dumps(value)])
        for attempt in range(args.attempts):
            work = Path(temp) / f"attempt-{attempt + 1}"
            work.mkdir()
            try:
                response = _invoke(prompt=prompt + ("\n\nCorrect the previous failure: " + error if error else ""),
                                   schema_path=schema, image_paths=[], model=args.model, effort=args.effort,
                                   work_dir=work, timeout_seconds=args.timeout, extra_args=extra)
                decided = validated(units, response)
            except Exception as exc:  # A contract failure is retried with its reason.
                error = str(exc)[-400:]
                attempts.append({"error": error})
                continue
            return write_layer(job, gold_path, units, decided, "model:" + args.model, len(attempts) + 1)
    return "model failed: " + error


def apply(job, value):
    """The run's gold with its document hierarchy layer applied, where one exists for this gold."""
    path = Path(job) / LAYER
    if not path.is_file():
        return value
    layer = json.loads(gzip.decompress(path.read_bytes()))
    if layer.get("gold_sha256") != worker.digest(Path(job) / "gold.json.gz"):
        return value
    items = layer["items"]
    for block in value.get("blocks", []):
        decided = items.get(block["line_ids"][0]) if block.get("line_ids") else None
        if decided and decided.get("role", "unit") != "unit":
            # Demoted to text: the document's running text, no unit and no marker of one.
            block["kind"] = "prose" if decided["role"] == "text" else decided["role"]
            for attribute in ("parent", "level") + (("marker",) if decided["role"] == "text" else ()):
                block["attributes"].pop(attribute, None)
            continue
        # The unit's kind, where the pass decided one: a numbered paragraph is body prose with its marker.
        kind = decided.get("kind") if decided else None
        if kind == "numbered_paragraph" and block["attributes"].get("marker"):
            block["kind"] = "prose"
        elif kind in ("heading", "list_item"):
            block["kind"] = kind
        if decided and ("level" in block["attributes"] or "parent" in block["attributes"]):

            block["attributes"]["parent"] = decided["parent"]
            block["attributes"]["level"] = decided["level"]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", nargs="*", default=[])
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--model", default="gpt-6.1-sol")
    parser.add_argument("--effort", default="medium")
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--parallel", type=int, default=2)
    parser.add_argument("--redo", action="store_true", help="Decide again where a layer exists")
    parser.add_argument("--write", action="store_true", help="Write the layers the numbering settles")
    parser.add_argument("--conventions", action="store_true",
                        help="Review every document's units against the conventions (role, kind, parent), not only those the numbering leaves in doubt")
    parser.add_argument("--run", action="store_true", help="Call the model for documents left in doubt (implies --write)")
    args = parser.parse_args()
    import score_all
    jobs = [job for _, job, _ in score_all.completed(OUT)
            if (not args.runs or any(job.parent.name.startswith(p) for p in args.runs))
            and (args.redo or not (job / LAYER).is_file())]
    if args.limit:
        jobs = jobs[:args.limit]
    args.write = args.write or args.run
    outcomes = Counter()
    with ThreadPoolExecutor(args.parallel if args.run else 1) as pool:
        for job, outcome in zip(jobs, pool.map(lambda job: decide(job, args), jobs)):
            outcomes[outcome.split(":")[0]] += 1
            if args.run:
                print(job.relative_to(OUT), outcome, flush=True)
    print(dict(outcomes))


if __name__ == "__main__":
    main()
