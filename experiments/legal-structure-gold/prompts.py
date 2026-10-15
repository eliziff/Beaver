"""The structure-gold authoring call: page images and extracted lines in, typed blocks out."""

REGIONS = ("text", "list_item", "heading", "quote", "note", "table", "caption", "headnote",
           "marginal_note", "furniture", "page_label")
FLAGS = ("continued", "document", "quoted")

INSTRUCTIONS = """Transcribe each TARGET page as a list of blocks in reading order, one list per TARGET page. Each block is [region, text] or [region, text, flags].

Text is the block's printed text, line by line, joined with \\n. The extracted lines below can be wrong: type what the images show, keeping extracted characters the print agrees with and correcting misread, garbled or missing ones. Type every printed character of the TARGET pages once.

Regions:
text: a paragraph, numbered or not, or other running text
list_item: one item of a list
heading: a heading or title
quote: a block quotation set off from the running text; each quote block starts a new quotation
note: one footnote or endnote
table: a whole table; one line per row, cells joined by " | ", a cell's own line breaks become spaces
caption: a case caption (court, parties, file number)
headnote: a law reporter's editorial summary or catchwords
marginal_note: a side note beside a statute provision
furniture: a running header or footer
page_label: a printed page number

When a block starts with a printed marker (number, letter, symbol or bullet), put a tab right after it.
Mark each note reference in the running text as [^N] with its printed marker, e.g. held[^12] that.

Flags:
continued: the block continues an earlier block interrupted by a page break or other blocks; split such a block at the page break.
document: the block starts a separate document in the file, such as an exhibit or schedule.
quoted: the block, such as a list item or paragraph, belongs to the block quotation before it."""

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["pages"], "properties": {
    "pages": {"type": "array", "items": {"type": "array", "items": {"type": "array", "minItems": 2, "maxItems": 3, "prefixItems": [
        {"type": "string", "enum": list(REGIONS)}, {"type": "string"}, {"type": "array", "items": {"type": "string", "enum": list(FLAGS)}}]}}}}}


def prompt(lines, targets, context=None):
    """lines: (page, text) in reading order for the TARGET pages; context: an earlier page shown first."""
    shown = ([f"page {context} (context, already transcribed)"] if context else []) + [f"page {p}" for p in targets]
    parts = [INSTRUCTIONS, "\nImages in order: " + ", ".join(shown) + ".", "\nEXTRACTED LINES"]
    for page in targets:
        parts.append(f"[page {page}]")
        parts.extend(text for at, text in lines if at == page)
    return "\n".join(parts)
