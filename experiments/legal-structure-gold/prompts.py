"""The structure-gold calls. Every call sees the page images."""

REGIONS = ("text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
           "marginal_note", "furniture", "page_label")

LINES = """Correct each page's extracted lines against its image. Give every printed line in reading order as [region, text]: text, list_item, heading, quote (block quotation), note (footnote or endnote), table (cells joined by " | "), contents (table of contents or index entry), caption (case caption), headnote, marginal_note, furniture (running header or footer) or page_label.
Put a tab after each leading printed marker. Write note references as [^mark], the mark as printed, brackets included.
starts: the numbers of the lines that begin a unit (paragraph, heading, item, note, row); other lines continue the unit before them, also across pages."""

_NUMBERS = {"type": "array", "items": {"type": "integer"}}
LINES_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["pages"], "properties": {"pages": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["lines", "starts"], "properties": {
        "lines": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}}, "starts": _NUMBERS}}}}}

NOTES = """Pair every note reference on these pages with its note. A reference is a printed mark, usually superscript, not a note named in words. References are written [^mark]: check them against the images, adding missed ones and dropping false ones.
Give each as [page, line, mark, note page, note line], where the note's first line is from NOTES."""
NOTES_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["pairs"], "properties": {
    "pairs": {"type": "array", "items": {"type": "array", "items": {"type": ["integer", "string"]}}}}}

HIERARCHY = """Give each row the number of the row it falls under (its heading, provision, paragraph or list item), or 0 if none.
If the file holds several documents, such as a judgment and its exhibits, give starts and ends: the rows that begin and end each one; otherwise leave them empty."""
HIERARCHY_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["parents", "starts", "ends"],
                    "properties": {"parents": _NUMBERS, "starts": _NUMBERS, "ends": _NUMBERS}}


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
            + "\n".join(f"p{p}:{n} | {' '.join(text.split())[:60]}" for p, n, text in notes) + "\nLINES\n"
            + "\n".join(f"[page {p}]\n" + "\n".join(f"{n} | {r} | {t}" for n, (r, t) in enumerate(numbered[p], 1)) for p in targets))


def hierarchy_prompt(rows, shown, pages):
    """rows: [(page, region, text)]; shown: the row indexes in this call; pages: the imaged pages."""
    more = "\n(More rows follow.)" if shown[-1] + 1 < len(rows) else ""
    return (HIERARCHY + "\n" + images(pages) + "\nROWS\n"
            + "\n".join(f"{n + 1} | p{rows[n][0]} | {rows[n][1]} | {rows[n][2]}" for n in shown) + more)
