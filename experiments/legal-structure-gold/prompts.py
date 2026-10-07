"""Gold-call instructions for the PDF composer's existing correction grammar."""
import json

TASK = """Check the TARGET page in full against its image, extraction and existing
structure. Neighbouring pages are context. Return sparse corrections using the
supplied schema; omit correct decisions. Corrections affect TARGET.

Use source IDs, not copied prose. References identify the affected block or printed extent. Use l1 for a whole line or l1@start-end for a half-open character span;
offsets count Unicode characters. Use precise spans only for partial-line
objects. Basic blocks use whole units. Replace every unit of an affected block
exactly once across replacement blocks. Separate paragraphs remain separate.
Use one of block, heading or numbered for each replacement; these are complete blocks.
Order corrections list every retained TARGET unit once, including new/split units.
Read body columns in printed order, then bottom notes, then page furniture.

Headings and numbered prose/list items name an earlier enclosing parent by its
first source ID. Levels increase below parents. marker covers only printed
numbering. Keep reproduced numbering within its quotation's scope. Distinguish
headings from captions, running titles and table labels using the image and text.

Text edit offsets refer to the supplied unit before edits. Apply splits first,
then edits; annotation offsets refer to corrected text. separator="newline" means a line break. Split a unit crossing a
structural boundary; fragments become l1.s1, l1.s2 and retain adjacency. Fragment
offsets restart at zero. Use boxes=[] when source geometry resolves fragments. Insert genuinely missing
printed lines with n1, n2, ... and an after anchor on TARGET; after=null inserts
before its first unit. Give their boxes in page coordinates scaled to 0..1000,
with a top-left origin. Include inserted lines in blocks. Drop extraction duplicates only
when their printed counterpart is identified; duplicate_of=null means extraction
text absent from the image. Use joins and minimal edits to repair broken words.

Annotations overlap blocks and each other; a field or quotation may occupy a
table cell. Correct existing annotations at the same kind, source ID and start
offset, or remove them by aID. Remove the old annotation when changing its anchor.
Partial previews show only visible members; compose the target fragment. Inspect all tables, fields, notes and quotations,
including ones missing from the baseline.

Tables cover the entire rectangular grid, including blank cells ([]). Merges
are [row,column,row_span,column_span], zero-based; only the top-left cell contains
references, covered cells are null. A line spanning cells needs character spans.
Anchor a table at its first populated cell. Tabular indexes are tables; ordinary
prose columns are not. Fields distinguish labels, values and placeholders;
empty values are []. Field refs cover its label, value and placeholder. Only checkboxes have checked/unchecked state.

Notes include their printed labels; references identify exact referring markers.
Use ownership and context to match reused labels. Instructions headed Notes
remain instruction blocks. Quotations cover reproduced material or speech,
excluding attribution; template prompts and emphasis are not quotations.

Documents start at their first source unit. Keep one enclosing root at the first
unit in corrected reading order. Later constituents name an earlier enclosing
document as parent. Sections are headings.
Use titles, continuity, pagination, typography and geometry together; a pagination
restart alone is insufficient. Titles and facets are source references; use []
for absent facets. Template placeholders do not establish actual parties, dates,
signatures or attachments. Resume names the enclosing document's original start; clear_resume removes it.

Continuations name the first source unit of each fragment. Paragraph, heading
and note continuations join one printed block; never join distinct paragraphs.
Other kinds use separator=null. Different kinds may continue independently from
one anchor. clear_continue removes links involving TARGET at its anchor. Incoming
links can be repaired using the attached context without changing its blocks.
Inherited parents and quotation_id carry document/quotation scope. Preserve
existing remote references; new text references require attached-page evidence."""

DIGITAL = """MODE: digitalborn. Reuse native extraction IDs. Text edits contain only
incorrect characters, with no unchanged prefix or suffix. Add text only when
the image establishes genuinely missing printed text."""

OCR = """MODE: ocr. Check all TARGET text against the image. Reuse correct text
through its IDs; replace wrong spans or whole lines and recover missing lines."""


def prompt(request, mode):
    aliases = {ident: alias for alias, ident in request["aliases"].items()}
    aliases.update({ident:alias for alias,ident in request["annotation_aliases"].items()})
    def encode(value):
        if isinstance(value, dict):
            if set(value) == {"line_id", "start", "end"}:
                return f"{aliases[value['line_id']]}@{value['start']}-{value['end']}"
            return {aliases.get(k,k): encode(v) for k, v in value.items() if k not in {"range", "rendered_range", "marker_range", "content_start", "native", "native_id", "source_range", "original_text"}}
        if isinstance(value, list): return [encode(v) for v in value]
        return aliases.get(value, value) if isinstance(value, str) else value
    visible = {p["page"] for p in request["pages"]}
    visible_ids={i for i,l in request["lines"].items() if l["page"] in visible}
    fonts, styles, lines = {}, [], []
    for ident, line in request["lines"].items():
        if line["page"] not in visible: continue
        style=[]
        for font,size,flags in line.get("type",[]):
            fonts.setdefault(font,len(fonts))
            item=(fonts[font],size,flags)
            if item not in style: style.append(item)
        if style not in styles: styles.append(style)
        lines.append([aliases[ident], line["page"], [round(v,1) for v in line.get("box", [])], styles.index(style), line["text"]])
    groups=[]
    for g in request["groups"]:
        if not any(i in visible_ids for i in g["line_ids"]): continue
        attrs={k:v for k,v in g["attributes"].items() if k in {"level","parent","locator_kind","marker"}}
        groups.append(encode([g["kind"],g["line_ids"]]+([attrs] if attrs else [])))
    existing = {n["id"]: n for n in request["annotations"] + request.get("native_nodes", [])}
    annotations=[]
    for a,ident in request["annotation_aliases"].items():
        n=existing[ident]; ids=[i for i in n.get("line_ids",[]) if i in visible_ids]
        view={"id":a,"kind":n["kind"],"line_ids":ids}
        if n["kind"]=="quotation": view["quotation_id"]=request["quotation_scopes"][ident]
        if "spans" in n:
            spans=[s for s in n["spans"] if s["line_id"] in visible_ids]
            if spans != [{"line_id":i,"start":0,"end":len(request["lines"][i]["text"])} for i in ids]: view["spans"]=spans
        partial=len(ids)!=len(n.get("line_ids",[]))
        if partial: view["partial"]=True
        if "attributes" in n:
            attrs={k:v for k,v in n["attributes"].items() if k in {
                "kind","parent","relationship","title","facets","type","label",
                "value","placeholder","state","references","layout","attribution",
                "rows","header_rows","merges"}}
            if n["kind"]=="table" and partial: attrs={}
            if n["kind"]=="field":
                for key in ("label","value","placeholder"): attrs[key]=[s for s in attrs.get(key,[]) if s["line_id"] in visible_ids]
            if n["kind"]=="note": attrs["label"]=[s for s in attrs.get("label",[]) if s["line_id"] in visible_ids]
            view["attributes"]=attrs
        annotations.append(encode(view))
    data = {"images": [{"slot": i, "page": p["page"], "target": p["page"] in request["targets"]} for i, p in enumerate(request["pages"], 1)],
            "styles": styles, "lines": lines, "groups": groups, "annotations": annotations,
            "inherited_structure": encode({k:v for k,v in request["context"].items() if v})}
    return TASK + "\n\n" + (DIGITAL if mode == "digitalborn" else OCR) + "\nLines: [ID,page,box_0_to_1000,style_index,text]. Styles: [font_ID,size,flags]; flag bits are 1=superscript, 2=italic, 4=serif, 8=monospaced, 16=bold. Groups: [role,IDs,optional_metadata]. Annotation extents default to whole line_ids.\nINPUT:\n" + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
