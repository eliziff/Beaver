"""Align typed blocks to the source lines and express them in the shared structure contract.

The model types each block's printed text in reading order. The runner derives the rest:
the source characters each block, table cell, printed marker and note reference covers;
scalar text corrections where the typed text differs from the extraction; and continuation
and document links. The shared Rust composition validates the result.
"""
from difflib import SequenceMatcher
import re
import unicodedata

from prompts import REGIONS, FLAGS

ROLES = {"quote": "text", "note": "text", "table": "text", "list_item": "text"}
MARKED = {"text", "list_item", "quote", "heading"}
LINKS = {"text": ("paragraph", " "), "list_item": ("paragraph", " "), "caption": ("paragraph", " "),
         "headnote": ("paragraph", " "), "marginal_note": ("paragraph", " "), "heading": ("heading", " "),
         "note": ("note", " "), "quote": ("paragraph", " "), "table": ("table", None)}
OPENING = "\"'“‘„‚«"
FOLD = str.maketrans({"‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'",
                      "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
                      "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
                      "―": "-", "−": "-", "­": "-"})
REFERENCE = re.compile(r"\[\^([^\]\s]{1,12})\]")
SPACE = (" ", None, None, None)


class UnusableExtraction(Exception):
    """The page's extracted lines do not carry its printed text, so no typed block can anchor to
    them; asking again cannot change that."""


def require(ok, message):
    if not ok: raise ValueError(message)


# Typed items are (char, block, cell, tag); tag is None, "marker" or ("ref", n). None separates
# blocks and cells. Source items are (char, line_id, offset); None separates lines.

def typed_items(blocks, first=0):
    items, parsed = [], []
    for number, block in enumerate(blocks, first):
        region, text = block[0], block[1]
        flags = set(block[2]) if len(block) > 2 else set()
        require(region in REGIONS and flags <= set(FLAGS), "Unknown region or flag")
        rows = [row.split("|") for row in text.split("\n")] if region == "table" else [[text]]
        width = max(len(row) for row in rows)
        start, references = len(items), []
        for r, row in enumerate(rows):
            for c, cell in enumerate(row):
                items.append(None)
                tab = cell.find("\t") if region != "table" else -1
                marker = tab if 0 < tab <= 12 and cell[:tab].strip() and "\n" not in cell[:tab] else None
                position = 0
                for match in [*REFERENCE.finditer(cell), None]:
                    end = match.start() if match else len(cell)
                    for offset in range(position, end):
                        tag = "marker" if marker is not None and offset < marker else None
                        items.append((cell[offset], number, r * width + c, tag))
                    if match:
                        # The marker is printed glued to its word but may be extracted on its own.
                        references.append(match[1])
                        items.append(None)
                        items.extend((char, number, r * width + c, ("ref", len(references) - 1)) for char in match[1])
                        items.append(None)
                        position = match.end()
        require(any(item and not item[0].isspace() for item in items[start:]), "A block has no text")
        parsed.append({"region": region, "flags": flags, "width": width, "rows": len(rows), "references": references})
    items.append(None)
    return items, parsed


def normalized(items):
    """Whitespace-collapsed, compatibility- and case-folded characters and the item each came from."""
    chars, owners = [], []
    for index, item in enumerate(items):
        for char in " " if item is None else unicodedata.normalize("NFKC", item[0]).translate(FOLD).casefold():
            if char.isspace():
                if not chars or chars[-1] == " ": continue
                char = " "
            chars.append(char); owners.append(index)
    return "".join(chars), owners


def align(source, typed, unit):
    """Character matches and changed regions; whole runs typed out of extraction order are moves.

    unit(position) names the typed block of a typed position. A move is a run of at least three
    words, or one whole typed block such as a page number or running header."""
    s_tok = [(m.start(), m.end()) for m in re.finditer(r"\S+", source)]
    t_tok = [(m.start(), m.end()) for m in re.finditer(r"\S+", typed)]
    s_words = [source[a:b] for a, b in s_tok]
    t_words = [typed[a:b] for a, b in t_tok]
    pairs, regions = [], []
    for tag, a, b, c, d in SequenceMatcher(None, s_words, t_words, autojunk=False).get_opcodes():
        (pairs if tag == "equal" else regions).append((a, b, c, d))
    used_s, used_t = set(), set()
    free_s = [i for a, b, _, _ in regions for i in range(a, b)]
    free_t = [i for _, _, c, d in regions for i in range(c, d)]
    t_unit = [unit(a) for a, _ in t_tok]
    size_of = {}
    for u in t_unit: size_of[u] = size_of.get(u, 0) + 1
    whole = lambda c, size: size == size_of[t_unit[c]] and t_unit[c + size - 1] == t_unit[c]
    while True:
        best = None
        for run_t in runs([i for i in free_t if i not in used_t]):
            for run_s in runs([i for i in free_s if i not in used_s]):
                m = SequenceMatcher(None, [s_words[i] for i in run_s], [t_words[i] for i in run_t],
                                    autojunk=False).find_longest_match(0, len(run_s), 0, len(run_t))
                if m.size and (m.size >= 3 or whole(run_t[m.b], m.size)) and (best is None or m.size > best[0]):
                    best = (m.size, run_s[m.a], run_t[m.b])
                if len(run_t) == 1 and not m.size and whole(run_t[0], 1) and len(t_words[run_t[0]]) >= 3:
                    # A misread one-word block typed elsewhere, such as a logo.
                    for i in run_s:
                        if best is None and SequenceMatcher(None, s_words[i], t_words[run_t[0]], autojunk=False).ratio() >= 0.75:
                            best = (1, i, run_t[0])
        if best is None: break
        size, a, c = best
        pairs.append((a, a + size, c, c + size))
        used_s.update(range(a, a + size)); used_t.update(range(c, c + size))
    matches, changes = {}, []
    def compare(sp, tp, before):
        left, right = "".join(source[p] for p in sp), "".join(typed[p] for p in tp)
        diff = SequenceMatcher(None, left, right, autojunk=False)
        sizes = [len(text) - text.count(" ") for text in (left, right)]
        same = sum(sum(1 for c in left[b.a:b.a + b.size] if c != " ") for b in diff.get_matching_blocks())
        if sizes[0] and max(sizes) >= 3 and same < max(sizes) / 2:
            return  # different text side by side is no misreading: neither is corrected into the other
        for tag, i1, i2, j1, j2 in diff.get_opcodes():
            if tag == "equal":
                for k in range(i2 - i1): matches[sp[i1 + k]] = tp[j1 + k]
            else:
                changes.append((sp[i1:i2], tp[j1:j2], sp[i1 - 1] if i1 else before))
    for a, b, c, d in pairs:
        x, y = s_tok[a][0], t_tok[c][0]
        if source[x:s_tok[b - 1][1]] == typed[y:t_tok[d - 1][1]]:
            for k in range(s_tok[b - 1][1] - x): matches[x + k] = y + k
        else:
            compare(list(range(x, s_tok[b - 1][1])), list(range(y, t_tok[d - 1][1])), x - 1)
    def positions(tok, text, a, b, used):
        start = tok[a - 1][1] if a > 0 else 0
        end = tok[b][0] if b < len(tok) else len(text)
        excluded = {p for i in used if a <= i < b for p in range(*tok[i])}
        return [p for p in range(start, end) if p not in excluded]
    for a, b, c, d in regions:
        sp, tp = positions(s_tok, source, a, b, used_s), positions(t_tok, typed, c, d, used_t)
        compare(sp, tp, sp[0] - 1 if sp else s_tok[a - 1][1] - 1 if a > 0 else None)
    return matches, changes


def runs(indexes):
    result = []
    for i in indexes:
        if result and result[-1][-1] + 1 == i: result[-1].append(i)
        else: result.append([i])
    return result


def chunk(pages, mode):
    """Align one response page by page: pages are [(source lines [(line_id, text)], typed blocks)]."""
    source, typed, parsed, owner, changes = [None], [], [], {}, []
    for lines, blocks in pages:
        start = len(source)
        for ident, text in lines:
            source.extend((char, ident, offset) for offset, char in enumerate(text))
            source.append(None)
        items, described = typed_items(blocks, len(parsed))
        parsed.extend(described)
        base = len(typed)
        typed.extend(items)
        s_text, s_own = normalized(source[start - 1:])
        s_own = [i + start - 1 for i in s_own]
        t_text, t_own = normalized(items)
        t_own = [i + base for i in t_own]
        matches, regions = align(s_text, t_text, lambda p: typed[t_own[p]][1] if typed[t_own[p]] else None)
        for sp, tp in matches.items():
            if source[s_own[sp]] is not None and typed[t_own[tp]] is not None:
                owner.setdefault(s_own[sp], typed[t_own[tp]])
        changes.extend((s_own, t_own, s_pos, t_pos, before) for s_pos, t_pos, before in regions)
    anchored = {item[1] for item in owner.values() if not item[0].isspace()}
    unanchored = [n for n in range(len(parsed)) if n not in anchored]
    edits = []
    for s_own, t_own, s_pos, t_pos, before in changes:
        removed = sorted({s_own[p] for p in s_pos if source[s_own[p]] is not None} - set(owner))
        # A block that matches no extracted text has no physical line to correct; it is reported.
        added = [typed[i] for i in dict.fromkeys(t_own[p] for p in t_pos)
                 if typed[i] is not None and typed[i][1] in anchored]
        before = s_own[before] if before is not None and before >= 0 else None
        old = "".join(source[i][0] for i in removed)
        new = "".join(item[0] for item in added)
        if not old.strip() and not new.strip():
            # Spacing is not a text correction, except a word space missing or extra inside one OCR line.
            if mode != "ocr" or not interior(source, removed, before): continue
        if removed or added: edits.append((removed, added, before))
    # Digital-born extraction is the printed text: typed differences there were measured to be
    # retyping (substituted glyphs, "corrected" print typos), so they are reported, not applied.
    differences = [["".join(source[i][0] for i in removed), "".join(item[0] for item in added)] for removed, added, _ in edits]
    if mode == "digitalborn": edits = []
    content = [item for item in typed if item is not None and not item[0].isspace()]
    matched = sum(1 for item in owner.values() if not item[0].isspace())
    if content and matched < 0.3 * len(content):
        raise UnusableExtraction(f"Only {matched} of {len(content)} typed characters match the extracted lines")
    for n in unanchored: parsed[n]["unanchored"] = True
    texts = [block[1] for _, blocks in pages for block in blocks]
    return {"source": source, "parsed": parsed, "owner": owner, "changes": edits,
            "unanchored": [texts[n] for n in unanchored], "differences": differences,
            "typed_characters": len(content), "matched_characters": matched}


def interior(source, removed, before):
    a, b = (removed[0] - 1, removed[-1] + 1) if removed else (before, (before or 0) + 1)
    return a is not None and 0 <= a and b < len(source) and source[a] is not None and source[b] is not None \
        and source[a][1] == source[b][1]


def corrected(result, texts):
    """Scalar edits per line and the typed owner of every corrected character."""
    source, owner = result["source"], result["owner"]
    per_line, unplaced = {}, []
    def place(ident, start, end, added):
        per_line.setdefault(ident, []).append([start, end, added])
    for removed, added, before in result["changes"]:
        if removed:
            segments = {}
            for i in removed: segments.setdefault(source[i][1], []).append(source[i][2])
            for (ident, offsets), part in zip(segments.items(), divide(added, [len(v) for v in segments.values()])):
                place(ident, min(offsets), max(offsets) + 1, part)
            continue
        prev = before
        while prev is not None and prev >= 0 and source[prev] is None: prev -= 1
        nxt = (before + 1) if before is not None else 0
        while nxt < len(source) and source[nxt] is None: nxt += 1
        has_prev, has_next = prev is not None and prev >= 0, nxt < len(source)
        core = trim(added) or added
        if not core: continue
        # Missing text goes into a line only beside characters of its own block.
        block = core[0][1]
        joined = lambda i: owner.get(i) is not None and owner[i][1] == block
        if has_prev and has_next and source[prev][1] == source[nxt][1] and (joined(prev) or joined(nxt)):
            place(source[nxt][1], source[nxt][2], source[nxt][2], added)
        elif has_prev and joined(prev) and not (has_next and source[prev][1] == source[nxt][1]):
            # A space separates it only where the typed text has one or it follows a line break.
            ident, at = source[prev][1], source[prev][2] + 1
            spaced = (before is None or source[before] is None or added[0][0].isspace()) and not texts[ident][at - 1:at].isspace()
            place(ident, at, at, ([SPACE] if spaced else []) + core)
        elif has_next and joined(nxt) and not (has_prev and source[prev][1] == source[nxt][1]):
            spaced = source[nxt - 1] is None or added[-1][0].isspace()
            place(source[nxt][1], source[nxt][2], source[nxt][2], core + ([SPACE] if spaced else []))
        else:
            unplaced.append("".join(c[0] for c in core))
    edits, chars, kept = [], {}, []
    for ident, text in texts.items():
        at = {item[2]: index for index, item in enumerate(source) if item is not None and item[1] == ident}
        merged = []
        for change in sorted(per_line.get(ident, []), key=lambda e: (e[0], e[1])):
            if merged and change[0] <= merged[-1][1] and (change[0] < merged[-1][1] or change[0] == change[1] or merged[-1][0] == merged[-1][1]):
                merged[-1] = [merged[-1][0], max(merged[-1][1], change[1]), merged[-1][2] + change[2]]
            else:
                merged.append(change)
        merged = [m for m in merged if text[m[0]:m[1]] != "".join(c[0] for c in m[2])]
        line, cursor = [], 0
        for start, end, added in merged:
            line.extend((text[k], owner.get(at[k])) for k in range(cursor, start))
            line.extend((c[0], c if c[1] is not None else None) for c in added)
            cursor = end
        line.extend((text[k], owner.get(at[k])) for k in range(cursor, len(text)))
        if merged and not "".join(c for c, _ in line).strip():
            kept.append(ident)  # a line typed nowhere stays; correction cannot delete a physical line
            merged, line = [], [(text[k], owner.get(at[k])) for k in range(len(text))]
        if merged: edits.extend(scalar_edits(ident, text, "".join(c for c, _ in line)))
        chars[ident] = line
    return edits, chars, kept, unplaced


def scalar_edits(ident, old, new):
    """Edits from a line's text to its corrected text. An insertion takes in a neighbouring
    character, so no existing span edge is ambiguous; edits that then meet are one edit."""
    edits = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag == "equal": continue
        if i1 == i2: i1, i2, j1, j2 = (i1, i1 + 1, j1, j2 + 1) if i1 < len(old) else (i1 - 1, i1, j1 - 1, j2)
        if edits and i1 < edits[-1][1]:
            edits[-1] = (edits[-1][0], max(edits[-1][1], i2), edits[-1][2], max(edits[-1][3], j2))
        else:
            edits.append((i1, i2, j1, j2))
    return [{"line_id": ident, "start": a, "end": b, "old": old[a:b], "text": new[c:d]} for a, b, c, d in edits]


def trim(items):
    a, b = 0, len(items)
    while a < b and items[a][0].isspace(): a += 1
    while b > a and items[b - 1][0].isspace(): b -= 1
    return items[a:b]


def divide(items, sizes):
    """Share a replacement word by word over the source lines it replaces."""
    if len(sizes) == 1: return [items]
    words, current = [], []
    for item in items:
        current.append(item)
        if item[0].isspace(): words.append(current); current = []
    if current: words.append(current)
    result, used, total = [], 0, sum(sizes)
    for n in range(len(sizes)):
        share = len(words) if n == len(sizes) - 1 else round(len(words) * sum(sizes[:n + 1]) / total)
        result.append(trim([item for word in words[used:share] for item in word]))
        used = max(used, share)
    return result


def inside(span, members):
    return any(span["line_id"] == m["line_id"] and m["start"] <= span["start"] and span["end"] <= m["end"] for m in members)


def label(text):
    return unicodedata.normalize("NFKC", text).strip(" .()[]{}:")


def structure(chunks, lines, order):
    """Blocks, annotations and links over corrected lines.

    chunks: [(result, chars)] in reading order; lines: {id: {"text", "page"}} after correction;
    order: reading order of line ids. Returns the composition request parts and a report."""
    position = {ident: n for n, ident in enumerate(order)}
    blocks, owned = [], {}
    for result, chars in chunks:
        base = len(blocks)
        blocks.extend(result["parsed"])
        for ident, line in chars.items():
            owned[ident] = [(c, None if o is None else (base + o[1], o[2], o[3])) for c, o in line]
    report = {"lines_without_typed_text": [], "unlinked_continuations": [], "unmatched_references": [],
              "table_anchor_mismatch": []}
    # Characters the model did not type take the owner of their neighbours on the line, then on the page.
    for ident in order:
        if ident not in owned: continue
        line = owned[ident]
        last = None
        for n, (c, o) in enumerate(line):
            if o is not None: last = o[:2]
            elif last is not None: line[n] = (c, (*last, None))
        last = None
        for n in range(len(line) - 1, -1, -1):
            c, o = line[n]
            if o is not None: last = o[:2]
            elif last is not None: line[n] = (c, (*last, None))
    ids = [i for i in order if i in owned]
    for n, ident in enumerate(ids):
        if owned[ident] and owned[ident][0][1] is None:
            page = lines[ident]["page"]
            near = [j for j in reversed(ids[:n]) if lines[j]["page"] == page] + [j for j in ids[n + 1:] if lines[j]["page"] == page]
            source = next((j for j in near if owned[j] and owned[j][0][1] is not None), None) or \
                     next((j for j in reversed(ids[:n]) if owned[j] and owned[j][0][1] is not None), None) or \
                     next(j for j in ids[n + 1:] if owned[j] and owned[j][0][1] is not None)
            fill = owned[source][-1][1][:2] if position[source] < position[ident] else owned[source][0][1][:2]
            owned[ident] = [(c, (*fill, None)) for c, _ in owned[ident]]
            report["lines_without_typed_text"].append(lines[ident]["text"])
    def spans(key, strip=False):
        result = {}
        for ident in ids:
            line, n = owned[ident], 0
            while n < len(line):
                k = key(line[n][1])
                m = n
                while m < len(line) and key(line[m][1]) == k: m += 1
                if k is not None:
                    a, b = n, m
                    if strip:
                        while a < b and line[a][0].isspace(): a += 1
                        while b > a and line[b - 1][0].isspace(): b -= 1
                    if a < b: result.setdefault(k, []).append({"line_id": ident, "start": a, "end": b})
                n = m
        return result
    block_spans = spans(lambda o: o[0])
    cell_spans = spans(lambda o: o[:2], strip=True)
    markers = spans(lambda o: o[0] if o[2] == "marker" else None, strip=True)
    for found in markers.values():
        # An opening quotation mark stays in the text but outside the printed marker.
        while found and lines[found[0]["line_id"]]["text"][found[0]["start"]] in OPENING:
            found[0]["start"] += 1
            if found[0]["start"] == found[0]["end"]: found.pop(0)
    references = spans(lambda o: (o[0], o[2][1]) if isinstance(o[2], tuple) else None, strip=True)
    anchor = lambda span: f"{span['line_id']}@{span['start']}"
    groups, annotations, fragments = [], [], {}
    for number, block in enumerate(blocks):
        members = sorted(block_spans.get(number, []), key=lambda s: (position[s["line_id"]], s["start"]))
        pages = {}
        for span in members: pages.setdefault(lines[span["line_id"]]["page"], []).append(span)
        fragments[number] = []
        for index, part in enumerate(pages.values()):
            attributes = {"parent": None, "reading_stream_id": None}
            mark = [s for s in markers.get(number, []) if index == 0 and inside(s, part)]
            if block["region"] in MARKED and mark: attributes["marker"] = mark
            if block["region"] == "list_item": attributes.update(locator_kind="list_item", marker=mark)
            elif block["region"] in {"text", "quote"} and mark: attributes["locator_kind"] = "paragraph"
            groups.append({"kind": ROLES.get(block["region"], block["region"]), "spans": part, "attributes": attributes})
            item = {"block": anchor(part[0]), "spans": part, "label": mark, "group": groups[-1]}
            if block["region"] == "note":
                item["annotation"] = {"id": "", "kind": "note", "spans": part,
                                      "attributes": {"kind": "footnote", "label": mark, "references": []}}
                annotations.append(item["annotation"])
            fragments[number].append(item)
        if block["region"] == "table" and members:
            table_fragments(block, number, cell_spans, lines, position, fragments[number], annotations, report)
    # Documents: each flagged block opens a constituent of one root at the first block.
    at = lambda span: (position[span["line_id"]], span["start"])
    def straddled(opening):
        o = at(opening)
        return any(at(g["spans"][0]) < o and (position[s["line_id"]], s["end"] - 1) >= o
                   for g in groups for s in g["spans"])
    starts = [n for n, b in enumerate(blocks) if "document" in b["flags"] and fragments[n]]
    report["document_starts_inside_blocks"] = [blocks[n]["region"] for n in starts if straddled(fragments[n][0]["spans"][0])]
    starts = [n for n in starts if not straddled(fragments[n][0]["spans"][0])]
    first = min((n for n in fragments if fragments[n]), key=lambda n: at(fragments[n][0]["spans"][0]), default=None)
    documents = []
    if starts and first is not None:
        root = "document:" + fragments[first][0]["block"]
        for n in [first] + [n for n in starts if n != first]:
            opening = fragments[n][0]["spans"][0]
            documents.append({"id": "document:" + anchor(opening), "kind": "document", "spans": [opening],
                              "attributes": {"kind": None, "parent": None if n == first else root,
                                             "relationship": None, "title": [], "facets": {}}})
        annotations.extend(documents)
    opens = sorted(at(d["spans"][0]) for d in documents)
    scope = lambda span: sum(1 for o in opens if o <= at(span))
    # A note reference names the note with the same printed label: the next one, else the last
    # before. The shared composition gives a note to the document of its references; a note
    # referenced from two documents keeps the references of the document it is printed in.
    text = lambda members: label("".join(lines[s["line_id"]]["text"][s["start"]:s["end"]] for s in members))
    notes = [(n, text(fragments[n][0]["label"])) for n, b in enumerate(blocks)
             if b["region"] == "note" and fragments[n] and fragments[n][0]["label"]]
    report["references"] = sum(len(b["references"]) for b in blocks)
    report["references_linked"] = 0
    for (number, k), refs in sorted(references.items()):
        printed = text(refs)
        candidates = [n for n, value in notes if value == printed]
        target = next((n for n in candidates if n > number), candidates[-1] if candidates else None)
        if target is None or len(refs) != 1:
            report["unmatched_references"].append(printed); continue
        fragments[target][0]["annotation"]["attributes"]["references"].extend(refs)
    for n, _ in notes:
        note = fragments[n][0]["annotation"]["attributes"]
        if len({scope(r) for r in note["references"]}) > 1:
            here = scope(fragments[n][0]["spans"][0])
            report["unmatched_references"].extend(text([r]) for r in note["references"] if scope(r) != here)
            note["references"] = [r for r in note["references"] if scope(r) == here]
        report["references_linked"] += len(note["references"])
    # Block quotations: a quote block opens one, quoted blocks and continued quotes extend the open
    # one, other running text closes it. One annotation per page, linked across pages.
    continuations, quotations, current = {}, [], None
    for number, block in enumerate(blocks):
        if not fragments[number]: continue
        if block["region"] == "quote" and not ("continued" in block["flags"] and quotations):
            current = [number]; quotations.append(current)
        elif block["region"] == "quote" or "quoted" in block["flags"]:
            if current is None:
                current = quotations[-1] if "continued" in block["flags"] and quotations else []
                if not current: quotations.append(current)
            current.append(number)
        elif block["region"] not in {"furniture", "page_label", "note"}:
            current = None
    for members in quotations:
        pages = {}
        for n in members:
            for part in fragments[n]: pages.setdefault(lines[part["spans"][0]["line_id"]]["page"], []).extend(part["spans"])
        previous = None
        for page_spans in pages.values():
            page_spans.sort(key=at)
            annotations.append({"id": "", "kind": "quotation", "spans": page_spans,
                                "attributes": {"layout": "display", "attribution": []}})
            if previous is not None:
                continuations.setdefault("quotation", {})[anchor(previous[0])] = {
                    "next": anchor(page_spans[0]), "separator": None, "kind": "quotation"}
            previous = page_spans
    outgoing, incoming = set(), set()
    place = lambda ident: (position[ident.rsplit("@", 1)[0]], int(ident.rsplit("@", 1)[1]))
    def link(region, left, right, why):
        kind, separator = LINKS.get(region, (None, None))
        a, b = left.get("table_anchor", left["block"]) if kind == "table" else left["block"], \
               right.get("table_anchor", right["block"]) if kind == "table" else right["block"]
        if kind is None or (kind == "table" and ("table_anchor" not in left or "table_anchor" not in right)) \
                or (kind, a) in outgoing or (kind, b) in incoming or place(a) >= place(b) \
                or scope(left["spans"][0]) != scope(right["spans"][0]):
            # A link runs forward to a fragment nothing else continues into.
            report["unlinked_continuations"].append({"region": region, "reason": why}); return
        outgoing.add((kind, a)); incoming.add((kind, b))
        continuations.setdefault(kind, {})[a] = {"next": b, "separator": separator, "kind": kind}
        if kind == "paragraph" and left["group"]["attributes"].get("locator_kind") == "list_item"                 and right["group"]["attributes"].get("locator_kind") in (None, "list_item"):
            # A list item's text continues, and so does the list: the fragment is that item's.
            right["group"]["attributes"].update(locator_kind="list_item", marker=right["group"]["attributes"].get("marker", []))
            continuations.setdefault("list", {})[a] = {"next": b, "separator": None, "kind": "list"}
    # A continued block resumes the latest earlier block of its stream: notes, tables, quotations
    # or the running text.
    family = lambda block: "quote" if block["region"] == "quote" or "quoted" in block["flags"] else \
        block["region"] if block["region"] in {"note", "table"} else None if block["region"] in {"furniture", "page_label"} else "text"
    last = {}
    for number, block in enumerate(blocks):
        parts = fragments[number]
        if not parts: continue
        stream = family(block)
        if "continued" in block["flags"]:
            earlier = last.get(stream)
            if earlier is None or blocks[earlier]["region"] != block["region"] and ROLES.get(blocks[earlier]["region"], blocks[earlier]["region"]) != ROLES.get(block["region"], block["region"]):
                report["unlinked_continuations"].append({"region": block["region"], "reason": "no earlier block of its kind"})
            else: link(block["region"], fragments[earlier][-1], parts[0], "flag")
        for left, right in zip(parts, parts[1:]): link(block["region"], left, right, "page break")
        if stream: last[stream] = number
    return {"groups": groups, "annotations": annotations, "continuations": continuations}, report


def table_fragments(block, number, cell_spans, lines, position, parts, annotations, report):
    """One table annotation per page fragment, rows on the page of their first text."""
    width, pages = block["width"], [lines[p["spans"][0]["line_id"]]["page"] for p in parts]
    rows, current = {}, pages[0]
    for r in range(block["rows"]):
        cells = [sorted(cell_spans.get((number, r * width + c), []), key=lambda s: (position[s["line_id"]], s["start"])) for c in range(width)]
        found = [s for cell in cells for s in cell]
        if found: current = lines[min(found, key=lambda s: (position[s["line_id"]], s["start"]))["line_id"]]["page"]
        rows.setdefault(current, []).append([[s for s in cell if lines[s["line_id"]]["page"] == current] for cell in cells])
    for page, part in zip(pages, parts):
        grid = rows.get(page, [])
        populated = [s for row in grid for cell in row for s in cell]
        if not populated: continue
        first = next(cell[0] for row in grid for cell in row if cell)
        earliest = min(populated, key=lambda s: (position[s["line_id"]], s["start"]))
        if first != earliest:
            report["table_anchor_mismatch"].append(page); continue
        annotations.append({"id": "", "kind": "table", "spans": sorted(populated, key=lambda s: (position[s["line_id"]], s["start"])),
                            "attributes": {"rows": grid, "header_rows": [], "merges": []}})
        part["table_anchor"] = f"{first['line_id']}@{first['start']}"
