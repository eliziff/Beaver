"""Units of typed lines, and the pass that gives each unit its parent.

A unit is a paragraph, heading, list item, note, table row or other block: a typed line the model
marked as a start, with the lines that continue it on its page and, where the page continues the
one before, across the page break. Running headers, footers and page numbers are units of their own.
"""
OWN = {"furniture", "page_label"}
UNRANKED = OWN | {"marginal_note", "note", "contents"}
CHUNK_PAGES, CHUNK_ROWS = 8, 200


def family(region):
    return "body" if region in ("text", "list_item") else region


def units(lines):
    """[[typed line index]] in reading order. lines: the gold's typed lines, each with page, region,
    start and the page's continues flag."""
    result, last, page = [], {}, None
    for n, line in enumerate(lines):
        if line["page"] != page:
            page, earlier, last = line["page"], last, {}
        kind = family(line["region"])
        joined = None
        if line["region"] not in OWN and not line["start"]:
            joined = last.get(kind)
            if joined is None and line["continues"]: joined = earlier.get(kind)
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


def decide(rows, ask):
    """Parent row numbers (1-based, 0 for top level) for every row, and the rows that start and end
    a document, a page window at a time; the still-open ancestors of the window before carry its
    context forward."""
    parents, starts, ends, start = [0] * len(rows), set(), set(), 0
    while start < len(rows):
        pages = []
        end = start
        while end < len(rows) and end - start < CHUNK_ROWS and (rows[end][0] in pages or len(pages) < CHUNK_PAGES):
            if rows[end][0] not in pages: pages.append(rows[end][0])
            end += 1
        context = set()
        for at in range(max(0, start - 5), start):
            context.add(at)
            while parents[at]:
                at = parents[at] - 1; context.add(at)
        shown = sorted(context) + list(range(start, end))
        answer = ask(shown, sorted({rows[n][0] for n in shown}))
        for n, parent in zip(shown, answer["parents"]):
            if n >= start: parents[n] = parent
        starts |= {n - 1 for n in answer["starts"] if n - 1 >= start}
        ends |= {n - 1 for n in answer["ends"] if n - 1 >= start}
        start = end
    return parents, starts, ends


def documents(starts, ends, rows):
    """Starts and ends paired: a document still open where the next starts, or at the last row,
    ends on the row before."""
    ends, open_ = set(ends), None
    for n in range(rows):
        if n in starts:
            if open_ is not None and n - 1 >= open_: ends.add(n - 1)
            open_ = n
        if n in ends: open_ = None
    if open_ is not None: ends.add(rows - 1)
    return set(starts), ends


def checked(shown):
    def validate(response):
        parents = response["parents"]
        if len(parents) != len(shown): raise ValueError(f"Expected {len(shown)} parents, one per row")
        if not all(parent - 1 < n for n, parent in zip(shown, parents)): raise ValueError("A row's parent must be an earlier row")
        if not set(response["starts"]) | set(response["ends"]) <= {n + 1 for n in shown}:
            raise ValueError("starts and ends must number shown rows")
        return response
    return validate
