"""Source-anchored structure state of a parser export, and the shared composition the scorer reads it with."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess

# The composition's primary roles; a scorer role outside them (contents) composes as text.
COMPOSED = {"text", "heading", "caption", "instruction", "headnote", "marginal_note", "furniture", "page_label"}


def require(value, message):
    if not value: raise ValueError(message)


def native(command, request):
    """One shared native operation through extract.mjs."""
    operation = subprocess.run(["node", str(Path(__file__).with_name("extract.mjs")), command],
        input=json.dumps(request, ensure_ascii=False), capture_output=True, encoding="utf-8")
    require(operation.returncode == 0, operation.stderr.strip())
    return json.loads(operation.stdout)


def source_lines(structure):
    """Physical source lines of the native UTF-16 structure contract."""
    require(structure.get("offset_unit") == "utf16", "Expected the native UTF-16 structure contract")
    text, result = structure["text"].encode("utf-16-le"), {}
    if structure.get("source_fragments"):
        for fragment in structure["source_fragments"]:
            ident, extent = fragment["id"], fragment["range"]
            require(ident not in result and 0 <= extent["start"] <= extent["end"] <= len(text) // 2, "Invalid native source fragment")
            result[ident] = {"id": ident, "text": text[extent["start"]*2:extent["end"]*2].decode("utf-16-le"),
                             "page": fragment["page_index"]+1, "range": deepcopy(extent)}
        return result
    for page in (n for n in structure["nodes"] if n["kind"] == "page"):
        start = page["range"]["start"]
        content = text[start*2:page["range"]["end"]*2].decode("utf-16-le").split("\n")
        ids = page.get("line_ids", [])  # a page without lines carries none
        if not ids and not content[0]: continue
        require(len(content) == len(ids), "Native page source IDs do not match its text range")
        for ident, line in zip(ids, content):
            stop = start + len(line.encode("utf-16-le")) // 2
            require(ident not in result, "Duplicate native line ID")
            result[ident] = {"id": ident, "text": line, "page": page["page_indexes"][0] + 1,
                             "range": {"start": start, "end": stop}}
            start = stop + 1
    return result


def range_refs(span, lines, structure):
    result = []
    for line in lines.values():
        a, b = max(span["start"], line["range"]["start"]), min(span["end"], line["range"]["end"])
        if a < b:
            raw = line["text"].encode("utf-16-le")
            start = len(raw[:(a-line["range"]["start"])*2].decode("utf-16-le"))
            end = len(raw[:(b-line["range"]["start"])*2].decode("utf-16-le"))
            result.append({"line_id": line["id"], "start": start, "end": end})
    return result


def whole(ids, lines):
    return [{"line_id": i, "start": 0, "end": len(lines[i]["text"])} for i in ids]


def span_anchor(span):
    return f"{span['line_id']}@{span['start']}"


def block_id(block):
    return block.get("id") or span_anchor((block.get("spans") or [{"line_id":block["line_ids"][0],"start":0}])[0])


def composed_groups(state):
    return [g if g["kind"] in COMPOSED else {**g, "kind": "text"} for g in state["groups"]]


def composition_request(state, through=None):
    return {"lines":state["lines"],"groups":composed_groups(state),"annotations":state["annotations"],
            "reading_order":state["reading_order"],"targets":[],"visible_pages":[],"edits":[],
            "native_navigation":state.get("native_navigation",[]),
            "removable_nodes":state.get("native_nodes",[]),
            "through":through,**{key:state.get(key,{}) for key in ("joins","continuations","resumes","manuscript_edits")}}


def compose_structure(state):
    return native("--compose-structure", composition_request(state))


def continuations(state):
    return ((ident,link) for layer in state["continuations"].values() for ident,link in layer.items())


def text_links(state):
    """Each block's next fragment in its logical block, from the shared assembly."""
    assembled=compose_structure(state)
    groups={block_id(group):group for group in assembled["groups"]}
    return {left:{"next":right,"kind":"heading" if groups[left]["kind"]=="heading" else "paragraph"}
            for parts in assembled["logical_blocks"].values() for left,right in zip(parts,parts[1:])}


def logical_annotations(state):
    return native("--resolve-annotations", {"lines":state["lines"],"reading_order":state["reading_order"],
        "annotations":state["annotations"],"continuations":state["continuations"],
        "groups":composed_groups(state),"through":None})["annotations"]


def ownership(state):
    result=compose_structure(state)
    return {g["id"]:g["ownership"]["document_id"] for g in result["groups"] if g.get("ownership")},[a for a in result["annotations"] if a["kind"]=="document"]


def initial(structure, pages):
    """The parser's blocks and annotations over its source lines, with their page boxes."""
    lines = source_lines(structure)
    evidence = {a["id"]: a for p in pages for a in p["atoms"]}
    require(set(lines) == set(evidence), "Evidence source-ID coverage differs from native structure")
    for ident, line in lines.items():
        line.update(box=evidence[ident]["bbox"], original_text=line["text"], source_id=ident, source_range=[0,len(line["text"])])
    prepared = native("--structure-blocks", {"structure": structure, "lines": list(lines.values())})
    return {"lines":list(lines.values()),"groups":prepared["groups"],"annotations":prepared["annotations"],
            "manuscript_edits":deepcopy(prepared.get("manuscript_edits",{})),
            "reading_order":list(lines),"joins":prepared["joins"],"continuations":prepared["continuations"],"resumes":prepared["resumes"],
            "native_navigation":deepcopy(structure.get("native_navigation",[])),
            "native_nodes":prepared["removable_nodes"]}
