"""Units of typed lines, and the pass that gives them their levels and depths.

A unit is a paragraph, heading, list item, note, table row or other block: a typed line the model
marked as a start, with the lines after it that continue it, on its page or the next. Running
headers, footers, page numbers and a transcript's line numbers are units of their own.

The document pass sees the whole document, every unit's full text and every page image, and gives
each heading its level (1 the outermost in its document) and every other body unit its depth (1
directly under the headings, 2 inside a unit of depth 1), one depth per printed marker where the
unit opens with several; a heading that is no title takes depths, as text, and a title typed
otherwise takes a level. It also gives where each of the file's documents starts. The gold keeps
those as given: a unit sits inside the nearest unit before it of a smaller depth, under the nearest
heading before it.
"""
OWN = {"furniture", "page_label", "line_label"}
# Units the document pass shows but gives no level or depth.
UNLEVELLED = OWN | {"note", "marginal_note", "contents"}
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


def row(lines, members, texts, indents):
    """(page, region, text, markers, indent): the unit's full text, its printed markers in order, and
    its first line's left edge as a percentage of the page width (None for a line the extraction missed)."""
    first = lines[members[0]]
    markers = [texts[s["line_id"]][s["start"]:s["end"]] for t in members for marker in lines[t].get("markers", []) for s in marker]
    indent = next((indents[s["line_id"]] for t in members for s in lines[t]["spans"]), None)
    return first["page"], first["region"], " ".join(" ".join(lines[t]["text"] for t in members).split()), markers, indent


def row_tokens(row):
    return len(row[2]) // 3 + 8


def decide(rows, ask, page_tokens):
    """Heading levels (None for rows given depths), depths ([one per printed marker, or one], None
    for headings and the rows that take neither) and the rows that start a document ({row: its
    type}): the whole document in one call when it fits the budget and image count, otherwise
    windows that each fill them, carrying the five rows before the window and the last heading at
    each open level and the last row at each open depth."""
    levels, depths, starts, start = [None] * len(rows), [None] * len(rows), {}, 0
    while start < len(rows):
        context = set(range(max(0, start - 5), start))
        for given in (levels, [d[-1] if d else None for d in depths]):
            stack = {}
            for at in range(start):
                if given[at]:
                    stack = {k: v for k, v in stack.items() if k < given[at]}
                    stack[given[at]] = at
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
        for row, given in answer["rows"].items():
            if int(row) - 1 >= start:
                if "level" in given: levels[int(row) - 1] = given["level"]
                else: depths[int(row) - 1] = given["depths"]
        if "type" in answer:
            starts.setdefault(0, answer["type"])
        else:
            starts.update({item["row"] - 1: item["type"] for item in answer["starts"] if item["row"] - 1 >= start})
        start = end
    return levels, depths, starts


def answered(shown, rows):
    """The shown rows that take a heading level or depths, numbered from 1."""
    return [n + 1 for n in shown if rows[n][1] not in UNLEVELLED]


def checked(shown, rows):
    """The schema holds each answered row to one answer, one depth per printed marker; this asks
    only that the file's first document start on row 1 (a document split from its packet names
    only what it is)."""
    def validate(response):
        if "starts" in response and 0 in shown and 1 not in {item["row"] for item in response["starts"]}:
            raise ValueError("The first document starts on row 1: give it with its type")
        return response
    return validate
