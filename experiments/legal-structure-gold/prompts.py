"""The structure-gold calls. Every call sees the page images."""

REGIONS = ("text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
           "marginal_note", "furniture", "page_label", "line_label")

LINES = """Correct each page's extracted lines against its image. Give the page's units in reading order, each as its region and its printed lines: text, list_item, heading, quote (block quotation, numbered or not), note (footnote or endnote), table (one row; cells joined by " | "), contents (table of contents or index entry), caption (case caption), headnote, marginal_note, furniture (running header or footer), page_label or line_label (a transcript's printed line number, its own unit even where it is printed on the line it numbers). A unit is a paragraph, heading, item, note, row, running header, page number or line number.
Put a tab after each leading printed marker: a number, letter, roman numeral or bullet that counts or enumerates ("12\t(1)\tThe Minister"). A speaker label (Q., A., MR. SMITH:), a checkbox or a field label (TO:, cc., RE:) is not a marker. Write note references as [^mark], the mark as printed, brackets included.
continues: true when the page's first unit continues the unit before it on the page before."""

_UNIT = {"type": "object", "additionalProperties": False, "required": ["region", "lines"], "properties": {
    "region": {"type": "string", "enum": list(REGIONS)}, "lines": {"type": "array", "items": {"type": "string"}}}}
LINES_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["pages"], "properties": {"pages": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["continues", "units"], "properties": {
        "continues": {"type": "boolean"}, "units": {"type": "array", "items": _UNIT}}}}}}

NOTES = """Pair every note reference on these pages with its note. A reference is a printed mark, usually superscript, not a note named in words. References are written [^mark]: check them against the images, adding missed ones and dropping false ones.
Give each as its page, line and mark, and the number of its note in NOTES (0 where none is printed)."""
NOTES_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["pairs"], "properties": {"pairs": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["page", "line", "mark", "note"], "properties": {
        "page": {"type": "integer"}, "line": {"type": "integer"}, "mark": {"type": "string"}, "note": {"type": "integer"}}}}}}

HIERARCHY = """For each heading row give [row, level]: 1 for the outermost headings of its document, 2 for headings under those, and so on. Headings of one kind (same numbering, same type) share a level.
If the file holds several documents, such as a judgment and its exhibits, give starts and ends: the rows that begin and end each one; otherwise leave them empty."""
NUMBERING = """These are the numbered runs of one document in reading order. A run is the units whose numbers continue one count, so a run may resume after other material. Say what each run is:
paragraph: the document's own numbered paragraphs, clauses, sections, recitals or examination questions, however numbered ("1. I am", "[12]", "2.03 The Employer shall", "12 (1)", "(2) Notwithstanding", "A. The Borrower", "62 Q. Are you aware").
list: items of a list inside or after a paragraph, such as (a), i., bullets, or a count restarting after a lead-in ("the Court refused:" then 1. 2. 3.).
plain: not numbering: speaker labels (Q., A., MR. SMITH:), field labels (TO:, cc., RE:).
option: a form's checkbox options."""
NUMBERING_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["runs"], "properties": {"runs": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["run", "kind"], "properties": {
        "run": {"type": "integer"}, "kind": {"type": "string", "enum": ["paragraph", "list", "plain", "option"]}}}}}}
_NUMBERS = {"type": "array", "items": {"type": "integer"}}
HIERARCHY_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["levels", "starts", "ends"],
                    "properties": {"levels": {"type": "array", "items": _NUMBERS}, "starts": _NUMBERS, "ends": _NUMBERS}}


def images(pages):
    return "Images in order: " + ", ".join(f"page {p}" for p in pages) + "."


def lines_prompt(lines, targets, before=None):
    """lines: {page: [extracted line text]} for the target pages; before: the last extracted lines
    of the page before them."""
    parts = [LINES, images(targets)]
    if before: parts.append("The page before ends:\n" + "\n".join(before))
    parts.append("EXTRACTED LINES")
    for page in targets:
        parts.append(f"[page {page}]")
        parts.extend(lines.get(page, []))
    return "\n".join(parts)


def notes_prompt(numbered, notes, targets):
    """numbered: {page: [(region, text)]}; notes: [(page, line, text)] where each note begins."""
    return (NOTES + "\n" + images(targets) + "\nNOTES\n"
            + "\n".join(f"{k} | p{p}:{n} | {' '.join(text.split())[:60]}" for k, (p, n, text) in enumerate(notes, 1)) + "\nLINES\n"
            + "\n".join(f"[page {p}]\n" + "\n".join(f"{n} | {r} | {t}" for n, (r, t) in enumerate(numbered[p], 1)) for p in targets))


def numbering_prompt(listing):
    return NUMBERING + "\nRUNS\n" + listing


def hierarchy_prompt(rows, shown, pages):
    """rows: [(page, region, text)]; shown: the row indexes in this call; pages: the imaged pages."""
    more = "\n(More rows follow.)" if shown[-1] + 1 < len(rows) else ""
    return (HIERARCHY + "\n" + images(pages) + "\nROWS\n"
            + "\n".join(f"{n + 1} | p{rows[n][0]} | {rows[n][1]} | {rows[n][2]}" for n in shown) + more)
