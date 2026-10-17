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


def scopes(lines, groups):
    """Ranked units per document: [[unit index]]; a unit holding a document start opens one."""
    found = [[]]
    for u, members in enumerate(groups):
        if any(lines[n]["document"] for n in members) and found[-1]: found.append([])
        if lines[members[0]]["region"] not in UNRANKED: found[-1].append(u)
    return [scope for scope in found if scope]


def row(lines, members):
    first = lines[members[0]]
    return first["page"], first["region"], " ".join(first["text"].split())[:80]


def decide(rows, ask):
    """Parent row numbers (1-based, 0 for top level) for every row, a page window at a time; the
    still-open ancestors of the window before carry its context forward."""
    parents, start = [0] * len(rows), 0
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
        for n, parent in zip(shown, ask(shown, sorted({rows[n][0] for n in shown}))):
            if n >= start: parents[n] = parent
        start = end
    return parents


def checked(shown):
    def validate(response):
        parents = response["parents"]
        if len(parents) != len(shown): raise ValueError(f"Expected {len(shown)} parents, one per row")
        if not all(parent - 1 < n for n, parent in zip(shown, parents)): raise ValueError("A row's parent must be an earlier row")
        return parents
    return validate
