"""Units of typed lines, the pass that gives headings their levels, and the parents that follow.

A unit is a paragraph, heading, list item, note, table row or other block: a typed line the model
marked as a start, with the lines after it that continue it, on its page or the next. Running
headers, footers and page numbers are units of their own.

The model decides only heading levels (1 the outermost in its document) and document boundaries.
Parents are computed: a heading falls under the nearest earlier heading of a smaller level; text,
tables, captions and headnotes under the nearest earlier heading; a list item continues its
numbering family's open list or falls under the unit before it; a quote under the unit before it;
notes, marginal notes, contents and furniture stay outside. A document boundary resets everything.

author.py writes every gold's parents with `assemble`, and the grader refuses a gold whose parents
differ from it, so no gold is ever converted after the fact.
"""
import re

OWN = {"furniture", "page_label"}
UNRANKED = OWN | {"marginal_note", "note", "contents"}
RANKED = {"text", "list_item", "heading", "quote", "table", "caption", "headnote"}
UNDER_HEADING = {"text", "table", "caption", "headnote"}
# Input tokens of one hierarchy call: gpt-6.1-sol's 500k context, less its instructions, reasoning
# and answer. A whole document fits up to about 100 pages at the 2,048-pixel long side; a longer one
# goes in windows.
BUDGET = 400_000
# Images of one call: the codex command line (8,191 characters through the npm shim) holds about 150
# page images at about 44 characters each.
IMAGES = 150


def family(region):
    return "body" if region in ("text", "list_item") else region


def units(lines):
    """[[typed line index]] in reading order. A line that does not start a unit continues the last
    unit of its kind on its page, or else on the page before."""
    result, last, earlier, page = [], {}, {}, None
    for n, line in enumerate(lines):
        if line["page"] != page:
            page, earlier, last = line["page"], last, {}
        kind = family(line["region"])
        joined = None if line["region"] in OWN or line["start"] else last.get(kind, earlier.get(kind))
        if joined is None:
            result.append([n]); joined = len(result) - 1
        else:
            result[joined].append(n)
        if line["region"] not in OWN: last[kind] = joined
    return result


def ranked(lines, groups):
    """The units the hierarchy orders: [unit index]."""
    return [u for u, members in enumerate(groups) if lines[members[0]]["region"] not in UNRANKED]


def row(lines, members):
    first = lines[members[0]]
    return first["page"], first["region"], " ".join(first["text"].split())[:80]


def row_tokens(row):
    return len(row[2]) // 3 + 8


def decide(rows, ask, page_tokens):
    """Heading levels (None for rows that are not headings) for every row, from the model's
    [row, level] pairs, and the rows that start and end a document: the whole document in one call
    when it fits the budget and image count, otherwise windows that each fill them, carrying the
    five rows before the window and the last heading seen at each open level."""
    levels, starts, ends, start = [None] * len(rows), set(), set(), 0
    while start < len(rows):
        context, stack = set(range(max(0, start - 5), start)), {}
        for at in range(start):
            if levels[at] is not None:
                stack = {k: v for k, v in stack.items() if k < levels[at]}
                stack[levels[at]] = at
        context |= set(stack.values())
        pages = {rows[n][0] for n in context}
        cost = sum(page_tokens[p] for p in pages) + sum(row_tokens(rows[n]) for n in context)
        end = start
        while end < len(rows):
            extra = row_tokens(rows[end]) + (0 if rows[end][0] in pages else page_tokens[rows[end][0]])
            if end > start and (cost + extra > BUDGET or rows[end][0] not in pages and len(pages) == IMAGES): break
            cost += extra; pages.add(rows[end][0]); end += 1
        shown = sorted(context) + list(range(start, end))
        answer = ask(shown, sorted(pages))
        for row_number, level in answer["levels"]:
            if row_number - 1 >= start and rows[row_number - 1][1] == "heading": levels[row_number - 1] = level
        starts |= {n - 1 for n in answer["starts"] if n - 1 >= start}
        ends |= {n - 1 for n in answer["ends"] if n - 1 >= start}
        start = end
    for n, r in enumerate(rows):
        if r[1] == "heading" and levels[n] is None: levels[n] = 1
    return levels, starts, ends


def documents(starts, ends, rows):
    """Starts and ends paired: a document still open where the next starts, or at the last row,
    ends on the row before. The first row starts the file itself, so a file whose only start is
    there holds one document and records none."""
    if not set(starts) - {0}: return set(), set()
    ends, open_ = set(ends), None
    for n in range(rows):
        if n in starts:
            if open_ is not None and n - 1 >= open_: ends.add(n - 1)
            open_ = n
        if n in ends: open_ = None
    if open_ is not None: ends.add(rows - 1)
    return set(starts) | {0}, ends


def checked(shown, rows):
    numbered = {n + 1 for n in shown}
    headings = {n + 1 for n in shown if rows[n][1] == "heading"}
    def validate(response):
        levels = response["levels"]
        if not all(len(pair) == 2 for pair in levels): raise ValueError("Each entry is [row, level]")
        if len({r for r, _ in levels}) != len(levels): raise ValueError("A row has one level")
        if not all(r in numbered and 1 <= level <= 9 for r, level in levels): raise ValueError("Levels number shown rows, 1 to 9")
        if not headings <= {r for r, _ in levels}: raise ValueError("Every heading row needs a level")
        if not set(response["starts"]) | set(response["ends"]) <= numbered: raise ValueError("starts and ends must number shown rows")
        return response
    return validate


# Numbering families a unit can open with, for list nesting.
_WORD_OUTER = re.compile(r"^(PART|PARTIE|BOOK|LIVRE|TITLE|TITRE|VOLUME)\b", re.I)
_WORD_INNER = re.compile(r"^(ARTICLE|CHAPTER|CHAPITRE|DIVISION|SECTION|SCHEDULE|ANNEX|ANNEXE|APPENDIX|TAB|RULE|R[ÈE]GLE|CLAUSE|FORM|FORMULE)\b", re.I)
_SEC = re.compile(r"^(\d+(?:\.\d+)?)\s*\(\d+\)")
_DOTTED = re.compile(r"^(\d+(?:\.\d+)+)\.?(?=\s|$)")
_NUM = re.compile(r"^(?:\(|\[)?(\d+)(?:[.)\]:]|(?=\s))(?=\s|$)")
_ROMAN = re.compile(r"^\(?([IVXLCivxlc]{1,6})[.)\]:](?=\s|$)")
_ALPHA = re.compile(r"^\(?([A-Za-z]{1,2})[.)\]](?=\s|$)")
_BULLET = re.compile(r"^[•·▪–—\-*●○■□►]\s")
_ROMANS = {"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii",
           "xviii", "xix", "xx", "xxi", "xxii", "xxiii", "xxiv", "xxv", "xxx", "xl", "l"}


def numbering(text, open_letter=None):
    """The numbering family a unit opens with ('' for none); `open_letter` is the last letter of an
    open lower-case letter list, so 'i' after 'h' reads as a letter, not a numeral."""
    t = text.lstrip()
    if _WORD_OUTER.match(t): return "word_outer"
    if _WORD_INNER.match(t): return "word_inner"
    if _SEC.match(t): return "sec"
    m = _DOTTED.match(t)
    if m: return f"dec{min(m.group(1).count('.') + 1, 4)}"
    if _NUM.match(t): return "num"
    m = _ROMAN.match(t)
    if m:
        token = m.group(1); lower = token.islower()
        if len(token) == 1 and token.lower() in "ivxlc":
            if open_letter == chr(ord(token.lower()) - 1): return "al" if lower else "AU"
            return "rl" if lower else "RU"
        if token.lower() in _ROMANS: return "rl" if lower else "RU"
    m = _ALPHA.match(t)
    if m:
        token = m.group(1)
        if len(token) == 2 and token[0] != token[1]: return ""
        return "al" if token.islower() else "AU"
    if _BULLET.match(t): return "bullet"
    return ""


def assemble(regions, texts, levels, starts_document):
    """Parents for units in reading order, from each unit's region and first-line text, heading
    levels (None off headings) and document starts. Returns [parent unit index or None]."""
    parents = [None] * len(regions)
    heading_stack, list_stack, prev, open_letter = [], [], None, None  # (level, unit); (family, unit, parent)
    for u, region in enumerate(regions):
        if region not in RANKED: continue
        if starts_document[u]: heading_stack, list_stack, prev, open_letter = [], [], None, None
        if region == "heading":
            level = levels[u] if levels[u] is not None else 1
            while heading_stack and heading_stack[-1][0] >= level: heading_stack.pop()
            parent = heading_stack[-1][1] if heading_stack else None
            heading_stack.append((level, u)); list_stack, open_letter = [], None
        elif region in UNDER_HEADING:
            parent = heading_stack[-1][1] if heading_stack else None
            if region == "text": list_stack, open_letter = [], None
        elif region == "list_item":
            fam = numbering(texts[u], open_letter)
            found = next((k for k in range(len(list_stack) - 1, -1, -1) if fam and list_stack[k][0] == fam), None)
            if found is not None:
                parent = list_stack[found][2]; del list_stack[found + 1:]; list_stack[found] = (fam, u, parent)
            elif not fam and list_stack:
                parent = list_stack[-1][2]; list_stack[-1] = (list_stack[-1][0], u, parent)
            else:
                parent = prev if prev is not None else (heading_stack[-1][1] if heading_stack else None)
                list_stack.append((fam, u, parent))
            if fam == "al":
                m = _ALPHA.match(texts[u].lstrip()); open_letter = m.group(1).lower() if m else None
        else:  # quote
            parent = parents[prev] if prev is not None and regions[prev] == "quote" else prev
        parents[u] = parent; prev = u
    return parents
