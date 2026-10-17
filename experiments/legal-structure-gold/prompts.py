"""The structure-gold calls: lines (page images and extracted lines in, typed lines and their
grouping out) and hierarchy (numbered units and page images in, parents out)."""

REGIONS = ("text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
           "marginal_note", "furniture", "page_label")

LINES = """Transcribe each TARGET page line by line in reading order, one list per page. Each line is [region, text].

Text is the line's printed text. The extracted lines below can be wrong: type what the image shows.

Regions:
text: running text, such as a paragraph or a numbered provision
list_item: every line of an item in a list
heading: a heading or title
quote: a block quotation set off from the running text; a quotation inside a paragraph is text
note: a footnote or endnote
table: a table row; cells joined by " | "
contents: an entry of a table of contents or an index
caption: a case caption (court, parties, file number)
headnote: a law reporter's editorial summary or catchwords
marginal_note: a side note beside a statute provision
furniture: a running header or footer
page_label: a printed page number

When a line starts with a printed marker (number, letter, symbol or bullet), put a tab right after it; if a second marker follows, as in "12 (1)", put a tab after it too.
Mark each note reference in the text as [^N] with its printed marker.

Also give, per page: starts, the numbers (from 1) of the lines that begin a new paragraph, heading, list item, note, table row or other unit; continues, true if the page's running text opens by continuing a unit from the page before; and documents, the numbers of the lines that begin a separate document in the file, such as an exhibit or schedule."""

_LINE = {"type": "array", "minItems": 2, "maxItems": 2,
         "prefixItems": [{"type": "string", "enum": list(REGIONS)}, {"type": "string"}],
         # Strict schemas over HTTPS require items beside prefixItems.
         "items": {"type": "string"}}
_NUMBERS = {"type": "array", "items": {"type": "integer", "minimum": 1}}
LINES_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["pages"], "properties": {
    "pages": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                         "required": ["lines", "starts", "continues", "documents"],
                                         "properties": {"lines": {"type": "array", "items": _LINE}, "starts": _NUMBERS,
                                                        "continues": {"type": "boolean"}, "documents": _NUMBERS}}}}}

HIERARCHY = """For each row give the number of the row it falls under (its heading, provision, paragraph or list item), or 0 if it is top level. Rows are in reading order; the page images show their layout."""
HIERARCHY_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["parents"],
                    "properties": {"parents": {"type": "array", "items": {"type": "integer", "minimum": 0}}}}


def lines_prompt(lines, targets, before=None):
    """lines: {page: [extracted line text]} for the TARGET pages; before: the last extracted lines
    of the page before them, so the first page can tell whether it continues a unit."""
    parts = [LINES, "\nImages in order: " + ", ".join(f"page {p}" for p in targets) + "."]
    if before: parts.append("\nThe page before ends:\n" + "\n".join(before))
    parts.append("\nEXTRACTED LINES")
    for page in targets:
        parts.append(f"[page {page}]")
        parts.extend(lines.get(page, []))
    return "\n".join(parts)


def hierarchy_prompt(rows, shown, pages):
    """rows: [(page, region, text)]; shown: the row indexes in this call; pages: the imaged pages."""
    return (HIERARCHY + "\nImages in order: " + ", ".join(f"page {p}" for p in pages) + ".\n\nROWS\n"
            + "\n".join(f"{n + 1} | p{rows[n][0]} | {rows[n][1]} | {rows[n][2]}" for n in shown))
