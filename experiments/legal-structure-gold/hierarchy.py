"""Pass 2: each pass-1 block's parent, decided per document over numbered rows.

The model sees one row per logical block (continued fragments merged; furniture, page labels
and notes left out) and answers one parent row number per row. The runner sets the parent on
every fragment of the row and the shared composition validates the result.
"""
import json
from pathlib import Path

import package
from gold import require

INSTRUCTIONS = """For each row give the number of the row it belongs under (its heading, list item or the paragraph it continues), or 0 if it is top level. Rows are in reading order."""
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["parents"],
          "properties": {"parents": {"type": "array", "items": {"type": "integer", "minimum": 0}}}}
CHUNK_ROWS = 200
TEXT_LINKS = ("paragraph", "heading", "list")


def rows(value):
    """Document scopes of rows: (first block, region, text, fragment blocks)."""
    layer = value["layers"]["legal_structure"]
    lines = package.line_table(value)
    text = lambda block: " ".join(lines[s["line_id"]]["text"][s["start"]:s["end"]] for s in block["spans"])
    covered = lambda block, kind: any(s["line_id"] == a["line_id"] and a["start"] <= s["start"] < a["end"]
                                      for s in block["spans"][:1] for n in layer["annotations"] if n["kind"] == kind
                                      for a in n["spans"])
    blocks = {block["id"]: block for block in layer["blocks"]}
    following = {anchor: link["next"] for kind in TEXT_LINKS for anchor, link in layer["continuations"].get(kind, {}).items()}
    continued = set(following.values())
    scopes = {}
    for block in layer["blocks"]:
        if block["id"] in continued or block["kind"] in ("furniture", "page_label") or covered(block, "note"):
            continue
        fragments, current = [block], block["id"]
        while current in following and following[current] in blocks:
            current = following[current]; fragments.append(blocks[current])
        region = "table" if covered(block, "table") else "list_item" if block["attributes"].get("locator_kind") == "list_item" else block["kind"]
        if block["ownership"]["quotation_id"]: region = "quoted " + region
        scopes.setdefault(block["ownership"]["document_id"], []).append(
            {"block": block["id"], "region": region, "text": " ".join(text(block).split())[:60], "fragments": [f["id"] for f in fragments]})
    return list(scopes.values())


def prompt(scope, shown):
    return INSTRUCTIONS + "\n\nROWS\n" + "\n".join(f"{n + 1} | {scope[n]['region']} | {scope[n]['text']}" for n in shown)


def decide(scope, ask):
    """Parent row numbers (1-based, 0 for top level) for every row, chunk by chunk."""
    parents = [0] * len(scope)
    for start in range(0, len(scope), CHUNK_ROWS):
        # Still-open ancestors of the previous chunk's last row carry its context forward.
        # A trailing top-level row (a side note, a caption) must not hide the open outline.
        context = set()
        for at in range(max(0, start - 5), start):
            context.add(at)
            while parents[at]:
                at = parents[at] - 1; context.add(at)
        context = sorted(context)
        shown = context + list(range(start, min(start + CHUNK_ROWS, len(scope))))
        answer = ask(prompt(scope, shown), shown)
        for n, parent in zip(shown, answer):
            if n >= start: parents[n] = parent
    return parents


def checked(shown):
    def validate(response):
        parents = response["parents"]
        require(len(parents) == len(shown), f"Expected {len(shown)} parents, one per row")
        require(all(parent - 1 < n for n, parent in zip(shown, parents)), "A row's parent must be an earlier row")
        return parents
    return validate


def apply(value, scopes, decided):
    """The structure layer with parents; a parent outside the row's quotation scope is dropped."""
    layer = json.loads(json.dumps(value["layers"]["legal_structure"]))
    blocks = {block["id"]: block for block in layer["blocks"]}
    report = {"rows": 0, "with_parent": 0, "dropped_cross_scope": 0}
    for scope, parents in zip(scopes, decided):
        for row, parent in zip(scope, parents):
            report["rows"] += 1
            target = scope[parent - 1]["block"] if parent else None
            if target and blocks[target]["ownership"] != blocks[row["block"]]["ownership"]:
                report["dropped_cross_scope"] += 1; target = None
            report["with_parent"] += bool(target)
            for fragment in row["fragments"]:
                blocks[fragment]["attributes"]["parent"] = target
    return package.with_structure(value, layer)["layers"]["legal_structure"], report


def outline(scope, parents):
    """Rows indented under their parents, for reading."""
    depth = []
    for n, parent in enumerate(parents):
        depth.append(depth[parent - 1] + 1 if parent else 0)
    return "\n".join(f"{'    ' * d}{n + 1}. [{row['region']}] {row['text']}" for n, (row, d) in enumerate(zip(scope, depth)))


def run(job, args, dispatch):
    """Decide a selected gold's hierarchy; write the pilot result beside it without publishing."""
    from worker import call, verified_run, write_json
    job = Path(job)
    _, value, _ = verified_run(job)
    task = job / "hierarchy-authoring"
    task.mkdir(exist_ok=True)
    schema_path = task / "schema.json"
    write_json(schema_path, SCHEMA)
    scopes = rows(value)
    decided = []
    for index, scope in enumerate(scopes):
        ask = lambda text, shown: call(text, schema_path, [], task / "calls" / f"scope-{index:03}", args,
                                       checked(shown), dispatch)
        decided.append(decide(scope, ask))
    layer, report = apply(value, scopes, decided)
    write_json(task / "result.json", {"scopes": [{"rows": scope, "parents": parents} for scope, parents in zip(scopes, decided)],
                                      "report": report, "instructions": INSTRUCTIONS, "schema": SCHEMA})
    return task / "result.json", scopes, decided, report
