"""Read historical hierarchy authoring artifacts.

New structure authoring belongs to worker.py and receives every source block.
Saved hierarchy layers remain readable when importing historical packages.
"""
import argparse, gzip, json, re, sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import evaluate, gold, worker  # noqa: E402
from codex_runner.calls import AttemptsExhausted, CallPolicy, call, call_key, usage_totals  # noqa: E402

ROOT = HERE.parents[1]
OUT = ROOT / "benchmarks/local-data/legal-structure-gold"
LAYER = "hierarchy.json.gz"
CORRECTION = "hierarchy-correction.json"
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
    resolved = gold.annotation_view(state)
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
                      "quotation": resolved["quotation_scopes"][gold.block_id(group)],
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


def apply_items(value, items):
    blocks = value["layers"]["legal_structure"]["blocks"] if value.get("schema_version") == worker.package.VERSION else value.get("blocks", [])
    for block in blocks:
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
        if decided:
            block["attributes"]["parent"] = decided["parent"]
            block["attributes"]["level"] = decided["level"]
    return value


def write_layer(job, gold_path, units, items, source, attempts=0, *, original, input_sha256, call_receipt=None):
    changed = sum(1 for unit in units if items[unit["id"]]["parent"] != unit["annotated_parent"])
    if original.get("schema_version") == worker.package.VERSION:
        owned = [["layers", "legal_structure", "blocks"]]
        text_sha = worker.package.text_identity(original)
        candidate = worker.package.annotation_update(original, apply_items(deepcopy(original), items), owned_paths=owned,
            expected_source_sha256=original["source_sha256"], expected_text_sha256=text_sha)
        receipt = {"schema_version": VERSION, "owned_paths": owned, "input_gold_sha256": input_sha256,
                   "source_sha256": original["source_sha256"], "input_text_sha256": text_sha,
                   "source": source, "attempts": attempts, "changed": changed, "units": len(units),
                   "code_sha256": worker.digest(Path(__file__)), **(call_receipt or {"calls": []})}
        worker.publish_update(job, input_sha256, candidate, stage="hierarchy", receipt=receipt)
        return f"{source}: {changed}/{len(units)} parents changed"
    worker.require(worker.digest(gold_path) == input_sha256, "Hierarchy input gold changed")
    layer = {"schema_version": VERSION, "gold_sha256": input_sha256, "source": source,
             "attempts": attempts, "changed": changed, "items": items}
    (job / LAYER).write_bytes(gzip.compress(json.dumps(layer, ensure_ascii=False).encode(), mtime=0))
    return f"{source}: {changed}/{len(units)} parents changed"


def retry_prompt(prompt, error, previous):
    return prompt + ("\n\nCorrect the previous failure: " + error if error else "")


def retry_error(exc, response):
    return str(exc)[-400:]


CALL_POLICY = CallPolicy(worker.INSTRUCTIONS, worker.CONFIG, retry_prompt, retry_error,
                         "model failed: ", validate_schema=False)


def decide(job, args):
    raise ValueError("Separate hierarchy authoring is retired; use the complete-block structural author in worker.py")


def read_layer(job):
    """Resolve a saved hierarchy and any source-reviewed corrections bound to its originals."""
    job = Path(job)
    path = job / LAYER
    if not path.is_file():
        worker.require(not (job / CORRECTION).exists(), "Hierarchy correction has no original layer")
        return None
    layer = worker.read_json(path)
    correction_path = job / CORRECTION
    if not correction_path.is_file():
        return path, layer
    correction = worker.read_json(correction_path)
    worker.require(correction.get("schema_version") == "legal-structure-gold.hierarchy-correction.v1",
                   "Unknown hierarchy correction format")
    worker.require(correction["original_hierarchy_sha256"] == worker.digest(path),
                   "Reviewed hierarchy original changed; review the correction again")
    worker.require(correction["gold_sha256"] == layer["gold_sha256"] == worker.digest(job / "gold.json.gz"),
                   "Reviewed hierarchy gold changed; review the correction again")
    original = worker.read_json(job / "gold.json.gz")
    worker.require(correction["source_sha256"] == original["source_sha256"], "Hierarchy correction source differs")
    worker.require(correction["items"] and set(correction["items"]) <= set(layer["items"]),
                   "Hierarchy correction names unknown units")
    items = {**layer["items"], **correction["items"]}
    return correction_path, {**layer, "items": items, "source": "source_review",
                             "changed": correction["changed"]}


def apply(job, value):
    """The run's gold with its document hierarchy layer applied, where one exists for this gold."""
    pending = (Path(job) / "publication.json").is_file()
    worker.recover_update(Path(job))
    if pending:
        value = worker.read_json(Path(job) / "gold.json.gz")
    if "hierarchy" in value.get("provenance", {}).get("annotation_stages", {}):
        return value
    saved = read_layer(job)
    if saved is None:
        return value
    _, layer = saved
    if layer.get("gold_sha256") != worker.digest(Path(job) / "gold.json.gz"):
        return value
    return apply_items(value, layer["items"])


def state_identity(value):
    return worker.fingerprint({"text_sha256": worker.package.text_identity(value),
                               "blocks": value["layers"]["legal_structure"]["blocks"]})


def completed(job):
    worker.recover_update(job)
    value = worker.read_json(job / "gold.json.gz")
    if value.get("schema_version") == worker.package.VERSION:
        if "hierarchy" in value["provenance"].get("annotation_stages", {}):
            return worker.stage_current(job, value, "hierarchy")
        imported = value["provenance"].get("imported_hierarchy", {})
        return imported.get("state_sha256") == state_identity(value)
    saved = read_layer(job)
    return saved is not None and saved[1].get("gold_sha256") == worker.digest(job / "gold.json.gz")


def main():
    raise SystemExit("Separate hierarchy authoring is retired; use worker.py for source correction and complete-block structural authoring. Historical hierarchy readers remain available.")


if __name__ == "__main__":
    main()
