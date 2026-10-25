"""The lines pass's answers read onto the extracted lines.

The model is shown each page's extracted lines numbered and gives every line in reading order: its
text, null where it reads as printed, the line as printed where the extraction misread it or left
text out, or a printed line the extraction missed
(line 0); its region, whether it starts a unit, its table cell, its printed markers, each as
printed with which occurrence on the line it is, and its note references, each by its mark and the
word printed before it. The model's text is the gold's: a line it gives otherwise is corrected to
it, on any page. A marker is placed where its characters stand in that text. Each line is given
once and its piece covers it; a line the answer leaves out is reported as uncovered.
"""
import unicodedata

from prompts import REGIONS

FOLD = str.maketrans({"‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'",
                      "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
                      "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
                      "―": "-", "−": "-", "­": "-"})


def require(ok, message):
    if not ok: raise ValueError(message)


def fold(text):
    """The text compared loosely (compatibility forms, quote and dash styles, case), character for
    character, so a position in it is a position in the text."""
    def one(c):
        folded = unicodedata.normalize("NFKC", c).translate(FOLD).lower()
        return folded if len(folded) == 1 else c.lower() if len(c.lower()) == 1 else c
    return "".join(one(c) for c in text)


def same(a, b):
    """Two texts that read alike: case, compatibility forms, quote and dash styles and spacing aside."""
    return " ".join(fold(a).split()) == " ".join(fold(b).split())


def numbered(by_page, targets):
    """{call line number: (page, line id, text)} for the target pages' extracted lines, numbered
    1.. in page and reading order across the call."""
    result, n = {}, 0
    for page in targets:
        for line in by_page.get(page, []):
            n += 1
            result[n] = (page, line["id"], line["text"])
    return result


def units(answer):
    """A page's lines, as the model gave them, grouped into units: a unit begins where a line
    starts one or changes region; a table row's lines fall into its cells by number. A unit whose
    first line does not start one continues a unit from before it (the page before's, across the
    page break). A line is given once: a repeat is passed over."""
    found, seen = [], set()
    for entry in answer["lines"]:
        if entry["line"] in seen: continue
        if entry["line"]: seen.add(entry["line"])
        piece = {"line": entry["line"], "text": entry["text"], "markers": entry["markers"]}
        references = [{"line": entry["line"], **r} for r in entry["references"]]
        unit = found[-1] if found else None
        if unit is None or entry["starts"] or entry["region"] != unit["region"]:
            unit = {"region": entry["region"], "lines": [], "cells": [], "references": [], "cell": None,
                    "starts": entry["starts"]}
            found.append(unit)
        if unit["region"] == "table":
            if entry["cell"] != unit["cell"] or not unit["cells"]: unit["cells"].append([])
            unit["cell"] = entry["cell"]
            unit["cells"][-1].append(piece)
        else:
            unit["lines"].append(piece)
        unit["references"] += references
    for unit in found: del unit["cell"]
    return found


def validator(lines, targets):
    """Checks one lines-pass answer against its numbered lines, leaving it as the model gave it (it
    is the call's cached response); returns it. A line the answer leaves out is reported (read),
    not asked again."""
    on_page = {}
    for n, (page, _, _) in lines.items():
        on_page.setdefault(page, set()).add(n)
    def validate(response):
        require([answer["page"] for answer in response["pages"]] == list(targets),
                f"Answer pages {', '.join(map(str, targets))}, in that order, each once")
        for page, answer in zip(targets, response["pages"]):
            for entry in answer["lines"]:
                n = entry["line"]
                require(n == 0 or n in on_page.get(page, ()), f"Line {n} is not on page {page}")
                require(n or (entry["text"] or "").strip(), "A line the extraction missed (line 0) gives its text")
        return response
    return validate


def read(lines, targets, response):
    """The answer placed on the extracted lines. Returns (typed lines in reading order, corrected
    texts {line id: text}, a report). A typed line is {page, region, text, start, spans, markers,
    references[, cells]}. A marker not printed on its line returns the answer to the model."""
    report = {"unanchored_lines": [], "unplaced_references": [], "uncovered_lines": [], "unplaced_markers": []}
    texts = {n: text for n, (_, _, text) in lines.items()}
    # Each line's piece; a line given otherwise is corrected to its text.
    grouped = [units(answer) for answer in response["pages"]]
    piece_of = {}
    for found in grouped:
        for unit in found:
            for piece in ([p for cell in unit["cells"] for p in cell] if unit["region"] == "table" else unit["lines"]):
                if piece["line"]: piece_of[piece["line"]] = piece
    report["uncovered_lines"] = [texts[n] for n in texts if n not in piece_of]
    corrected = {n: p["text"].strip() for n, p in piece_of.items() if p["text"] is not None and not same(p["text"], texts[n])}
    final = {n: corrected.get(n, texts[n]) for n in texts}
    typed = []
    for page, found in zip(targets, grouped):
        for u, unit in enumerate(found):
            start_flag = unit["starts"]
            table = unit["region"] == "table"
            groups = unit["cells"] if table else [[p] for p in unit["lines"]]
            items, missed, markers = [], [], []
            for cell in groups:
                spans = []
                for piece in cell:
                    n = piece["line"]
                    if not n:
                        report["unanchored_lines"].append(piece["text"])
                        report["unplaced_markers"] += [m["text"] for m in piece["markers"]]
                        missed.append((len(items), piece["text"].strip()))
                        continue
                    spans.append({"line_id": lines[n][1], "start": 0, "end": len(final[n]), "n": n})
                    markers += [(len(items), kind, span) for kind, span in place_markers(piece["markers"], n, lines[n][1], final[n])]
                items.append((spans, None))
            references = place_references(unit, items, lines, final, report)
            # Each item's text as typed: its lines' text, a note reference written [^mark] where it stands.
            marks = {}
            for found in references.values():
                for reference in found:
                    span = reference["spans"][0]
                    marks.setdefault(span["line_id"], []).append((span["start"], span["end"], reference["label"]))
            def written(span):
                text, cursor, out = final[span["n"]], span["start"], []
                for a, b, label in sorted(marks.get(span["line_id"], [])):
                    if span["start"] <= a < span["end"]:
                        out += [text[cursor:a], f"[^{label}]"]; cursor = b
                return ("".join(out) + text[cursor:span["end"]]).strip()
            items = [(spans, [written(s) for s in spans] + [t for k, t in missed if k == i]) for i, (spans, _) in enumerate(items)]
            if table:
                spans = [s for cell, _ in items for s in cell]
                typed.append({"page": page, "region": "table", "start": start_flag,
                              "text": " | ".join(" ".join(w for w in words if w) for _, words in items),
                              "spans": strip(spans), "cells": [strip(cell) for cell, _ in items],
                              **labelled(markers, lambda at: True), "references": references.get(0, [])})
                continue
            for k, (spans, words) in enumerate(items):
                typed.append({"page": page, "region": unit["region"], "start": start_flag and k == 0,
                              "text": " ".join(w for w in words if w), "spans": strip(spans),
                              **labelled(markers, lambda at: at == k), "references": references.get(k, [])})
    return typed, {lines[n][1]: text for n, text in corrected.items()}, report


def strip(spans):
    return [{key: s[key] for key in ("line_id", "start", "end")} for s in spans]


def labelled(markers, keep):
    """A typed line's printed labels by kind: the unit's markers, transcript line numbers and
    speaker labels."""
    return {"markers": [[m] for at, kind, m in markers if keep(at) and kind == "number"],
            "line_number": [m for at, kind, m in markers if keep(at) and kind == "line_number"],
            "speaker": [m for at, kind, m in markers if keep(at) and kind == "speaker"]}


def place_markers(markers, n, line_id, text):
    """(kind, span) of each label the model gave for line n: each where the given occurrence of
    its characters stands in the line's text."""
    found = []
    for marker in markers:
        chars, at = marker["text"].strip(), -1
        for _ in range(max(1, marker["occurrence"])):
            at = text.find(chars, at + 1) if chars else -1
            if at < 0: break
        require(at >= 0, f"Line {n} does not print the marker {chars!r} {max(1, marker['occurrence'])} time(s): give a marker exactly as the line prints it")
        found.append((marker["kind"], {"line_id": line_id, "start": at, "end": at + len(chars)}))
    return found


def find_mark(text, mark, after):
    """Where a note reference's printed mark stands in its line: after the word printed before it,
    or -1."""
    folded, word = fold(text), fold(after).strip()
    at = folded.find(word) + len(word) if word and word in folded else 0
    target = fold(mark.strip()).strip("[]()")
    return folded.find(target, at) if target else -1


def place_references(unit, items, lines, final, report):
    """{item: [{label, spans}]} for the unit's note references, each the mark found after the word
    printed before it on its line."""
    result = {}
    for reference in unit["references"]:
        mark, n = reference["mark"].strip(), reference["line"]
        position = find_mark(final.get(n, ""), mark, reference["after"])
        if position < 0:
            report["unplaced_references"].append(mark)
            continue
        length = len(mark.strip("[]()"))
        owner = next((k for k, (spans, _) in enumerate(items) for s in spans
                      if s["n"] == n and s["start"] <= position < max(s["end"], s["start"] + 1)), 0)
        result.setdefault(owner, []).append({"label": mark, "spans": [{"line_id": lines[n][1], "start": position, "end": position + length}]})
    return result
