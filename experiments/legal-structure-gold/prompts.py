"""The structure-gold calls, each seeing the page images: the lines pass (one target page, with the
pages either side as context) and the document pass (the whole document: heading levels, depths,
documents)."""
import json

REGIONS = ("text", "provision", "list_item", "title", "heading", "quote", "note", "note_quote", "table", "contents", "headnote", "marginal_note", "furniture",
           "page_label", "line_label")
MARKER_KINDS = ("number", "line_number", "speaker")
LINES ="""You are correcting OCR text, assigning document-layout regions, and choosing final reading order for one legal document page.

Use the attached target page image as visual authority. The extracted text is machine evidence, not ground truth: use the page image as the authority and the extracted text as the editable draft.
- Earlier pages below are guarded model corrections from this run when available, each line as read: its region, + where it starts a unit, its labels, and its text. Read this page the same way.
- Later pages are noisy OCR context only.

Use other pages for vocabulary, headings, repeated citation patterns, and where this page sits in the document. Do not copy their mistakes.

Rules:
- Include each target line number exactly once; output order is final reading order.
- Correct OCR errors only when the image supports the correction. Give text only for a corrected line, the line as printed; null where the line reads as printed.
- Preserve the extracted line breaks; do not merge short lines into paragraphs. Keep each printed character on the line that holds it: a correction never moves text from one line to another.
- Preserve legal citation conventions, case names, reporter abbreviations, statutes, footnote text, quotation marks, and hyphenation.
- Do not modernize spelling, punctuation, capitalization, or typography unless the page image clearly shows the extracted text is wrong.
- Preserve visible footnote/endnote refs and note labels as plain text. In body text, footnote markers usually appear as digits immediately after ending punctuation. In footnote regions, footnotes usually start as number + space/tab + citation or note text.
- A printed line the extracted text missed is line 0, with its text (printed text only, never a signature, handwriting or a picture).

Regions:
- text: the document's own prose: its argument, discussion, narrative, quotations worked into the paragraph, and continuation lines; its paragraphs, numbered or not; cover lines, the issuing court or body, parties, counsel, signature blocks, form fields and their labels (TO:, BEFORE:, APPEARANCES:), one unit per party, counsel entry with the party it acts for, or signatory. Use text even when a line is short, indented, dense, or visually similar to surrounding note text, unless the local text clearly belongs to a more specific region.
- provision: a section, clause, subsection or subclause of an instrument (a statute, regulation, rules, or a contract or other agreement), with its own caption, run in or on a line of its own.
- list_item: an item of a list.
- title: the document's title: what the document is called.
- heading: the heading of one of the document's divisions: a part, article or chapter, or an unnumbered heading over the text that follows. Not a provision's own caption, nor a label.
- quote: a quoted passage set apart from normal prose as an indented or narrower display block: a block quotation, an excerpt of legislation, a judgment or another document, its own lists and headings included.
- note: footnote or endnote text: bottom-of-page notes separated from the main body prose, or the entries of a notes section; its own number or mark included. A body line with a note marker is still text.
- note_quote: a block quotation set inside a note.
- table: a table row. contents: table-of-contents or index entries only.
- headnote: a law report's editorial text, not the court's words: catchlines, headnote, syllabus, the reporter's summary and lists of counsel and of cases cited.
- marginal_note: a statute's side note.
- furniture: page furniture such as a running title, date, court or journal label, or a stamp repeated on pages.
- page_label: a printed page number, with the words around it ("3", "- 3 -", "Page 3 of 10").
- line_label: a line holding only a transcript's printed line number.

For each line also give:
- starts: true where the line begins a unit (a paragraph, heading, item, note, table row, running header, page number or line number), false where it continues the unit before it, a paragraph or note carried over from the page before included. A number or speaker label printed apart from its text opens the unit it belongs to, and the lines after it continue that unit ("33", "Q.", "Okay." is one unit).
- cell: in a table row, the number of the line's cell (1, 2, ...); 0 elsewhere.
- markers: the labels printed on the line, in order: each one's characters exactly as the line prints them, which occurrence of those characters on the line it is (1 for the first), and its kind:
  - number: the number, letter or bullet a paragraph, section, clause, item or heading begins with ("6", "(1)", "[12]", "1.1", "ARTICLE 1", "IV.", "•"), each number its own marker, even printed against the next ("218.(1)" is "218." and "(1)"). A numbered word is one marker with its word ("Chapter 1", "PART IV", "Section 3.02"). An enumeration inside a running sentence is text.
  - line_number: a transcript's printed line number, on a line of its own or on the line it numbers.
  - speaker: the label that opens a speaker's turn ("Q.", "A.", "MR. SMITH:", "THE COURT:").
  Not a note's own number, a note reference or a page number.
- references: each note reference mark on the line: the mark as printed and the word printed just before it."""


def lines_schema(numbers, pages):
    """The lines pass's schema for one call: a page is one of its pages, a line one of its numbered
    lines or 0."""
    line = {"type": "object", "additionalProperties": False,
            "required": ["line", "text", "region", "starts", "cell", "markers", "references"], "properties": {
                "line": {"type": "integer", "enum": [0, *numbers]}, "text": {"type": ["string", "null"]},
                "region": {"type": "string", "enum": list(REGIONS)}, "starts": {"type": "boolean"}, "cell": {"type": "integer"},
                "markers": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["text", "occurrence", "kind"],
                                                       "properties": {"text": {"type": "string"}, "occurrence": {"type": "integer"},
                                                                      "kind": {"type": "string", "enum": list(MARKER_KINDS)}}}},
                "references": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["mark", "after"],
                                                          "properties": {"mark": {"type": "string"}, "after": {"type": "string"}}}}}}
    return {"type": "object", "additionalProperties": False, "required": ["pages"], "properties": {"pages": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["page", "lines"], "properties": {
            "page": {"type": "integer", "enum": [*pages]},
            "lines": {"type": "array", "items": line}}}}}}


_ROWS = "The rows are the document's units in reading order: each with its page, its region, its indent (its first line's left edge, as a percentage of the page's width), the printed markers it opens with, and its text."
_STARTS = "- starts: the row each of the file's documents starts on, row 1 for the first, with what the document is; a file can hold several, such as an affidavit and its exhibits, each exhibit a document of its own."
# A document split from its packet before authoring is one document: the pass names what it is.
_TYPE = "- type: what the document is."
# The document pass's two forms, under trial: a heading level or body depths per row ("two"), or one
# depth per row, headings included ("one").
HIERARCHY = {"two": _ROWS + """
Answer each row the answer names, once, with a heading level or with depths:
- level: a heading's level: 1 for the outermost headings of its document, 2 for headings under those, and so on. Headings of one kind (same numbering, same type) share a level. A row of another region that heads a division is a heading too: give it a level.
- depths: how far each other row is nested below the heading above it. A row directly under a heading is 1. A row inside another row is one deeper: a subsection in its section, an (a) in its clause, a block quotation in its paragraph. Text that resumes a section after its list returns to the section's depth. Give one depth per printed marker, in order: "6 (1)" is 1, 2. A heading row that heads no division (a party's name, a signature line, a field label, a sentence) gets depths, as text.
""", "one": _ROWS + """
Answer each row the answer names, once, with its depths:
- depths: the row's depth in its document: 1 for the outermost units, and a unit inside another one deeper than it: headings under a heading, the paragraphs under a heading, a section's subsections, a paragraph's list or block quotation, words that carry on a section after its list. One depth per printed marker, in order ("6 (1)" under a heading of depth 1: 2, 3), the row's depth being its last marker's.
"""}


def hierarchy_schema(rows, answered, counts, form, whole=False):
    """The document pass's schema for one call: an answer for each row that takes one (a heading
    level or depths, or depths alone in the one-depth form), one depth per printed marker, and
    document starts on any of its rows, or, for a document split from its packet (`whole`), what it
    is. counts: {row: printed markers}."""
    def depths(row):
        k = max(1, counts[row])
        return {"type": "object", "additionalProperties": False, "required": ["depths"], "properties": {
            "depths": {"type": "array", "items": {"type": "integer", "minimum": 1, "maximum": 9}, "minItems": k, "maxItems": k}}}
    level = {"type": "object", "additionalProperties": False, "required": ["level"],
             "properties": {"level": {"type": "integer", "minimum": 1, "maximum": 9}}}
    answers = {str(r): {"anyOf": [level, depths(r)]} if form == "two" else depths(r) for r in answered}
    kind = {"type": "string", "enum": list(DOCUMENT_TYPES)}
    documents = {"type": kind} if whole else {"starts": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["row", "type"],
        "properties": {"row": {"type": "integer", "enum": [*rows]}, "type": kind}}}}
    return {"type": "object", "additionalProperties": False, "required": ["rows", *documents], "properties": {
        "rows": {"type": "object", "additionalProperties": False, "required": list(answers), "properties": answers}, **documents}}


DOCUMENT_TYPES = ("judgment", "order", "affidavit", "pleading", "submission", "notice", "contract", "correspondence",
                  "transcript", "legislation", "form", "report", "article", "other")


def images(pages):
    return "The images are these pages, in order: " + ", ".join(f"image {k} is page {p}" for k, p in enumerate(pages, 1)) + "."


def lines_prompt(numbered, target, count, before=None, after=None, shared=False):
    """numbered: {line number: (page, line id, text)} for the target page's extracted lines; count:
    the file's pages; before, after: (page, text, corrected in this run) of the pages either side,
    or None; shared: the page also holds part of another document, whose lines are not targets."""
    shown = [p[0] for p in (before, (target,), after) if p]
    context = [f"{'PRIOR' if p < target else 'LATER'}_CONTEXT PAGE={p} source={'previous correction from this run' if fixed else 'noisy OCR only'}\n{text}"
               for p, text, fixed in filter(None, (before, after))]
    return "\n".join([
        LINES, "",
        "Page images, in order: " + ", ".join(f"image {k} is page {p}" + (" (target)" if p == target else " (context)")
                                             for k, p in enumerate(shown, 1)) + ".",
        "", f"TARGET_PAGE: page {target} of {count}",
        *(["This page also holds part of another document: the target lines are this document's part of it."] if shared else []),
        "", "TARGET_LINES:",
        *[f"{n} | {text}" for n, (_, _, text) in numbered.items()],
        "", "OTHER_DOCUMENT_CONTEXT:", "\n---\n".join(context) or "[none]"])


def hierarchy_prompt(rows, shown, pages, form, whole=False):
    """rows: [(page, region, text, markers, indent)]; shown: the row indexes in this call; pages: the
    imaged pages; whole: the rows are one document split from its packet."""
    more = "\n(More rows follow.)" if shown[-1] + 1 < len(rows) else ""
    return (HIERARCHY[form] + (_TYPE if whole else _STARTS) + "\n" + images(pages) + "\nROWS (row | page | region | indent | markers | text)\n"
            + "\n".join(f"{n + 1} | p{rows[n][0]} | {rows[n][1]} | {'-' if rows[n][4] is None else str(rows[n][4]) + '%'} | "
                        f"{json.dumps(rows[n][3], ensure_ascii=False) if rows[n][3] else '-'} | {rows[n][2]}"
                        for n in shown) + more)
