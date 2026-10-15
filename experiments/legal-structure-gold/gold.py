"""Source-anchored structure state: native source lines, composition and materialized gold."""
from copy import deepcopy
import ocr

VERSION = "legal-structure-gold.v3"


def require(value, message):
    if not value: raise ValueError(message)


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


def changed_offset(point, changes, right=False):
    delta=0
    for e in changes:
        if point<e["start"]: break
        if point==e["start"]:
            return point+delta+(len(e["text"]) if right and e["start"]==e["end"] else 0)
        if point<e["end"]: return e["start"]+delta+(len(e["text"]) if right else 0)
        delta+=len(e["text"])-(e["end"]-e["start"])
    return point+delta


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


def composition_request(state, through=None):
    return {"lines":state["lines"],"groups":state["groups"],"annotations":state["annotations"],
            "reading_order":state["reading_order"],"targets":[],"visible_pages":[],"edits":[],
            "native_navigation":state.get("native_navigation",[]),
            "removable_nodes":state.get("native_nodes",[]),
            "through":through,**{key:state.get(key,{}) for key in ("joins","continuations","resumes","manuscript_edits")}}


def line_separator(state, left, right):
    left_range,right_range=left.get("source_range"),right.get("source_range")
    adjacent=left.get("source_id") is not None and left.get("source_id")==right.get("source_id") and left_range is not None and right_range is not None and left_range[1]==right_range[0]
    link=state["joins"].get(left["id"]+"@0",state["joins"].get(left["id"],{}))
    return link.get("separator","" if adjacent else " ")


def continuations(state):
    return ((ident,link) for layer in state["continuations"].values() for ident,link in layer.items())


def text_links(state):
    """Expose the shared logical-block assembly to legacy inspection callers."""
    from package import compose_structure
    assembled=compose_structure(composition_request(state))
    groups={block_id(group):group for group in assembled["groups"]}
    separators={span_anchor(span):span["separator"] for span in assembled["manuscript_spans"]}
    return {left:{"next":right,"separator":separators[right],
                  "kind":"heading" if groups[left]["kind"]=="heading" else "paragraph"}
            for parts in assembled["logical_blocks"].values() for left,right in zip(parts,parts[1:])}


def annotation_view(state,through=None):
    from package import resolve_annotations
    return resolve_annotations({"lines":state["lines"],"reading_order":state["reading_order"],
        "annotations":state["annotations"],"continuations":state["continuations"],
        "groups":state["groups"],"through":through})


def logical_annotations(state):
    return annotation_view(state)["annotations"]



def initial(structure, pages):
    lines = source_lines(structure)
    evidence = {a["id"]: a for p in pages for a in p["atoms"]}
    require(set(lines) == set(evidence), "Evidence source-ID coverage differs from native structure")
    for ident, line in lines.items():
        line.update(box=evidence[ident]["bbox"], type=evidence[ident].get("type", []),
                    spans=deepcopy(evidence[ident].get("spans", [])), words=deepcopy(evidence[ident].get("words", [])),
                    original_text=line["text"], source_id=ident, source_range=[0,len(line["text"])])
        line.update({key:deepcopy(evidence[ident][key]) for key in ("ocr","region_id","region_type","source") if key in evidence[ident]})
    import package
    prepared = package.structure_blocks(structure, list(lines.values()))
    groups = prepared["groups"]
    annotations = prepared["annotations"]
    state={"parser_proposals":True,"lines":list(lines.values()),"groups":groups,"annotations":annotations,
           "manuscript_edits":deepcopy(prepared.get("manuscript_edits",{})),
           "reading_order":list(lines),"joins":prepared["joins"],"continuations":prepared["continuations"],"resumes":prepared["resumes"],"operations":[],
           "native_navigation":deepcopy(structure.get("native_navigation",[])),
           "structure_tags":deepcopy(structure.get("structure_tags",[])),
           "native_nodes":prepared["removable_nodes"]}
    if any("ocr" in page for page in pages):
        require(all("ocr" in page for page in pages), "OCR page evidence incomplete")
        state["ocr"] = {**deepcopy(pages[0]["ocr_metadata"]), "pages": [deepcopy(p["ocr"]) for p in pages]}
    return state



def confirmed_annotations(state,through=None):
    lines={line["id"]:line for line in state["lines"]}
    for annotation in state["annotations"]:
        if through is not None and lines[annotation["line_ids"][0]]["page"]>through: continue
        attrs=annotation["attributes"]
        if annotation["kind"]=="quotation": require(attrs.get("layout") in {"inline","display"},"Quotation layout remains an unconfirmed parser proposal")
        if annotation["kind"]=="navigation" and attrs.get("kind")=="contents": require(bool(attrs.get("title")),"Contents title remains an unconfirmed parser proposal")


def complete(state,through=None):
    from package import compose_structure
    confirmed_annotations(state,through)
    compose_structure(composition_request(state,through))
    return True


def ownership(state,through=None):
    from package import compose_structure
    result=compose_structure(composition_request(state,through))
    return {g["id"]:g["ownership"]["document_id"] for g in result["groups"] if g.get("ownership")},[a for a in result["annotations"] if a["kind"]=="document"]


def materialize(structure,state,provenance):
    from package import project_structure
    projected=project_structure(structure,
        {**composition_request(state),"structure_tags":state.get("structure_tags",structure.get("structure_tags",[]))},
        [node["id"] for node in state["native_nodes"]])
    assembled=projected["composition"]
    document=projected["structure"]
    evidence=projected["structure_evidence"]
    document.update(evidence.get("fields",{}))
    for kind in ("nodes","notes"):
        for item in document.get(kind,[]):
            item.update(evidence.get(kind,{}).get(item["id"],{}))
    units={line["id"]:line for line in assembled["lines"]}
    return document["rendered_text"],{
        "schema_version":VERSION,"source_sha256":structure["source_sha256"],
        "offset_unit":"utf16","source_character_unit":"unicode_scalar",
        "coordinates":"visible-page-top-left-1000","structure":document,
        "source_trace":projected["source_trace"],
        "native_facts":projected["native_facts"],
        "unconfirmed_native_witnesses":projected["unconfirmed_native_witnesses"],
        "reading_order":assembled["reading_order"],"blocks":assembled["groups"],
        "manuscript_spans":assembled["manuscript_spans"],
        "manuscript_edits":assembled["manuscript_edits"],
        "native_navigation":deepcopy(document.get("native_navigation",[])),
        "joins":assembled["joins"],"continuations":assembled["continuations"],
        "resumes":assembled["resumes"],
        "operations":state["operations"],"provenance":provenance,
        **({"ocr":ocr.compact(state["ocr"],units)} if "ocr" in state else {})
    }
