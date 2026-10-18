"""Units of typed lines, and the pass that gives each unit its parent.

A unit is a paragraph, heading, list item, note, table row or other block: a typed line the model
marked as a start, with the lines after it that continue it, on its page or the next. Running
headers, footers and page numbers are units of their own.
"""
OWN = {"furniture", "page_label"}
UNRANKED = OWN | {"marginal_note", "note", "contents"}
# Input tokens of one hierarchy call: gpt-6.1-sol's 500k context, less its instructions, reasoning
# and answer. A whole document fits up to about 150 pages at 144 dpi; a longer one goes in windows.
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
    """Parent row numbers (1-based, 0 for top level) for every row, and the rows that start and end
    a document: the whole document in one call when it fits the budget and image count, otherwise
    windows that each fill them, carrying the still-open ancestors of the window before."""
    parents, starts, ends, start = [0] * len(rows), set(), set(), 0
    while start < len(rows):
        context = set()
        for at in range(max(0, start - 5), start):
            context.add(at)
            while parents[at]:
                at = parents[at] - 1; context.add(at)
        pages = {rows[n][0] for n in context}
        cost = sum(page_tokens[p] for p in pages) + sum(row_tokens(rows[n]) for n in context)
        end = start
        while end < len(rows):
            extra = row_tokens(rows[end]) + (0 if rows[end][0] in pages else page_tokens[rows[end][0]])
            if end > start and (cost + extra > BUDGET or rows[end][0] not in pages and len(pages) == IMAGES): break
            cost += extra; pages.add(rows[end][0]); end += 1
        shown = sorted(context) + list(range(start, end))
        answer = ask(shown, sorted(pages))
        for n, parent in zip(shown, answer["parents"]):
            if n >= start: parents[n] = parent
        starts |= {n - 1 for n in answer["starts"] if n - 1 >= start}
        ends |= {n - 1 for n in answer["ends"] if n - 1 >= start}
        start = end
    return parents, starts, ends


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


def checked(shown):
    numbered = set(shown)
    def validate(response):
        parents = response["parents"]
        if len(parents) != len(shown): raise ValueError(f"Expected {len(shown)} parents, one per row")
        if not all(parent == 0 or parent - 1 in numbered and parent - 1 < n for n, parent in zip(shown, parents)):
            raise ValueError("A row's parent must be an earlier row, or 0")
        if not set(response["starts"]) | set(response["ends"]) <= {n + 1 for n in shown}:
            raise ValueError("starts and ends must number shown rows")
        return response
    return validate
