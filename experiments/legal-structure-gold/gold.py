"""Replay sparse composer corrections and assemble source-anchored gold."""
from collections import Counter
from copy import deepcopy
import difflib
import hashlib
import re
import unicodedata
import composer

VERSION = "legal-structure-gold.v3"
EXTRA = {"text", "split", "insert", "drop", "join", "continue", "resume"}
FURNITURE = {"header", "footer", "page_label"}


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


def line_separator(state, left, right):
    adjacent=left["source_id"] is not None and left["source_id"]==right["source_id"] and left["source_range"][1]==right["source_range"][0]
    return state["joins"].get(left["id"],{}).get("separator","" if adjacent else " ")


def continuations(state):
    return ((ident,link) for layer in state["continuations"].values() for ident,link in layer.items())


def text_links(state):
    links={i:l for i,l in continuations(state) if l["kind"] in {"paragraph","heading"}}
    groups={i:g["line_ids"][0] for g in state["groups"] for i in g["line_ids"]}
    notes={a["line_ids"][0]:a for a in state["annotations"] if a["kind"]=="note"}
    for ident,link in state["continuations"].get("note",{}).items():
        a=notes.get(ident) or next(a for a in notes.values() if ident in a["line_ids"])
        target=link["next"]
        # Exported notes already contain every fragment; raw notes are separate.
        last=a["line_ids"][a["line_ids"].index(target)-1] if target in a["line_ids"] else a["line_ids"][-1]
        first=groups[last]; target=groups[target]
        require(first not in links or (links[first]["next"],links[first]["separator"])==(target,link["separator"]),"Contradictory paragraph/note continuation")
        links[first]={**link,"next":target}
    return links


def logical_annotations(state):
    lines={l["id"]:l for l in state["lines"]}
    positions={i:n for n,i in enumerate(state["reading_order"])}
    annotations=sorted(state["annotations"],key=lambda a:(positions[a["line_ids"][0]],(a.get("spans") or [{}])[0].get("start",0)))
    anchors={(a["kind"],a["line_ids"][0]):a for a in annotations}
    consumed=set(); result=[]
    for a in annotations:
        if a["id"] in consumed: continue
        parts=[a]; current=a; layer=state["continuations"].get(a["kind"],{})
        while current["line_ids"][0] in layer:
            target=layer[current["line_ids"][0]]["next"]
            if (a["kind"],target) not in anchors:
                require(target in a["line_ids"],"Missing continuation fragment")
                break
            current=anchors[(a["kind"],target)]; parts.append(current); consumed.add(current["id"])
        merged={**deepcopy(a),"line_ids":list(dict.fromkeys(i for part in parts for i in part["line_ids"])),
                "spans":[s for part in parts for s in part.get("spans",whole(part["line_ids"],lines))],
                "fragment_ids":[part["id"] for part in parts]}
        attrs=merged["attributes"]
        if a["kind"]=="note": attrs["references"]=[s for part in parts for s in part["attributes"].get("references",[])]
        elif a["kind"]=="quotation": attrs["attribution"]=[s for part in parts for s in part["attributes"].get("attribution",[])]
        elif a["kind"]=="table":
            rows=[]; merges=[]; headers=[]
            for part in parts:
                require(not rows or len(part["attributes"]["rows"][0])==len(rows[0]),"Continued table column counts differ")
                offset=len(rows); rows.extend(part["attributes"]["rows"])
                merges.extend([r+offset,c,h,w] for r,c,h,w in part["attributes"].get("merges",[]))
                headers.extend(r+offset for r in part["attributes"].get("header_rows",[]))
            merged["attributes"]={"rows":rows,"merges":merges,"header_rows":headers}
        result.append(merged)
    return result


def quotations(state,through=None):
    lines={l["id"]:l for l in state["lines"]}
    objects=[a for a in state["annotations"] if a["kind"]=="quotation" and (through is None or lines[a["line_ids"][0]]["page"]<=through)]
    anchors={a["line_ids"][0] for a in objects}
    return logical_annotations({**state,"annotations":objects,
        "continuations":{"quotation":{i:l for i,l in state["continuations"].get("quotation",{}).items() if i in anchors and l["next"] in anchors}}})


def quotation_scope(group,quotes,lines):
    refs=group["attributes"].get("marker") or whole(group["line_ids"],lines)
    matches=[a for a in quotes if all(any(t["line_id"]==s["line_id"] and t["start"]<=s["start"] and s["end"]<=t["end"] for t in a["spans"]) for s in refs)]
    return min(matches,key=lambda a:sum(s["end"]-s["start"] for s in a["spans"]))["id"] if matches else None


def initial(structure, pages):
    lines = composer.source_lines(structure)
    evidence = {a["id"]: a for p in pages for a in p["atoms"]}
    require(set(lines) == set(evidence), "Evidence source-ID coverage differs from native structure")
    for ident, line in lines.items():
        line.update(box=evidence[ident]["bbox"], type=evidence[ident].get("type", []),
                    spans=deepcopy(evidence[ident].get("spans", [])), words=deepcopy(evidence[ident].get("words", [])),
                    original_text=line["text"], source_id=ident, source_range=[0,len(line["text"])])
    nodes = {n["id"]: n for n in structure["nodes"]}
    def depth(node):
        count=1; seen={node["id"]}; parent=nodes.get(node.get("parent_id"))
        while parent and parent["id"] not in seen:
            seen.add(parent["id"])
            if parent["kind"] in {"heading","paragraph","section","list_item"}: count+=1
            parent=nodes.get(parent.get("parent_id"))
        return count
    leaves = [n for n in nodes.values() if n["kind"] in {"paragraph", "prose", "heading", "list_item", "footnote", "endnote"} and n.get("line_ids")]
    priority = {"heading":0, "footnote":1, "endnote":1, "list_item":2, "paragraph":3, "prose":4}
    owners = {}
    for node in sorted(leaves, key=lambda n:(priority[n["kind"]],n["range"]["end"]-n["range"]["start"])):
        for ident in node["line_ids"]:
            if ident in lines: owners.setdefault(ident,node)
    buckets={}
    for ident,line in lines.items():
        native=owners.get(ident)
        buckets.setdefault((native["id"] if native else ident,line["page"]),[]).append(ident)
    groups, consumed = [], set()
    for ident, line in lines.items():
        if ident in consumed: continue
        native = owners.get(ident)
        ids = buckets[(native["id"] if native else ident,line["page"])]
        consumed.update(ids)
        role = native["kind"] if native and native["kind"] in composer.KINDS else "prose"
        attrs = {}
        if native:
            parent = nodes.get(native.get("parent_id"))
            seen=set()
            while parent and parent["id"] not in seen and parent["kind"] not in {"heading","paragraph","section","list_item"}:
                seen.add(parent["id"]); parent=nodes.get(parent.get("parent_id"))
            attrs = {"native_id":native["id"]}
            marker = native.get("marker_range") if native["kind"] not in {"footnote","endnote"} else None
            if not marker and native["kind"] not in {"footnote","endnote"} and native.get("content_start",native["range"]["start"]) > native["range"]["start"]:
                marker = {"start":native["range"]["start"], "end":native["content_start"]}
            if native["kind"] == "heading" or marker:
                attrs.update(level=native.get("level") or depth(native), parent=parent["line_ids"][0] if parent and parent.get("line_ids") else None)
            if marker:
                fragments=[s for s in range_refs(marker,lines,structure) if s["line_id"] in ids]
                if fragments: attrs.update(locator_kind=native.get("locator_kind") or ("paragraph" if native["kind"]=="prose" else native["kind"]), marker=fragments)
                elif native["kind"]!="heading":
                    attrs.pop("parent",None); attrs.pop("level",None)
            if native.get("label"): attrs["label"] = native["label"]
        groups.append({"line_ids":ids,"kind":role,"attributes":attrs})
    annotations = []
    def add(kind, ids, attributes, spans=None, ident=None):
        ids = [i for i in ids if i in lines]
        if ids: annotations.append({"id":ident or stable_id(kind,ids),"kind":kind,"line_ids":ids,
                                    "spans":spans if spans is not None else whole(ids,lines),"attributes":attributes})
    for note in structure.get("notes",[]):
        node = nodes.get(note["node_id"])
        if not node: continue
        label = range_refs(note["label_range"],lines,structure)
        refs = [s for r in note.get("references",[]) for s in range_refs(r["range"],lines,structure)]
        fragments = {}
        for i in node["line_ids"]:
            if i in lines: fragments.setdefault(lines[i]["page"], []).append(i)
        for n, ids in enumerate(fragments.values()):
            add("note",ids,{"kind":note["kind"],"label":[s for s in label if s["line_id"] in ids],
                "references":refs if n == 0 else []},ident=note["id"] if n == 0 else note["id"]+f".part{n+1}")
    for node in nodes.values():
        kind = node["kind"]
        ids = node.get("line_ids",[])
        if kind in {"field","quotation","note","document"}:
            attrs = deepcopy(node.get("attributes",{}))
            if not attrs: attrs = {k:v for k,v in node.items() if k not in {"id","kind","line_ids","range","page_indexes","proof"}}
            add(kind,ids,attrs,ident=node["id"])
        elif kind == "table":
            row_nodes=[n for n in nodes.values() if n["kind"]=="row" and n.get("parent_id")==node["id"]]
            rows=[[] for _ in row_nodes]; merges=[]; headers=[]
            for r,row in enumerate(row_nodes):
                cells=[n for n in nodes.values() if n["kind"]=="cell" and n.get("parent_id")==row["id"]]
                # A parser marks a header row's cells as HTML does, "th".
                if cells and all(cell.get("markup_tag")=="th" for cell in cells): headers.append(r)
                col=0
                for cell in cells:
                    while col<len(rows[r]) and rows[r][col] is None: col+=1
                    height,width=cell.get("row_span") or 1,cell.get("column_span") or 1
                    for rr in range(r,min(r+height,len(rows))):
                        while len(rows[rr])<col+width: rows[rr].append([])
                        for cc in range(col,col+width): rows[rr][cc]=None
                    rows[r][col]=range_refs(cell["range"],lines,structure)
                    if height>1 or width>1: merges.append([r,col,height,width])
                    col+=width
            if rows:
                width=max(map(len,rows))
                for row in rows: row.extend([] for _ in range(width-len(row)))
                members=list(dict.fromkeys(s["line_id"] for row in rows for cell in row if cell for s in cell))
                add("table",members,{"rows":rows,"header_rows":node.get("header_rows") or headers,"merges":merges},
                    spans=[s for row in rows for cell in row if cell for s in cell],ident=node["id"])
    if lines and not any(a["kind"]=="document" for a in annotations):
        ident=next(iter(lines))
        add("document",[ident],{"kind":structure.get("doc_type") or "document","parent":None,
            "relationship":None,"title":[],"facets":{}})
    state={"lines":list(lines.values()),"groups":groups,"annotations":annotations,
           "reading_order":list(lines),"joins":{},"continuations":{},"resumes":{},"operations":[],"removed_nodes":[],
           "native_nodes":[{**deepcopy(n),"line_ids":n.get("line_ids",[])} for n in nodes.values() if n["kind"] not in {"page","paragraph","prose","heading","list_item","footnote","endnote","table","row","cell"}]}
    # Preserve native cross-page grouping as editable baseline continuation.
    by_native={}
    for g in groups:
        if g["attributes"].get("native_id"): by_native.setdefault(g["attributes"]["native_id"],[]).append(g)
    for ident, parts in by_native.items():
        for a,b in zip(parts,parts[1:]):
            kind="note" if nodes[ident]["kind"] in {"footnote","endnote"} else "heading" if nodes[ident]["kind"]=="heading" else "paragraph"
            state["continuations"].setdefault(kind,{})[a["line_ids"][0]]={"next":b["line_ids"][0],"kind":kind,"separator":" "}
    return state


def source_surface(structure, state):
    result=deepcopy(structure); lines={l["id"]:l for l in state["lines"]}; chunks=[]; cursor=0
    for page in (n for n in result["nodes"] if n["kind"]=="page"):
        ids=[i for i in state["reading_order"] if lines[i]["page"]==page["page_indexes"][0]+1]
        content="\n".join(lines[i]["text"] for i in ids)
        page.update(line_ids=ids,range={"start":cursor,"end":cursor+utf16(content)})
        for ident in ids:
            lines[ident]["range"]={"start":cursor,"end":cursor+utf16(lines[ident]["text"])}
            cursor += utf16(lines[ident]["text"])+1
        if not ids: cursor += 1
        chunks.append(content)
    result["text"]="\n".join(chunks)
    return result


def request(structure,pages,targets,state):
    require(len(targets)==1,"Gold requests edit exactly one physical page")
    document_pages={n["page_indexes"][0]+1 for n in structure["nodes"] if n["kind"]=="page"}
    require({p["page"] for p in pages}==document_pages & set(range(targets[0]-1,targets[0]+2)),"Gold evidence must be the exact r=1 page window")
    index={l["id"]:l for l in state["lines"]}
    r={"baseline_hash":composer.fingerprint(structure),"lines":index,"groups":state["groups"],
       "annotations":state["annotations"],"reading_order":state["reading_order"],"pages":pages,
       "targets":targets,"modules":sorted(composer.MODULES),"gold":True,"context":context(state,targets)}
    r["quotation_scopes"]={part:q["id"] for q in quotations(state) for part in q["fragment_ids"]}
    visible={i for i,l in index.items() if l["page"] in {p["page"] for p in pages}}
    known=set(visible)
    metadata_refs=[]
    def retain_refs(value):
        if isinstance(value,dict):
            if set(value)=={"line_id","start","end"}: metadata_refs.append(deepcopy(value))
            for v in value.values(): retain_refs(v)
        elif isinstance(value,list):
            for v in value: retain_refs(v)
        elif isinstance(value,str) and value in index: known.add(value)
    retain_refs(r["context"])
    for g in state["groups"]:
        if g["line_ids"][0] in visible: retain_refs(g["attributes"].get("parent"))
    for a in state["annotations"]:
        if any(i in visible for i in a["line_ids"]):
            for key in ("references","attribution","parent","title","facets"): retain_refs(a["attributes"].get(key))
    r["aliases"]={f"l{i}":ident for i,ident in enumerate(state["reading_order"],1) if ident in known}
    r["annotation_aliases"]={f"a{i}":a["id"] for i,a in enumerate(state["annotations"]+state["native_nodes"],1)
                             if a["id"] not in state["removed_nodes"] and any(i in visible for i in a.get("line_ids",[]))}
    r["metadata_refs"]=metadata_refs
    r["native_nodes"]=[n for n in state["native_nodes"] if n["id"] not in state["removed_nodes"]]
    return structure,r


def context(state,targets):
    lines={l["id"]:l for l in state["lines"]}; order=state["reading_order"]
    visible={i for i,l in lines.items() if abs(l["page"]-targets[0])<=1}
    before=next((n for n,i in enumerate(order) if lines[i]["page"]>=targets[0]-1),len(order))
    docs={a["line_ids"][0]:a for a in state["annotations"] if a["kind"]=="document"}
    stack=[]
    for ident in order[:before]:
        if ident in docs:
            parent=docs[ident]["attributes"]["parent"]
            if parent in stack: stack=stack[:stack.index(parent)+1]
            else: stack=[]
            stack.append(ident)
        resumed=state["resumes"].get(ident,{}).get("document")
        if resumed in stack: stack=stack[:stack.index(resumed)+1]
    groups={g["line_ids"][0]:g for g in state["groups"]}
    quotes=quotations(state)
    quote_scopes={i:quotation_scope(g,quotes,lines) for i,g in groups.items()}
    active_scopes={None}|{q["id"] for q in quotes if any(i in visible for i in q["line_ids"])}
    prefix=order[:before]
    if stack: prefix=prefix[prefix.index(stack[-1]):]
    def chain(first):
        result=[]; seen=set()
        while first in groups and first not in seen:
            seen.add(first); g=groups[first]; attrs=g["attributes"]
            result.append({"id":first,"kind":g["kind"],"quotation_id":quote_scopes[first],**{k:attrs[k] for k in ("level","parent","locator_kind") if k in attrs}})
            first=attrs.get("parent")
        return list(reversed(result))
    inherited=[]
    for scope in sorted(active_scopes,key=lambda s:s or ""):
        headings=next((i for i in reversed(prefix) if i in groups and quote_scopes[i]==scope and groups[i]["kind"]=="heading"),None)
        numbering=next((i for i in reversed(prefix) if i in groups and quote_scopes[i]==scope and groups[i]["attributes"].get("marker")),None)
        inherited+=chain(headings)+chain(numbering)
    for g in state["groups"]:
        if g["line_ids"][0] in visible: inherited+=chain(g["attributes"].get("parent"))
    inherited=list({g["id"]:g for g in inherited if g["id"] not in visible}.values())
    return {"enclosing_documents":[{"id":i,**{k:docs[i]["attributes"][k] for k in ("kind","parent","relationship")}} for i in stack],
            "inherited_blocks":inherited,
            "continuations":{kind:{i:link for i,link in layer.items() if i in visible or lines[link["next"]]["page"] in targets} for kind,layer in state["continuations"].items()},
            "resumes":{i:link for i,link in state["resumes"].items() if i in visible}}


def apply(structure,req,response,state,mode):
    result=deepcopy({k:v for k,v in state.items() if k not in {"operations","native_nodes"}})
    result.update(operations=list(state["operations"]),native_nodes=state["native_nodes"])
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
    for head,kind,body in parsed:
        if kind!="split": continue
        old=ident(head,targets); require(expansion[old]==[old],"Source unit already split")
        cuts=body["cuts"]; require(cuts and cuts==sorted(set(cuts)) and 0<cuts[0]<=cuts[-1]<len(units[old]["text"]),"Invalid split cuts")
        boxes=body["boxes"]; require(not boxes or len(boxes)==len(cuts)+1,"Split box count")
        bounds=[0,*cuts,len(units[old]["text"])]; children=[]
        source_range=units[old]["source_range"]
        original=units[old]["original_text"][source_range[0]:source_range[1]] if source_range else units[old]["text"]
        inverse=[{"start":x,"end":y,"text":original[a:b]} for tag,a,b,x,y in difflib.SequenceMatcher(None,original,units[old]["text"],autojunk=False).get_opcodes() if tag!="equal"]
        for n,(a,b) in enumerate(zip(bounds,bounds[1:]),1):
            child=deepcopy(units[old]); child_id=old+f".s{n}"; children.append(child_id)
            geometry_source=child.get("words") or child.get("spans",[])
            spans=[s for s in geometry_source if "start" in s and "end" in s and a<=s["start"]<s["end"]<=b]
            if any(s.get("start",0)<a<s.get("end",len(child["text"])) or s.get("start",0)<b<s.get("end",len(child["text"])) for s in geometry_source): spans=[]
            box=boxes[n-1] if boxes else [min(s["bbox"][0] for s in spans),min(s["bbox"][1] for s in spans),max(s["bbox"][2] for s in spans),max(s["bbox"][3] for s in spans)] if spans else None
            require(box is not None,"Split needs image boxes when source geometry cannot resolve fragments")
            geometry={key:[{**s,"start":s["start"]-a,"end":s["end"]-a} for s in child.get(key,[])
                           if "start" in s and "end" in s and a<=s["start"]<s["end"]<=b] for key in ("spans","words")}
            child.update(id=child_id,text=child["text"][a:b],source_range=[source_range[0]+changed_offset(a,inverse),source_range[0]+changed_offset(b,inverse,True)] if source_range else None,
                         box=box,**geometry)
            units[child_id]=child; aliases[head+f".s{n}"]=child_id; targets.add(child_id)
            fragment_ranges[child_id]=(a,b)
        del units[old]; expansion[old]=children
    for head,kind,body in parsed:
        if kind=="text":
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
            for e in reversed(ordered): units[unit]["text"]=units[unit]["text"][:e["start"]]+e["text"]+units[unit]["text"][e["end"]:]
        elif kind=="drop":
            unit=ident(head,targets); require(unit in units and unit not in dropped,"Invalid discard")
            other=ident(body["duplicate_of"]) if body["duplicate_of"] is not None else None
            require(other is None or other in units and other!=unit and units[other]["text"]==units[unit]["text"],"Duplicate counterpart differs")
            dropped.add(unit)
    require(all(i in units and units[i]["text"].strip() for i in units if i not in dropped),"Empty retained text")
    result["reading_order"]=[j for i in result["reading_order"] for j in expansion[i] if j not in dropped]
    for head,kind,body in parsed:
        if kind!="insert": continue
        require(re.fullmatch(r"n[1-9]\d*",head) and head not in aliases and body["text"].strip(),"Invalid insertion")
        after=ident(body["after"],targets) if body["after"] is not None else None
        require(after is None or after in result["reading_order"],"Insertion anchor was discarded")
        page=req["targets"][0]
        require(after is None or units[after]["page"]==page,"Insertion anchor is on another page")
        def overlap(a,b):
            return max(a[0],b[0])<min(a[2],b[2]) and max(a[1],b[1])<min(a[3],b[3])
        require(not any(l["page"]==page and overlap(l["box"],body["box"]) and body["text"] in l["text"] for l in units.values()),"Insertion retypes existing source text at its geometry")
        unit=stable_id("insert",[page,head,body]); aliases[head]=unit; targets.add(unit)
        units[unit]={"id":unit,"text":body["text"],"page":page,"box":body["box"],"type":[],"source_id":None,"source_range":None,"original_text":""}
        at=result["reading_order"].index(after)+1 if after else next((n for n,i in enumerate(result["reading_order"]) if units[i]["page"]==page),len(result["reading_order"]))
        result["reading_order"].insert(at,unit)
    for i in dropped: del units[i]
    for i in set(units)-set(expansion):
        box=units[i]["box"]; require(box[0]<=box[2] and box[1]<=box[3],"Invalid unit geometry")
    edge=changed_offset
    for unit_id,changes in edits.items():
        if unit_id not in units: continue
        for key in ("spans","words"):
            for s in units[unit_id].get(key,[]):
                s["start"],s["end"]=edge(s["start"],changes,True),edge(s["end"],changes)
                if "text" in s: s["text"]=units[unit_id]["text"][s["start"]:s["end"]]
    def remap(value):
        if isinstance(value,list):
            return [piece for item in value for piece in (remap(item) if isinstance(item,dict) and set(item)=={"line_id","start","end"} else [remap(item)])]
        if isinstance(value,dict):
            if set(value)=={"line_id","start","end"}:
                out=[]; old=value["line_id"]
                for child in expansion.get(old,[old]):
                    if child not in units: continue
                    shift,stop=fragment_ranges[child]
                    a,b=max(0,value["start"]-shift),min(stop-shift,value["end"]-shift)
                    if a<b:
                        a,b=edge(a,edits.get(child,[])),edge(b,edits.get(child,[]),True)
                        if a<b: out.append({"line_id":child,"start":a,"end":b})
                return out
            return {k:remap(v) for k,v in value.items()}
        if isinstance(value,str) and value in expansion:
            return next((i for i in expansion[value] if i in units),None)
        return value
    for g in result["groups"]:
        g["line_ids"]=[j for i in g["line_ids"] for j in expansion.get(i,[i]) if j in units]
        g["attributes"]=remap(g["attributes"])
    result["groups"]=[g for g in result["groups"] if g["line_ids"]]
    for a in result["annotations"]:
        a["line_ids"]=[j for i in a["line_ids"] for j in expansion.get(i,[i]) if j in units]
        a["spans"]=remap(a.get("spans",[])); a["attributes"]=remap(a["attributes"])
    result["annotations"]=[a for a in result["annotations"] if a["line_ids"]]
    result["lines"]=[units[i] for i in result["reading_order"]]
    r={**req,"lines":units,"groups":result["groups"],
       "annotations":result["annotations"],"reading_order":result["reading_order"],"aliases":aliases}
    structural={"corrections":[c for c in response["corrections"] if next(iter(c)) not in EXTRA|{"clear_continue","clear_resume"}]}
    for head,kind,_ in parsed:
        if kind=="remove":
            ident_to_remove=req["annotation_aliases"].get(head)
            require(ident_to_remove is not None,"Unknown existing annotation")
            if ident_to_remove in {n["id"] for n in result["native_nodes"]}: result["removed_nodes"].append(ident_to_remove)
    product=composer.apply(structure,r,structural)["composition"]
    old_ids={(a["kind"],a["line_ids"][0],(a.get("spans") or [{}])[0].get("start",0)):a["id"] for a in result["annotations"]}
    for a in product["annotations"]:
        key=(a["kind"],a["line_ids"][0],(a.get("spans") or [{}])[0].get("start",0))
        a["id"]=a.get("id") or old_ids.get(key) or stable_id(a["kind"],key)
    result.update(product)
    def refresh(collection,key,last=False):
        refreshed={}
        for old,link in collection.items():
            sources=expansion.get(old,[old])
            first=next((i for i in (reversed(sources) if last else sources) if i in units),None)
            other=next((i for i in expansion.get(link[key],[link[key]]) if i in units),None)
            if first and other: refreshed[first]={**link,key:other}
        return refreshed
    result["joins"]=refresh(result["joins"],"next",last=True)
    result["resumes"]=refresh(result["resumes"],"document")
    result["continuations"]={kind:refresh(layer,"next") for kind,layer in result["continuations"].items()}
    for head,kind,body in parsed:
        if kind not in {"join","continue","resume"}: continue
        first=ident(head); require(first in units,"Relationship source was discarded")
        if kind=="continue" and body is None:
            affected=[layer for layer in result["continuations"].values() if first in layer and (first in targets or layer[first]["next"] in targets)]
            require(first in targets or affected,"Continuation removal outside TARGET")
            for layer in affected: layer.pop(first,None)
            continue
        if body is None:
            require(kind=="resume" and first in targets,"Relationship removal outside TARGET or missing metadata")
            result["resumes"].pop(first,None); continue
        value=deepcopy(body); key="document" if kind=="resume" else "next"; value[key]=ident(value[key])
        require(first in targets or kind=="continue" and value["next"] in targets and units[first]["page"] in {p["page"] for p in req["pages"]},"Relationship outside TARGET")
        collection=result["continuations"].setdefault(body["kind"],{}) if kind=="continue" else result["joins" if kind=="join" else "resumes"]
        if kind!="resume" and units[value[key]]["page"] not in {p["page"] for p in req["pages"]}:
            require(value==collection.get(first),"A new continuation must use evidence within r=1")
        collection[first]=value
    try:
        complete(result,through=req["targets"][0]); ownership(result,through=req["targets"][0])
    except ValueError as exc:
        message=str(exc)
        for alias,source in req["aliases"].items(): message=message.replace(source,alias)
        raise ValueError(message) from None
    result["operations"].append({"request":{"targets":list(req["targets"]),
                                             "aliases_sha256":composer.fingerprint(req["aliases"]),
                                             "annotation_aliases_sha256":composer.fingerprint(req["annotation_aliases"]),
                                             "pages":[p["page"] for p in req["pages"]]},
                                 "response":original_response})
    return result


def complete(state,through=None):
    lines={l["id"]:l for l in state["lines"]}; order=state["reading_order"]; pos={i:n for n,i in enumerate(order)}
    observed={i for i,l in lines.items() if through is None or l["page"]<=through}
    require(len(order)==len(lines) and set(order)==set(lines),"Invalid source partition")
    require(Counter(i for g in state["groups"] for i in g["line_ids"])==Counter(order),"Groups lost or duplicated source units")
    for g in state["groups"]:
        if g["line_ids"][0] not in observed: continue
        positions=[pos[i] for i in g["line_ids"]]
        require(positions==list(range(positions[0],positions[0]+len(positions))),"Block units are interleaved in reading order")
        require(len({lines[i]["page"] for i in g["line_ids"]})==1,"Primary blocks are page fragments; link continuations across pages")
    groups={g["line_ids"][0]:g for g in state["groups"]}; annotations=state["annotations"]
    require(all(g["kind"] in composer.KINDS-{"unknown"} for i,g in groups.items() if i in observed),"Every retained block needs a printed role")
    headings={i:g for i,g in groups.items() if g["kind"]=="heading" or g["attributes"].get("marker")}
    for ident,g in headings.items():
        if ident not in observed: continue
        parent=g["attributes"].get("parent")
        require(parent is None or parent in headings and pos[parent]<pos[ident] and headings[parent]["attributes"].get("level",1)<g["attributes"].get("level",1),f"Block {ident} level {g['attributes'].get('level',1)} has invalid parent {parent}; parent must be earlier with a smaller level")
    incoming=set()
    for ident,link in continuations(state):
        if ident not in observed: continue
        target=link["next"]; kind=link["kind"]
        require(kind in {"paragraph","heading","note","table","quotation","list"} and ident in pos and target in pos and pos[ident]<pos[target] and (kind,target) not in incoming,"Invalid or branching continuation")
        incoming.add((kind,target))
        require(link["separator"] in (""," ","\n") if kind in {"paragraph","heading","note"} else link["separator"] is None,"Invalid continuation separator")
        anchors=[ident,target] if target in observed else [ident]
        if kind in {"paragraph","heading","list"}:
            require(all(i in groups for i in anchors),"Continuation must start a block")
            if kind=="heading": require(all(groups[i]["kind"]=="heading" for i in anchors),"Heading continuation requires heading fragments")
            else: require(all(groups[i]["kind"] not in FURNITURE|{"heading"} for i in anchors),"Continuation requires paragraph fragments")
        else:
            parts=[[a for a in annotations if a["kind"]==kind and a["line_ids"][0]==i] for i in anchors]
            require(all(len(p)==1 for p in parts),"Continuation requires one object at each anchor; split shared anchors first")
            if kind=="table" and len(parts)==2: require(len(parts[0][0]["attributes"]["rows"][0])==len(parts[1][0]["attributes"]["rows"][0]),"Continued table column counts differ")
    for ident,join in state["joins"].items():
        require(join["separator"] in (""," ","\n"),"Join separator must be empty, a space, or a newline")
        require(any(any(a==ident and b==join["next"] for a,b in zip(g["line_ids"],g["line_ids"][1:])) for g in groups.values()),"Join does not connect adjacent block units")
    for a in annotations:
        if a["line_ids"][0] not in observed: continue
        require(a["line_ids"] and set(a["line_ids"])<=set(lines),f"Annotation {a['id']} lost source identity")
        extent=a.get("spans",whole(a["line_ids"],lines))
        def check_spans(spans,contained=False):
            for s in spans:
                require(set(s)=={"line_id","start","end"} and s["line_id"] in lines and type(s["start"])is int and type(s["end"])is int and
                        0<=s["start"]<s["end"]<=len(lines[s["line_id"]]["text"]),f"Annotation {a['id']} offset outside corrected source")
                require(not contained or any(t["line_id"]==s["line_id"] and t["start"]<=s["start"] and s["end"]<=t["end"] for t in extent),f"{a['kind']} refs exclude {s['line_id']}@{s['start']}-{s['end']}; include all its parts in refs")
        check_spans(extent)
        require(set(s["line_id"] for s in extent)==set(a["line_ids"]),"Annotation extent differs from source membership")
        attrs=a["attributes"]
        if a["kind"]=="field":
            for k in ("label","value","placeholder"): check_spans(attrs.get(k,[]),True)
        if a["kind"]=="quotation": check_spans(attrs.get("attribution",[]))
        if a["kind"]=="note":
            check_spans(attrs.get("label",[]),True); check_spans(attrs.get("references",[]))
            def marker(spans):
                text="".join(lines[s["line_id"]]["text"][s["start"]:s["end"]] for s in spans)
                return unicodedata.normalize("NFKC",text).strip(" .()[]{}:")
            label=marker(attrs.get("label",[]))
            for ref in attrs.get("references",[]):
                if ref["line_id"] not in observed or any(s["line_id"] not in observed for s in attrs.get("label",[])): continue
                require(label and marker([ref])==label,f"Note {a['id']} reference at {ref['line_id']} does not name its printed label")
            require(not any(g["kind"]=="instruction" and set(g["line_ids"])&set(a["line_ids"]) for g in groups.values()),"Printed instruction is classified as a note")
    return True


def ownership(state,through=None):
    lines={l["id"]:l for l in state["lines"]}
    order=[i for i in state["reading_order"] if through is None or lines[i]["page"]<=through]; pos={i:n for n,i in enumerate(order)}
    docs=sorted((a for a in state["annotations"] if a["kind"]=="document" and a["line_ids"][0] in pos),key=lambda a:pos[a["line_ids"][0]])
    require(not order or docs,"Missing root document")
    if not order: return {},[]
    starts={a["line_ids"][0]:a for a in docs}
    require(len(starts)==len(docs) and pos[docs[0]["line_ids"][0]]==0 and docs[0]["attributes"]["parent"] is None and sum(a["attributes"]["parent"] is None for a in docs)==1,f"Exactly one parent=null document must start at {order[0]}, the first corrected reading-order unit. Remove the old root annotation if moving its anchor")
    owners={}; stack=[docs[0]["line_ids"][0]]
    for ident in order:
        if ident in starts and ident!=stack[0]:
            parent=starts[ident]["attributes"]["parent"]
            require(parent in stack and pos[parent]<pos[ident],"Invalid constituent nesting")
            while stack[-1]!=parent: stack.pop()
            stack.append(ident)
        if ident in state["resumes"]:
            target=state["resumes"][ident]["document"]
            require(target in stack,"Resumption must name an enclosing document")
            while stack[-1]!=target: stack.pop()
        owners[ident]=starts[stack[-1]]["id"]
    for a in state["annotations"]:
        if a["kind"]=="note" and a["line_ids"][0] in pos:
            for ref in a["attributes"].get("references",[]):
                if through is not None and ref["line_id"] not in pos: continue
                require(ref["line_id"] in owners and owners[ref["line_id"]]==owners[a["line_ids"][0]],"Note reference crosses constituent ownership")
    for ident,link in continuations(state):
        if through is not None and (ident not in pos or link["next"] not in pos): continue
        require(owners[ident]==owners[link["next"]],"Continuation crosses constituent ownership")
    quotes=quotations(state,through)
    groups={g["line_ids"][0]:g for g in state["groups"] if g["line_ids"][0] in pos}
    for ident,g in groups.items():
        parent=g["attributes"].get("parent")
        if parent:
            require(owners[ident]==owners[parent] and quotation_scope(g,quotes,lines)==quotation_scope(groups[parent],quotes,lines),f"Heading/numbering at {ident} crosses its document or quotation scope")
    return owners,docs


def materialize(structure,state,provenance):
    complete(state); owners,docs=ownership(state)
    surface=source_surface(structure,state); units={l["id"]:l for l in state["lines"]}
    positions={i:n for n,i in enumerate(state["reading_order"])}
    groups=sorted(state["groups"],key=lambda g:positions[g["line_ids"][0]])
    by_first={g["line_ids"][0]:g for g in groups}
    links=text_links(state)
    rendered=[]; cursor=0; rendered_lines={}; logical=[]; emitted=set()
    for g in groups:
        first=g["line_ids"][0]
        if first in emitted: continue
        if rendered: rendered.append("\n\n"); cursor+=2
        start=cursor; members=[]; parts=[]; current=first
        while True:
            part=by_first[current]; parts.append(part); emitted.add(current)
            for n,ident in enumerate(part["line_ids"]):
                if n:
                    join=line_separator(state,units[part["line_ids"][n-1]],units[ident])
                    rendered.append(join); cursor+=utf16(join)
                begin=cursor; rendered.append(units[ident]["text"]); cursor+=utf16(units[ident]["text"])
                rendered_lines[ident]={"start":begin,"end":cursor}; members.append(ident)
            if current not in links: break
            link=links[current]; require(link["next"] in by_first,"Text continuation does not begin a block")
            rendered.append(link["separator"]); cursor+=utf16(link["separator"]); current=link["next"]
        logical.append({**g,"line_ids":members,"parts":parts,"rendered_range":{"start":start,"end":cursor}})
    def project(value):
        if isinstance(value,dict):
            if set(value)=={"line_id","start","end"}:
                ident=value["line_id"]; line=units[ident]; a,b=value["start"],value["end"]
                require(0<=a<b<=len(line["text"]),"Final annotation offset outside corrected text")
                return {"line_id":ident,"page_index":line["page"]-1,
                    "range":{"start":line["range"]["start"]+utf16(line["text"][:a]),"end":line["range"]["start"]+utf16(line["text"][:b])},
                    "rendered_range":{"start":rendered_lines[ident]["start"]+utf16(line["text"][:a]),"end":rendered_lines[ident]["start"]+utf16(line["text"][:b])}}
            return {k:project(v) for k,v in value.items()}
        if isinstance(value,list): return [project(v) for v in value]
        return value
    def bounds(spans,fallback=0):
        return {"start":min((s["range"]["start"] for s in spans),default=fallback),"end":max((s["range"]["end"] for s in spans),default=fallback)}
    def node(ident,kind,ids,spans=None,**fields):
        precise=project(spans if spans is not None else whole(ids,units))
        return {"id":ident,"kind":kind,"range":bounds(precise),"ranges":[s["range"] for s in precise],
            "origin_id":(structure.get("origins") or [{}])[0].get("id","source"),"source":"model",
            "line_ids":list(dict.fromkeys(ids)),"page_indexes":sorted({units[i]["page"]-1 for i in ids}),
            "document_id":owners[ids[0]] if ids else None,"parent_id":None,**fields}
    nodes=[]; group_nodes={}; native_counts=Counter(g["attributes"].get("native_id") for g in logical)
    for g in logical:
        attrs=g["attributes"]; role=g["kind"]
        kind="heading" if role=="heading" else "list_item" if role=="list_item" else attrs.get("locator_kind","prose")
        if kind not in {"prose","heading","paragraph","section","list_item"}: kind="prose"
        ident=attrs.get("native_id") or stable_id("block",g["line_ids"])
        if native_counts[attrs.get("native_id")]>1 or ident in {a["id"] for a in state["annotations"]}: ident=stable_id("block",g["line_ids"])
        n=node(ident,kind,g["line_ids"],rendered_range=g["rendered_range"],role=role,level=attrs.get("level"))
        if attrs.get("marker"):
            markers=project(attrs["marker"]); n.update(marker_range=bounds(markers),marker_spans=markers,
                label=attrs.get("label") or "".join(units[s["line_id"]]["text"][s["start"]:s["end"]] for s in attrs["marker"]),locator_kind=kind)
        for part in g["parts"]: group_nodes[part["line_ids"][0]]=ident
        nodes.append(n)
    for n,g in zip(nodes,logical):
        parent=g["attributes"].get("parent")
        if parent: n["parent_id"]=group_nodes[parent]
    exported=[]; notes=[]
    for a in logical_annotations(state):
        ids=a["line_ids"]; spans=a["spans"]
        merged={**a,"document_id":owners[ids[0]]}
        if a["kind"]=="note":
            attrs=a["attributes"]
            label=project(attrs.get("label",[])); bodies=[]
            for s in spans:
                pieces=[(s["start"],s["end"])]
                for marker in attrs.get("label",[]):
                    if marker["line_id"]==s["line_id"]:
                        pieces=[p for lo,hi in pieces for p in ((lo,min(hi,marker["start"])),(max(lo,marker["end"]),hi)) if p[0]<p[1]]
                bodies.extend({"line_id":s["line_id"],"start":lo,"end":hi} for lo,hi in pieces)
            body=project(bodies); kind=attrs["kind"]
            if kind in {"footnote","endnote"}:
                n=node(a["id"],kind,ids,spans,role=kind,label="".join(units[s["line_id"]]["text"][s["start"]:s["end"]] for s in attrs.get("label",[])))
                n["rendered_range"]=bounds([{**s,"range":s["rendered_range"]} for s in project(spans)])
                nodes.append(n)
                references=[{**s,"line_ids":[s["line_id"]],"page_indexes":[s["page_index"]]} for s in project(attrs["references"])]
                notes.append({"id":a["id"],"node_id":a["id"],"kind":kind,"label_range":bounds(label,n["range"]["start"]),
                    "body_range":bounds(body,n["range"]["start"]),"label_spans":label,"body_spans":body,
                    "references":references,"primary_reference":references[0]["range"] if references else None})
        elif a["kind"]=="table":
            rows=a["attributes"]["rows"]; merges=a["attributes"]["merges"]; headers=a["attributes"]["header_rows"]
            table=node(a["id"],"table",ids,spans,row_count=len(rows),column_count=len(rows[0]),merges=merges,header_rows=headers)
            nodes.append(table)
            for r,row in enumerate(rows):
                row_id=a["id"]+f".row{r+1}"; cell_ids=[]; row_spans=[]
                for c,cell in enumerate(row):
                    if cell is None: continue
                    cell_id=row_id+f".cell{c+1}"; cell_ids.append(cell_id); row_spans.extend(cell)
                    members=list(dict.fromkeys(s["line_id"] for s in cell))
                    merged_cell=next((m for m in merges if m[:2]==[r,c]),[r,c,1,1])
                    cell_node=node(cell_id,"cell",members,cell,parent_id=row_id,row=r,column=c,row_span=merged_cell[2],column_span=merged_cell[3],blank=not cell)
                    if not cell: cell_node.update(range={"start":table["range"]["start"],"end":table["range"]["start"]},document_id=table["document_id"],page_indexes=table["page_indexes"])
                    nodes.append(cell_node)
                row_node=node(row_id,"row",list(dict.fromkeys(s["line_id"] for s in row_spans)),row_spans,parent_id=a["id"],cell_ids=cell_ids)
                if not row_spans: row_node.update(range={"start":table["range"]["start"],"end":table["range"]["start"]},document_id=table["document_id"],page_indexes=table["page_indexes"])
                nodes.append(row_node)
        exported.append(project(merged))
    quoted=[a for a in exported if a["kind"]=="quotation"]
    for n in nodes:
        refs=n.get("marker_spans") or project(whole(n["line_ids"],units))
        matches=[a for a in quoted if refs and all(any(t["line_id"]==s["line_id"] and t["range"]["start"]<=s["range"]["start"] and s["range"]["end"]<=t["range"]["end"] for t in a["spans"]) for s in refs)]
        n["container_id"]=min(matches,key=lambda a:len(a["line_ids"]))["id"] if matches and n["line_ids"] else None
    doc_starts={a["line_ids"][0]:a["id"] for a in docs}; document_rows=[]
    for a in docs:
        descendants={a["id"]}
        while True:
            more={d["id"] for d in docs if doc_starts.get(d["attributes"]["parent"]) in descendants}
            if more<=descendants: break
            descendants|=more
        owned=[i for i in state["reading_order"] if owners[i] in descendants]
        document_rows.append({**project(a),"parent_id":doc_starts.get(a["attributes"]["parent"]),
            "owned_line_ids":[i for i in owned if owners[i]==a["id"]],"line_ids":owned,
            "ranges":[units[i]["range"] for i in owned],"page_indexes":sorted({units[i]["page"]-1 for i in owned})})
    pages=[n for n in surface["nodes"] if n["kind"]=="page"]
    for page in pages:
        page["source"]="model"; page["rendered_ranges"]=[rendered_lines[i] for i in page["line_ids"]]
    original=composer.source_lines(structure)
    def map_range(value):
        refs=range_refs(value,original,structure); mapped=[]
        for ref in refs:
            for line in units.values():
                if line["source_id"]!=ref["line_id"]: continue
                lo,hi=line["source_range"]; a,b=max(lo,ref["start"]),min(hi,ref["end"])
                if a>=b: continue
                old=original[ref["line_id"]]["text"][lo:hi]
                changes=[{"start":x,"end":y,"text":line["text"][u:v]} for tag,x,y,u,v in difflib.SequenceMatcher(None,old,line["text"],autojunk=False).get_opcodes() if tag!="equal"]
                x,y=changed_offset(a-lo,changes),changed_offset(b-lo,changes,True)
                if x<y: mapped.append(project({"line_id":line["id"],"start":x,"end":y}))
        return bounds(mapped)
    def remap_native(value):
        if isinstance(value,dict):
            if set(value)=={"start","end"}: return map_range(value)
            return {k:remap_native(v) for k,v in value.items()}
        if isinstance(value,list): return [remap_native(v) for v in value]
        return value
    retained=[]
    generated_ids={n["id"] for n in nodes}
    for n in state["native_nodes"]:
        if n["id"] in state["removed_nodes"] or n["id"] in generated_ids: continue
        n=remap_native(n); n["line_ids"]=[i for i in state["reading_order"] if units[i]["source_id"] in n.get("line_ids",[])]
        if not n["line_ids"] and any(v["id"]==n["id"] and v.get("line_ids") for v in state["native_nodes"]): continue
        if n.get("parent_id") not in generated_ids|{v["id"] for v in state["native_nodes"] if v["id"] not in state["removed_nodes"]}: n["parent_id"]=None
        retained.append(n)
    document={**remap_native({k:v for k,v in surface.items() if k not in {"text","nodes","notes"}}),"text":surface["text"],
        "nodes":pages+nodes+retained,"notes":notes,"annotations":exported,"documents":document_rows,
        "text_sha256":hashlib.sha256(surface["text"].encode()).hexdigest(),"rendered_text":"".join(rendered)}
    document["revision"]=hashlib.sha256(document["rendered_text"].encode()).hexdigest()
    exported_ids={n["id"] for n in document["nodes"]}
    require(len(exported_ids)==len(document["nodes"]),"Export duplicated a node ID")
    require(all(n.get("parent_id") is None or n["parent_id"] in exported_ids for n in document["nodes"]),"Export has an absent parent")
    trace=[{**{k:v for k,v in l.items() if k not in {"type","spans","words"}},"rendered_range":rendered_lines[l["id"]]} for l in state["lines"]]
    return document["rendered_text"],{"schema_version":VERSION,"source_sha256":structure["source_sha256"],
        "offset_unit":"utf16","source_character_unit":"unicode_scalar","coordinates":"visible-page-top-left-1000","structure":document,
        "source_trace":trace,"reading_order":state["reading_order"],"blocks":state["groups"],
        "joins":state["joins"],"continuations":state["continuations"],"resumes":state["resumes"],"operations":state["operations"],"provenance":provenance}
