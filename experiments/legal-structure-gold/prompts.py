"""Gold-call instructions for the PDF composer's existing correction grammar."""
import json

TASK = """Check every block in the TARGET pages in full against its image, extraction and existing
structure. Neighbouring pages are context. Return sparse corrections using the
supplied schema; omit correct decisions. Corrections affect TARGET. Ordinary unmarked text is included and may be promoted.

Retain the corrected source exactly, including printed spelling, punctuation and hyphens.

Use source IDs, not copied prose. References identify the affected block or printed extent. Use l1 for a whole line or l1@start-end for a half-open character span;
offsets count Unicode characters. Use precise spans only for partial-line
objects and structural blocks beginning inside a line. Replace every character of an affected block
exactly once across replacement blocks. Distinct spans on the same line remain distinct blocks.
A structural boundary does not require splitting its physical extraction line. Separate paragraphs remain separate.
Use one of block, heading or numbered for each replacement; these are complete blocks.
Every block includes reading_stream_id: null for unpartitioned reading, or a source
reference to the first block in its parallel reading stream. That first block
names itself. A stream stays within one document and may resume across quotations; preserve
existing stream separation unless the printed evidence requires a correction.
Roles are text, heading, caption, instruction, headnote, marginal_note, furniture
and page_label. Text is ordinary substantive content. Lists use text with
locator_kind=list_item; keep unnumbered lists with marker=[]. Printed paragraph
and provision markers use paragraph and section locators. Levels are derived.
Captions identify proceedings and parties; ordinary document titles are anchored
to their document annotation. Headings organize content; major agenda divisions
are headings, leaf entries are text/list items. Instructions concern completing
or using forms; operative orders are text. Editorial summaries/catchwords are
headnotes; court-authored summaries are text. Marginal notes are substantive
glosses; stamps and archival identifiers are text. Running headers/footers are
furniture. Contents entries link to real body targets and are not body headings.
Keep the supplied physical reading order.

Every complete structural block names its enclosing parent by source ID, or
explicit null for a root. Parent is explicit, including null for a root within its document/quotation scope. marker covers only printed
numbering. Keep reproduced numbering within its quotation's scope. Distinguish
headings from captions, running titles and table labels using the image and text.
A statute's marginal notes and a reported case's headnotes are not headings: give them the
marginal_note and headnote roles.

Annotation offsets refer to the supplied corrected text. For text continuations,
separator="newline" means a line break and "paragraph_break" means two newlines.

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

For footnote, endnote, sidenote, table_note and author_note, refs cover the exact
printed label and body, including discontinuous fragments. label contains only
the printed marker within refs; the body is refs excluding label. references
identify only exact referring markers in the main text, not whole lines. Supply
both arrays explicitly: label=[] for an unlabelled note, references=[] when no
matching marker is evidenced. Do not invent a label or reference.
Use ownership and context to match reused labels. Instructions headed Notes
remain instruction blocks. Quotations cover reproduced material or speech,
excluding attribution; template prompts and emphasis are not quotations.

Documents start at their first source unit. Keep one enclosing root at the first
unit in corrected reading order. Constituents name their enclosing
document as parent; nested documents may share the same source opening. Sections are headings.
For document parent/resume references, use the supplied annotation ID. A source
opening is valid only when it identifies one document. Edit coincident document
declarations using their distinct identities. Every document body includes id:
its existing aN alias, or a fresh response-local dN. Parent/resume references may
use dN declared in the same response; refs still supplies the exact source opening.
Use titles, continuity, pagination, typography and geometry together; a pagination
restart alone is insufficient. Titles and facets are source references; use []
for absent facets. Template placeholders do not establish actual parties, dates,
signatures or attachments. Resume names the enclosing document identity; clear_resume removes it.

Continuations name the first source unit of each fragment. Paragraph, heading
and note continuations join one printed block; never join distinct paragraphs.
Inherited pending text continuations retain known object identity but have no established
separator. Resolve each due seam when its target is authored: continue with an explicit
literal separator, or clear_continue when the source disproves continuity. Do not guess;
future seams may remain pending.
Other kinds use separator=null. Different kinds may continue independently from
one anchor. continuation_candidates carries the last earlier object of each kind
in active or enclosing scopes, including suspended streams. These are alternatives,
not asserted links; establish continuity from their anchored content and TARGET
before linking them. clear_continue removes links involving TARGET at its anchor. Incoming
links can be repaired using the attached context without changing its blocks.
The enclosing scopes and document-wide navigation are addressable context, not editable target blocks.
Inherited parents and quotation_id carry document/quotation scope. Preserve
existing remote references; new text references require attached-page evidence."""

DIGITAL = """MODE: digitalborn. Reuse native extraction IDs. Text edits contain only
incorrect characters, with no unchanged prefix or suffix. Add text only when
the image establishes genuinely missing printed text."""

OCR = """MODE: ocr. Check all TARGET text against the image. Reuse correct text
through its IDs; replace wrong spans or whole lines and recover missing lines."""

PHYSICAL = """Check the physical OCR annotations on TARGET against the original image.
OCR lines are printed rows; legal fields and paragraphs may occupy part of a row.
Preserve correct baselines and polygons. In ocr.lines and ocr.regions return only
objects needing replacement, using their physical IDs. New IDs are o_new1,...
and r_new1,... . members reference corrected text through lIDs, split lIDs or nIDs;
keep physical IDs in region line_ids. Text is shared with the legal annotations.
Recover missing lines with legal insert corrections and OCR geometry together.
Use page coordinates 0..1000, top-left origin. Follow curved/skewed printed rows;
never manufacture a baseline from a bounding box. Region polygons cover actual
visual regions, including nontext regions without lines. Use the exact supplied
ontology labels. PPDoc proposals are evidence to correct. Drop absent/duplicate
physical objects explicitly. List every retained physical object once when
changing line_order or region_order; [] preserves the existing order.
Set recognition, segmentation, regions and reading_order coverage independently:
complete means the whole page was checked and all targets are present; partial
means only some targets are annotated; unannotated means no gold for that task.
Empty complete pages are explicit negative examples. Do not mark uncertain or
missing geometry complete. Printed rules and blank placeholders are not repeated
underscore characters unless separate underscore glyphs are visible. Preserve
visible checkbox glyphs and meaningful dates, addresses and contact details."""


SOURCE_TASK = """Correct the source content on TARGET against its page image. Return sparse
text, split, insert, drop, group, move, join, remove, clear_continue and
clear_resume corrections only. Group refs
into complete blocks without assigning a semantic role. Preserve printed spelling,
punctuation, hyphens and unreadable blackouts. Reuse correct text by source ID;
recover genuinely missing text with image geometry. Offsets count Unicode scalar
characters. Split before editing; split fragments use .s1, .s2 with local offsets.
If a text correction crosses a parser proposal's marker or other semantic anchor,
explicitly remove that annotation by its a-ID; for a block proposal, group all its
current spans to reset its semantic metadata. Annotation removals apply before source splitting; groups apply after splitting
and before text edits, using pre-edit fragment offsets. The later structural
job must examine all corrected blocks and annotate the printed objects anew.
Clear obsolete continuation or resumption links by their source anchor with
clear_continue or clear_resume; these removals also precede splitting and text
edits. Do not remove correct unaffected proposals. Do not decide legal roles, outline
parents or document ownership in this job.
Neighbouring pages provide reading context. An insertion after=null is before the
first target line. A drop identifies duplicate_of or null for extraction absent
from the image. Move selected refs before or after a target anchor; unchanged units keep their
relative order. Logical joins preserve the
physical printed text and specify their separator independently."""


def prompt(request, mode):
    if request.get("responsibility") != "source":
        from gold import composer
        composer.require_authorable_blocks(request["groups"],request["lines"],request["targets"])
    aliases = {ident: alias for alias, ident in request["aliases"].items()}
    aliases.update({ident:alias for alias,ident in request["annotation_aliases"].items()})
    def encode(value):
        if isinstance(value, dict):
            if set(value) == {"line_id", "start", "end"}:
                return f"{aliases[value['line_id']]}@{value['start']}-{value['end']}"
            return {aliases.get(k,k): encode(v) for k, v in value.items() if k not in {"range", "rendered_range", "marker_range", "content_start", "native", "native_id", "source_range", "original_text"}}
        if isinstance(value, list): return [encode(v) for v in value]
        if isinstance(value,str):
            if value in aliases: return aliases[value]
            if "@" in value:
                line,start=value.rsplit("@",1)
                if line in aliases and start.isdigit(): return f"{aliases[line]}@{start}-{int(start)+1}"
        return value
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
        attrs={k:v for k,v in g["attributes"].items() if k in {"parent","locator_kind","marker","document_id","quotation_id","reading_stream_id"}}
        groups.append(encode([g["kind"],g.get("spans") or g["line_ids"]]+([attrs] if attrs else [])))
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
                "rows","header_rows","merges","target","witness_id"}}
            if n["kind"]=="table" and partial: attrs={}
            if n["kind"]=="field":
                for key in ("label","value","placeholder"): attrs[key]=[s for s in attrs.get(key,[]) if s["line_id"] in visible_ids]
            if n["kind"]=="note": attrs["label"]=[s for s in attrs.get("label",[]) if s["line_id"] in visible_ids]
            view["attributes"]=attrs
        annotations.append(encode(view))
    data = {"images": [{"slot": i, "page": p["page"], "target": p["page"] in request["targets"]} for i, p in enumerate(request["pages"], 1)],
            "styles": styles, "lines": lines, "groups": groups, "annotations": annotations,
            "inherited_structure": encode({k:v for k,v in request["context"].items() if v})}
    if request.get("structure_tags"):
        data["native_structure_tags"] = {"coordinates":"original_source_utf16",
            "witnesses":[tag for tag in request["structure_tags"] if tag["page_index"]+1 in visible]}
    if request.get("native_navigation"):
        data["native_navigation"] = request["native_navigation"]
    if "ocr" in request and request.get("responsibility") == "source":
        data["ocr"] = json.loads(json.dumps(request["ocr"]))
        for page in data["ocr"]["pages"]:
            page.pop("provenance", None)
            for line in page["lines"]:
                line["members"] = [aliases[i] for i in line.get("members", [line["id"]])]
        instructions = "\n\n" + PHYSICAL
    else:
        instructions = ""
    task = SOURCE_TASK if request.get("responsibility") == "source" else TASK + "\nAuthor roles, boundaries, parents, document/quotation ownership and all supplied annotation kinds over the corrected source."
    if request.get("responsibility") != "source":
        task += "\nRecord printed contents entries as navigation kind=contents: refs cover the complete printed entry including its page token, title covers its printed title, and target covers exact source membership in one actual body block or document title (empty when unresolved). A printed contents entry, page label or furniture is not a body target; do not promote a target to heading just to link it. Navigation parent identifies its enclosing entry; witness_id is null. Confirm a native bookmark using kind=bookmark, refs equal target, title=[], parent=null and its exact supplied witness_id. Native bookmark titles are evidence, not printed text; do not fabricate printed membership for them."
    if request.get("require_complete_blocks"):
        task = task.replace("Return sparse corrections using the\nsupplied schema; omit correct decisions.", "Explicitly author every TARGET source character in complete structural blocks using the supplied schema, including unchanged blocks.")
    if request.get("source_locked"):
        task += "\nThe supplied corrected source is fixed for this structural revision. Retain its text and physical units. Report source defects in source_defects with exact refs and a concise reason; use [] when none. A reported defect blocks structural publication and requires the separate source correction operation."
    mode_instructions = (f"MODE: {mode}. Inspect the images and reuse the supplied corrected source by ID. Report extraction defects without editing source content."
                         if request.get("source_locked") else DIGITAL if mode == "digitalborn" else OCR)
    return task + "\n\n" + mode_instructions + instructions + "\nLines: [ID,page,box_0_to_1000,style_index,text]. Styles: [font_ID,size,flags]; flag bits are 1=superscript, 2=italic, 4=serif, 8=monospaced, 16=bold. Groups: [role,IDs,optional_metadata]. Annotation extents default to whole line_ids.\nINPUT:\n" + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
