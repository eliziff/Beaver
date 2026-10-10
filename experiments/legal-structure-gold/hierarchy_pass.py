"""The document hierarchy of completed structure gold runs, decided over the whole document.

The structure gold is annotated page window by page window, so a document's outline can drift at a
page break: one count's paragraphs ("23.", "24.", ...) take different parents on different pages.
This second pass reads every heading, numbered paragraph and list item of one document at once (its
page, role, printed marker, opening words, indent, and the parent the first pass gave it) and decides
each unit's parent; its level follows, the parent's plus one. The page-level gold is never changed:
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
VERSION = "legal-structure-gold.hierarchy.v1"
SCHEMA = {
    "type": "object",
    "properties": {"parents": {"type": "array", "items": {
        "type": "object",
        "properties": {"id": {"type": "string"}, "parent": {"type": ["string", "null"]}},
        "required": ["id", "parent"], "additionalProperties": False}}},
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
- Keep the annotator's parent wherever it agrees with the whole document.

Return every id exactly once with its parent's id or null; a parent always comes earlier.

Units:
"""


def units_of(state):
    lines = {l["id"]: l for l in state["lines"]}
    pos = {i: n for n, i in enumerate(state["reading_order"])}
    quotes = gold.quotations(state)
    units = []
    for group in state["groups"]:
        attrs = group["attributes"]
        if group["kind"] != "heading" and not attrs.get("marker"):
            continue
        first = group["line_ids"][0]
        line = lines[first]
        marker = "".join(lines[s["line_id"]]["text"][s["start"]:s["end"]] for s in attrs.get("marker", []))
        words = " ".join(lines[i]["text"] for i in group["line_ids"])[:90]
        units.append({"id": first, "page": line["page"], "role": group["kind"], "marker": marker.strip(),
                      "words": words, "indent": round(line["box"][0]) if line.get("box") else None,
                      "quotation": gold.quotation_scope(group, quotes, lines),
                      "annotated_parent": attrs.get("parent")})
    units.sort(key=lambda unit: pos.get(unit["id"], 10**9))
    return units


def validated(units, response):
    order = {unit["id"]: n for n, unit in enumerate(units)}
    parents = {}
    for row in response["parents"]:
        worker.require(row["id"] in order and row["id"] not in parents, f"Unknown or repeated id {row['id']}")
        parent = row["parent"]
        worker.require(parent is None or (parent in order and order[parent] < order[row["id"]]),
                       f"Parent {parent} of {row['id']} is not an earlier unit")
        worker.require(parent is None or units[order[parent]]["quotation"] == units[order[row["id"]]]["quotation"],
                       f"Parent {parent} of {row['id']} stands outside its quotation")
        parents[row["id"]] = parent
    worker.require(len(parents) == len(units), "Every unit needs a parent decision")
    levels = {}
    for unit in units:
        parent = parents[unit["id"]]
        levels[unit["id"]] = 1 if parent is None else levels[parent] + 1
    return {ident: {"parent": parents[ident], "level": levels[ident]} for ident in parents}


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


def levels_of(units, parents):
    levels = {}
    for unit in units:
        parent = parents[unit["id"]]
        levels[unit["id"]] = 1 if parent is None else levels[parent] + 1
    return {ident: {"parent": parents[ident], "level": levels[ident]} for ident in parents}


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
