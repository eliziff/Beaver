"""Replay sparse composer corrections and assemble source-anchored gold."""
from collections import Counter
from copy import deepcopy
import difflib
import hashlib
import json
import re
import unicodedata
import composer
import ocr

VERSION = "legal-structure-gold.v3"
EXTRA = {"text", "split", "insert", "drop", "move", "join", "continue", "resume"}
FURNITURE = {"furniture", "page_label"}


def require(value, message):
    if not value: raise ValueError(message)


def stable_id(kind, value):
    return kind + "-" + composer.fingerprint(value)[:16]


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


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


def block_spans(block, lines):
    return block.get("spans") or whole(block["line_ids"],lines)


def block_id(block):
    return block.get("id") or span_anchor((block.get("spans") or [{"line_id":block["line_ids"][0],"start":0}])[0])


def anchor_line(ident, lines):
    return ident if ident in lines else ident.rsplit("@",1)[0]


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
    lines = composer.source_lines(structure)
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



def request(structure,pages,targets,state):
    require(targets and targets==list(range(min(targets),max(targets)+1)),"Gold requests edit contiguous physical pages")
    document_pages={n["page_indexes"][0]+1 for n in structure["nodes"] if n["kind"]=="page"}
    require({p["page"] for p in pages}==document_pages & set(range(min(targets)-1,max(targets)+2)),"Gold evidence must include the target chunk and neighbouring pages")
    index={l["id"]:l for l in state["lines"]}
    resolved=annotation_view(state)
    r={"baseline_hash":composer.fingerprint(structure),"lines":index,"groups":state["groups"],
       "annotations":state["annotations"],"reading_order":state["reading_order"],"pages":pages,
       "native_navigation":state.get("native_navigation",[]),
       "structure_tags":deepcopy(state.get("structure_tags",[])),
       "targets":targets,"modules":sorted(composer.MODULES),"gold":True,"parser_proposals":state.get("parser_proposals",False),"context":context(state,targets,resolved),
       **{key:state.get(key,{}) for key in ("joins","continuations","resumes","manuscript_edits")}}
    r["quotation_scopes"]={part:q["id"] for q in resolved["annotations"] if q["kind"]=="quotation" for part in q["fragment_ids"]}
    visible={i for i,l in index.items() if l["page"] in {p["page"] for p in pages}}
    known=set(visible)
    metadata_refs=[]
    documents={a["id"]:a for a in state["annotations"] if a["kind"]=="document"}
    retained_documents=set()
    def retain_refs(value):
        if isinstance(value,dict):
            if set(value)=={"line_id","start","end"}:
                metadata_refs.append(deepcopy(value)); known.add(value["line_id"])
            for v in value.values(): retain_refs(v)
        elif isinstance(value,list):
            for v in value: retain_refs(v)
        elif isinstance(value,str):
            if value in documents and value not in retained_documents:
                retained_documents.add(value)
                document=documents[value]
                retain_refs(document.get("spans") or whole(document["line_ids"],index))
                retain_refs(document["attributes"].get("parent"))
            elif anchor_line(value,index) in index: known.add(anchor_line(value,index))
    # Carried source context can name a remote enclosing document. Do not turn
    # the complete document inventory into permission to reference every opening.
    retain_refs({key:value for key,value in r["context"].items() if key not in {"document_scopes","resumes"}})
    for g in state["groups"]:
        if any(i in visible for i in g["line_ids"]):
            retain_refs(g["attributes"].get("parent")); retain_refs(g.get("ownership"))
    for a in state["annotations"]:
        if any(i in visible for i in a["line_ids"]):
            if a["kind"]=="document": retain_refs(a["id"])
            for key in ("references","attribution","parent","title","facets","target"): retain_refs(a["attributes"].get(key))
    for anchor,resume in state["resumes"].items():
        if anchor_line(anchor,index) in visible: retain_refs(resume.get("document"))
    r["context"]["document_scopes"]=[scope for scope in r["context"]["document_scopes"] if scope["id"] in retained_documents]
    r["aliases"]={f"l{i}":ident for i,ident in enumerate(state["reading_order"],1) if ident in known}
    r["annotation_aliases"]={f"a{i}":a["id"] for i,a in enumerate(state["annotations"]+state["native_nodes"],1)
                             if a["kind"] != "page" and (a["id"] in retained_documents or any(i in visible for i in a.get("line_ids",[])))}
    r["metadata_refs"]=metadata_refs
    r["native_nodes"]=state["native_nodes"]
    if "ocr" in state:
        r["ocr"] = {"ontology": state["ocr"]["ontology"], "producer": state["ocr"]["producer"],
            "pages": [deepcopy(p) for p in state["ocr"]["pages"] if p["page"] in {v["page"] for v in pages}],
            "proposals": {str(p["page"]): p.get("ocr_proposals", []) for p in pages}}
    return structure,r


def context(state,targets,resolved):
    lines={l["id"]:l for l in state["lines"]}
    visible={i for i,l in lines.items() if min(targets)-1<=l["page"]<=max(targets)+1}
    groups={block_id(g):g for g in state["groups"]}
    quotes=[a for a in resolved["annotations"] if a["kind"]=="quotation"]
    def view(g):
        spans=block_spans(g,lines)
        return {"id":block_id(g),"kind":g["kind"],"page":lines[spans[0]["line_id"]]["page"],
                "spans":spans,"text":" ".join(lines[s["line_id"]]["text"][s["start"]:s["end"]] for s in spans),
                "quotation_id":resolved["quotation_scopes"][block_id(g)],"ownership":g.get("ownership"),
                **{k:v for k,v in g["attributes"].items() if k in {"parent","locator_kind","marker","reading_stream_id"}}}
    inherited={}
    for group in state["groups"]:
        if not any(i in visible for i in group["line_ids"]): continue
        parent=group["attributes"].get("parent"); seen=set()
        while parent is not None:
            parent=parent if parent in groups else parent+"@0"
            if parent not in groups or parent in seen: break
            seen.add(parent); ancestor=groups[parent]
            if not any(i in visible for i in ancestor["line_ids"]): inherited[parent]=view(ancestor)
            parent=ancestor["attributes"].get("parent")
    stream_ids={g["attributes"].get("reading_stream_id") for g in state["groups"]}
    endpoint_ids=set()
    for layer in state["continuations"].values():
        for ident,link in layer.items(): endpoint_ids.update((ident,link["next"]))
    endpoint_spans=[]
    for value in [*state["groups"],*state["annotations"]]:
        spans=value.get("spans") or whole(value["line_ids"],lines)
        if span_anchor(spans[0]) in endpoint_ids or spans[0]["line_id"] in endpoint_ids:
            endpoint_spans.append({"id":span_anchor(spans[0]),"kind":value["kind"],"spans":spans,
                "text":" ".join(lines[s["line_id"]]["text"][s["start"]:s["end"]] for s in spans)})
    return {"inherited_blocks":list(inherited.values()),
            "continuation_candidates":composer.continuation_candidates(lines,state["groups"],state["annotations"],state["reading_order"],targets),
            "continuation_endpoints":endpoint_spans,
            "pending_continuations":composer.pending_continuations(lines,state["groups"],state["annotations"],state["continuations"],targets),
            "reading_streams":[view(g) for g in state["groups"] if block_id(g) in stream_ids],
            "navigation":[view(g) for g in state["groups"] if g["kind"]=="heading"],
            "document_scopes":[{"id":a["id"],"spans":a.get("spans") or whole(a["line_ids"],lines),
                                **a["attributes"]} for a in state["annotations"] if a["kind"]=="document"],
            "quotation_scopes":[{"id":a["id"],"spans":a["spans"]} for a in quotes],
            "continuations":state["continuations"],"resumes":state["resumes"]}


def apply(structure,req,response,state,mode):
    if response.get("source_defects"):
        raise ValueError("Source correction required before structural publication: " + json.dumps(response["source_defects"],ensure_ascii=False))
    result=deepcopy({k:v for k,v in state.items() if k != "operations"})
    result["operations"]=list(state["operations"])
    units={l["id"]:l for l in result["lines"]}; aliases=dict(req["aliases"])
    targets={i for i,l in units.items() if l["page"] in req["targets"]}
    original_response=deepcopy(response)
    parsed=[(refs[0],kind,body) for refs,kind,body in composer.correction_records(response)]
    edits={}; expansion={i:[i] for i in units}; dropped=set()
    fragment_ranges={i:(0,len(l["text"])) for i,l in units.items()}
    def ident(value,allowed=None):
        require(isinstance(value,str) and value in aliases,"Unknown source ID")
        value=aliases[value]
        require(allowed is None or value in allowed,"Correction outside TARGET")
        return value
    # Source-stage parser proposals are editable evidence, not accepted gold.
    # Apply explicit sparse resets/removals before mapping corrected text anchors.
    proposal_records=[record for record in response["corrections"] if next(iter(record)) in {"remove","clear_continue","clear_resume"}]
    if req.get("responsibility")=="source" and proposal_records:
        require(state.get("parser_proposals") is True,"Source-stage invalidation only applies to initial parser proposals")
        from package import compose_structure
        prepared=composer.apply(structure,req,{"corrections":proposal_records},apply_annotations=compose_structure)["composition"]
        result.update({key:prepared[key] for key in ("groups","annotations","joins","continuations","resumes")})
        result["native_nodes"]=prepared["removable_nodes"]
    if req.get("responsibility")!="source": result["parser_proposals"]=False
    from package import apply_source_operations, remap_native_facts
    def carry_native(before, after, **changes):
        if "native_facts" in result:
            result["native_facts"]=remap_native_facts({"native_facts":result["native_facts"],
                "before_lines":before,"after_lines":after,**changes})
    source_anchors=[]
    def collect_source_anchors(value):
        if isinstance(value,dict):
            if set(value)=={"line_id","start","end"}: source_anchors.append(value)
            else:
                for key, child in value.items():
                    if key != "native_witness": collect_source_anchors(child)
        elif isinstance(value,list):
            for child in value: collect_source_anchors(child)
    collect_source_anchors(result["groups"]); collect_source_anchors(result["annotations"])
    for node in result["native_nodes"]: collect_source_anchors(node["spans"])
    splits=[]
    for head,kind,body in parsed:
        if kind=="split": splits.append({"op":"split","id":ident(head,targets),"cuts":body["cuts"],"boxes":body["boxes"]})
    physical=apply_source_operations({"lines":list(units.values()),"order":result["reading_order"],"targets":req["targets"],"operations":splits,"anchors":source_anchors})
    if splits:
        carry_native(list(units.values()),physical["lines"],expansion=physical["expansion"],fragment_ranges=physical["fragment_ranges"])
    units={line["id"]:line for line in physical["lines"]}
    expansion=physical["expansion"]; fragment_ranges=physical["fragment_ranges"]
    normalized={}
    for original,normalizations in result.get("manuscript_edits",{}).items():
        children=expansion[original]
        for child in children: normalized.setdefault(child,[])
        original_end=fragment_ranges[original][1]
        for a,b,replacement in normalizations:
            owners=[child for child in children if fragment_ranges[child][0]<=a<=b<=fragment_ranges[child][1]
                    and (a<b or a<fragment_ranges[child][1] or a==original_end and child==children[-1])]
            require(len(owners)==1,"Source split crosses manuscript normalization; revise its logical edit explicitly")
            child=owners[0]; shift=fragment_ranges[child][0]
            normalized.setdefault(child,[]).append([a-shift,b-shift,replacement])
    result["manuscript_edits"]=normalized
    source_anchor_map={(s["line_id"],s["start"],s["end"]):mapped for s,mapped in zip(source_anchors,physical["anchors"],strict=True)}
    result["reading_order"]=physical["order"]
    for head,kind,body in parsed:
        if kind=="split":
            for n,child in enumerate(expansion[aliases[head]],1):
                aliases[head+f".s{n}"]=child; targets.add(child)
    for head,kind,body in parsed:
        if kind=="text_edit":
            unit=ident(head,targets); require(unit in units and unit not in edits,"Invalid text correction")
            ordered=sorted(body,key=lambda e:e["start"]); previous=-1
            for e in ordered:
                a,b=e["start"],e["end"]; old=units[unit]["text"][a:b]
                require(0<=a<=b<=len(units[unit]["text"]) and a>=previous and old!=e["text"],"Overlapping/out-of-range/no-op text edit")
                if mode=="digitalborn" and old and e["text"]:
                    unchanged=any(a==b for a,b in zip(old,e["text"])) if len(old)==len(e["text"]) else any(m.size for m in difflib.SequenceMatcher(None,old,e["text"],autojunk=False).get_matching_blocks())
                    require(not unchanged,"Digitalborn edit retypes unchanged characters")
                previous=b
            edits[unit]=ordered
        elif kind=="drop":
            unit=ident(head,targets); require(unit in units and unit not in dropped,"Invalid discard")
            other=ident(body["duplicate_of"]) if body["duplicate_of"] is not None else None
            require(other is None or other in units and other!=unit and units[other]["text"]==units[unit]["text"],"Duplicate counterpart differs")
            dropped.add(unit)
    physical_ops=[]
    for head,kind,body in parsed:
        if kind=="drop": physical_ops.append({"op":"drop","id":ident(head,targets),"duplicate_of":ident(body["duplicate_of"]) if body["duplicate_of"] is not None else None})
        elif kind=="insert":
            require(re.fullmatch(r"n[1-9]\d*",head) and head not in aliases,"Invalid insertion alias")
            after=ident(body["after"],targets) if body["after"] is not None else None
            insertion_units={**units,**{op["unit"]["id"]:op["unit"] for op in physical_ops if op["op"]=="insert"}}
            page=insertion_units[after]["page"] if after is not None else req["targets"][0]
            unit=stable_id("insert",[page,head,body]); aliases[head]=unit; targets.add(unit)
            physical_ops.append({"op":"insert","after":after,"unit":{"id":unit,"text":body["text"],"page":page,"box":body["box"],"type":[],"source_id":None,"source_range":None,"original_text":""}})
            if req.get("responsibility")=="source": result["groups"].append({"line_ids":[unit],"kind":"unknown","attributes":{}})
    physical=apply_source_operations({"lines":list(units.values()),"order":result["reading_order"],"targets":req["targets"],"operations":physical_ops})
    if physical_ops:
        carry_native(list(units.values()),physical["lines"],expansion=physical["expansion"],fragment_ranges=physical["fragment_ranges"])
    units={line["id"]:line for line in physical["lines"]}; result["reading_order"]=physical["order"]
    result["manuscript_edits"]={ident:edits for ident,edits in result["manuscript_edits"].items() if ident in units}
    for key,value in physical["fragment_ranges"].items(): fragment_ranges.setdefault(key,value)
    moves=[]
    for refs,kind,body in composer.correction_records(response):
        if kind!="move": continue
        members=[ident(value,targets) for value in refs]
        anchor=ident(body["anchor"],targets)
        require(all(value in units and value not in dropped for value in [*members,anchor]),"Move references discarded source")
        moves.append({"members":members,"anchor":anchor,"placement":body["placement"]})
    if moves:
        from package import move_source_units
        result["reading_order"]=move_source_units(result["reading_order"],moves)
    for i in set(units)-set(expansion):
        box=units[i]["box"]; require(box[0]<=box[2] and box[1]<=box[3],"Invalid unit geometry")
    def remap(value):
        if isinstance(value,list):
            return [piece for item in value for piece in (remap(item) if isinstance(item,dict) and set(item)=={"line_id","start","end"} else [remap(item)])]
        if isinstance(value,dict):
            if set(value)=={"line_id","start","end"}:
                return [span for span in source_anchor_map[(value["line_id"],value["start"],value["end"])] if span["line_id"] in units]
            return {k:remap(v) for k,v in value.items()}
        if isinstance(value,str) and value in expansion:
            return next((i for i in expansion[value] if i in units),None)
        if isinstance(value,str) and "@" in value:
            source,offset=value.rsplit("@",1)
            if source in expansion and offset.isdigit():
                for child in expansion[source]:
                    shift,stop=fragment_ranges[child]
                    if child in units and shift<=int(offset)<stop:
                        return f"{child}@{int(offset)-shift}"
                return None
        return value
    for g in result["groups"]:
        if "spans" in g:
            g["spans"]=remap(g["spans"])
            if g["spans"]: g["id"]=span_anchor(g["spans"][0])
        g["line_ids"]=[j for i in g["line_ids"] for j in expansion.get(i,[i]) if j in units]
        g["attributes"]=remap(g["attributes"])
        g.setdefault("spans",whole(g["line_ids"],units))
    result["groups"]=[g for g in result["groups"] if g["line_ids"]]
    document_ids={a["id"] for a in result["annotations"] if a["kind"]=="document"}
    for a in result["annotations"]:
        document_parent=a["attributes"].get("parent") if a["kind"]=="document" else None
        a["line_ids"]=[j for i in a["line_ids"] for j in expansion.get(i,[i]) if j in units]
        a["spans"]=remap(a.get("spans",[])); a["attributes"]=remap(a["attributes"])
        if document_parent in document_ids: a["attributes"]["parent"]=document_parent
    result["annotations"]=[a for a in result["annotations"] if a["line_ids"]]
    for node in result["native_nodes"]:
        node["spans"]=remap(node["spans"])
        node["line_ids"]=list(dict.fromkeys(span["line_id"] for span in node["spans"]))
    document_ids={a["id"] for a in result["annotations"] if a["kind"]=="document"}
    if req.get("responsibility")=="source":
        group_records=[record for record in response["corrections"] if "group" in record]
        if group_records:
            require(state.get("parser_proposals") is True,"Source-stage regrouping only applies to initial parser proposals")
            from package import compose_structure
            group_request={**req,"lines":units,"groups":result["groups"],"annotations":result["annotations"],
                "reading_order":result["reading_order"],"aliases":aliases,"manuscript_edits":result["manuscript_edits"],
                "native_nodes":result["native_nodes"]}
            prepared=composer.apply(structure,group_request,{"corrections":group_records},apply_annotations=compose_structure)["composition"]
            result["groups"]=prepared["groups"]; result["annotations"]=prepared["annotations"]
            result["native_nodes"]=prepared["removable_nodes"]
    if edits:
        from package import correct_source
        anchors=[]; bindings=[]
        def bind(line,target,kind="annotation",start="start",end="end"):
            if line in edits and line in units:
                anchors.append({"span":{"line_id":line,"start":target[start],"end":target[end]},"kind":kind})
                bindings.append((target,start,end))
        def collect(value):
            if isinstance(value,dict):
                if set(value)=={"line_id","start","end"}: bind(value["line_id"],value)
                else:
                    for key, item in value.items():
                        if key != "native_witness": collect(item)
            elif isinstance(value,list):
                for item in value: collect(item)
        for line,unit in units.items():
            if line in edits and any(unit.get(key) for key in ("spans","words")):
                unit.setdefault("geometry_witness", {"text":unit["text"],"source_id":unit.get("source_id"),
                    "source_range":deepcopy(unit.get("source_range")),"witness_mapping":deepcopy(unit.get("witness_mapping")),
                    **{key:deepcopy(unit[key]) for key in ("spans","words") if key in unit}})
            for key in ("spans","words"):
                # Original extraction retains every witness. Corrected geometry only
                # keeps boundaries that the declared edit maps unambiguously.
                unit[key]=[span for span in unit.get(key,[]) if line not in edits or "start" in span and "end" in span and not any(
                    edit["start"] < span[edge] < edit["end"] or
                    (edit["start"]==edit["end"]==span[edge]) or
                    (not edit["text"] and edit["start"]<=span["start"] and span["end"]<=edit["end"])
                    for edit in edits.get(line,[]) for edge in ("start","end"))]
                for span in unit[key]:
                    if "start" in span and "end" in span: bind(line,span)
            for normalization in result["manuscript_edits"].get(line,[]):
                bind(line,normalization,"normalization",0,1)
        collect(result["groups"]); collect(result["annotations"])
        native_anchors=[span for node in result["native_nodes"] for span in node["spans"]]
        native_before=deepcopy(list(units.values())) if "native_facts" in result else []
        source_edits=[{"line_id":i,**edit,"old":units[i]["text"][edit["start"]:edit["end"]]} for i,changes in edits.items() if i in units for edit in changes]
        correction=correct_source({"lines":{i:unit["text"] for i,unit in units.items()},
            "edits":source_edits,
            "anchors":anchors,"native_anchors":native_anchors,
            "witnesses":{i:unit.get("witness_mapping",[]) for i,unit in units.items()}})
        mapped_native=iter(correction["native_anchors"])
        for node in result["native_nodes"]:
            node["spans"]=[mapped for _ in node["spans"] if (mapped:=next(mapped_native)) is not None]
            node["line_ids"]=list(dict.fromkeys(span["line_id"] for span in node["spans"]))
        boundary_map={}
        for (target,start,end),before,after in zip(bindings,anchors,correction["anchors"],strict=True):
            for key in ("start","end"):
                boundary_map[(before["span"]["line_id"],before["span"][key])]=after[key]
            target[start],target[end]=after["start"],after["end"]
        for ident,text in correction["lines"].items():
            units[ident]["text"]=text
            units[ident]["witness_mapping"]=correction["witnesses"].get(ident,[])
            units[ident]["source_range"]=None
            units[ident]["witness_unresolved"]=units[ident].get("source_id") is not None
            for key in ("spans","words"):
                for span in units[ident].get(key,[]):
                    if "text" in span and "start" in span and "end" in span: span["text"]=text[span["start"]:span["end"]]
        carry_native(native_before,list(units.values()),edits=source_edits)
        def corrected_anchor(value):
            if not isinstance(value,str) or "@" not in value: return value
            line,offset=value.rsplit("@",1)
            if line not in edits or not offset.isdigit(): return value
            require((line,int(offset)) in boundary_map,"Correction cannot preserve an undeclared relationship boundary")
            return f"{line}@{boundary_map[(line,int(offset))]}"
        for group in result["groups"]:
            group["id"]=span_anchor(group["spans"][0])
            for key in ("parent","reading_stream_id"):
                if key in group["attributes"]: group["attributes"][key]=corrected_anchor(group["attributes"][key])
        for annotation in result["annotations"]:
            if annotation["kind"]=="document":
                parent=annotation["attributes"].get("parent")
                annotation["attributes"]["parent"]=parent if parent in document_ids else corrected_anchor(parent)
    result["lines"]=[units[i] for i in result["reading_order"]]
    r={**req,"lines":units,"groups":result["groups"],
       "annotations":result["annotations"],"reading_order":result["reading_order"],"aliases":aliases,
       "manuscript_edits":result["manuscript_edits"],"native_nodes":result["native_nodes"]}
    structural={"corrections":[c for c in response["corrections"] if next(iter(c)) not in {"text","split","insert","drop","move"} and not (req.get("responsibility")=="source" and next(iter(c)) in {"group","remove","clear_continue","clear_resume"})]}
    if req.get("source_locked"): structural["source_defects"]=response["source_defects"]
    def refresh(collection,key,last=False):
        refreshed={}
        for old,link in collection.items():
            if old in expansion:
                sources=expansion[old]
                first=next((i for i in (reversed(sources) if last else sources) if i in units),None)
            else: first=remap(old)
            document_ref=key=="document" and link[key] in document_ids
            other=link[key] if document_ref else remap(link[key])
            if first and other and anchor_line(first,units) in units and (document_ref or anchor_line(other,units) in units):
                refreshed[first]={**link,key:other}
        return refreshed
    result["joins"]=refresh(result["joins"],"next",last=True)
    result["resumes"]=refresh(result["resumes"],"document")
    result["continuations"]={kind:refresh(layer,"next") for kind,layer in result["continuations"].items()}
    if edits:
        for key in ("joins","resumes"):
            field="document" if key=="resumes" else "next"
            result[key]={corrected_anchor(i):{**link,field:link[field] if field=="document" and link[field] in document_ids else corrected_anchor(link[field])} for i,link in result[key].items()}
        result["continuations"]={kind:{corrected_anchor(i):{**link,"next":corrected_anchor(link["next"])} for i,link in layer.items()} for kind,layer in result["continuations"].items()}
    from package import compose_structure
    r.update(joins=result["joins"],continuations=result["continuations"],resumes=result["resumes"])
    result.update(composer.apply(structure,r,structural,apply_annotations=compose_structure)["composition"])
    result["native_nodes"]=result.pop("removable_nodes")
    carry_native(result["lines"],result["lines"],retained_node_ids=[node["id"] for node in result["native_nodes"]])
    if req.get("responsibility")!="source": confirmed_annotations(result,max(req["targets"]))
    if "ocr" in result and req.get("responsibility") == "source":
        ocr.apply(result["ocr"], req, response, aliases, expansion, units)
    result["operations"].append({"request":{"targets":list(req["targets"]),
                                             "aliases_sha256":composer.fingerprint(req["aliases"]),
                                             "annotation_aliases_sha256":composer.fingerprint(req["annotation_aliases"]),
                                             "pages":[p["page"] for p in req["pages"]]},
                                 "response":original_response})
    return result


def confirmed_annotations(state,through=None):
    lines={line["id"]:line for line in state["lines"]}
    for annotation in state["annotations"]:
        if through is not None and lines[annotation["line_ids"][0]]["page"]>through: continue
        attrs=annotation["attributes"]
        if annotation["kind"]=="document": require(isinstance(attrs.get("kind"),str) and attrs["kind"].strip(),"Document kind remains an unconfirmed parser proposal")
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
