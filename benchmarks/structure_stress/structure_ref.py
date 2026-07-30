"""Faithful port of ALR's corpus-proven structure detectors.

Source: ALR-Quote-Verifier verifier_core/a2aj_structure.py (read-only
reference). paragraph_index and its helpers are transcribed verbatim —
three label conventions, monotone scope competition with gap tolerance,
min-run gating, and the four guards whose constants the failure
taxonomy validated (an independently-built v2 rediscovered them
exactly). The 60-doc hand-verified sample scored the reference at 95%
presence accuracy and 93% flag precision where the naive line-start
bracket detector managed 43% / 31%.

Beaver-measured EXTENSIONS live under names ending _EXT and are never
silently substituted for the faithful base: the section lookahead
additions (letter-suffixed provisions, label-alone-on-line, repeal/stub
followers) lifted LEGISLATION-NS 0.795 -> 0.963 and YT 0.981 -> 0.994
with precision unchanged, validated on held-out splits. Range
expansion and named-heading recovery are oracle-justified general
mechanisms (the pre-1985 federal oracle collapses 51.6% of its labels
into ranges; 4.18% of all oracle labels are non-numeric).

Run `python -X utf8 structure_ref.py --parity` with the reference repo
present to prove the paragraph port byte-equal over live corpus text.
"""

from __future__ import annotations

import re
import statistics
from functools import lru_cache

Paragraph = tuple[int, int, int, str]
Page = tuple[int, int, int, str]

REFERENCE = (
    r"C:\Users\elias\Desktop\Martys Qote Verifier"
    r"\ALR-Quote-Verifier\verifier_core"
)

# --- faithful transcription: a2aj_structure.py ------------------------

PARAGRAPH_MARK_RE = re.compile(
    r"^[ \t]*(?:\[(\d{1,4})\]|(\d{1,4})\.(?=\s)|(\d{1,4})(?=\s))",
    re.MULTILINE,
)
PAGE_MARK_RE = re.compile(
    r"\[[ \t]*pages?[ \t]*[.:,;]?[ \t]*(\d{1,4})[ \t]*[.:,;]?[ \t]*[\]\[)}]?[ \t]*[.,;:]?"
    r"|^[ \t]*\[?[ \t]*page[ \t]*[.:,;]?[ \t]*(\d{1,4})[ \t]*[\])}]?[ \t]*[.,;:]?[ \t]*$",
    re.I | re.M,
)
PAGE_WORD_RE = re.compile(r"page", re.I)
REPORT_PAGE_RE = re.compile(r"\b(?:S\.?C\.?R\.?|R\.?C\.?S\.?)\s+(\d{1,4})\b", re.I)
WORD_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)

SECTION_MARK_RE = re.compile(
    r"^[ \t]*(\d{1,8}(?:[.-]\d{1,8}){0,3})"
    r"(?=[ \t]+(?:\(?\d|[A-Za-zÀ-ÿ])|[ \t]*\()",
    re.MULTILINE,
)


def _word_count(text: str) -> int:
    return len(WORD_RE.findall(text or ""))


def monotone_scopes(
    markers: list[tuple[int, int]], *, max_gap: int = 8
) -> list[list[tuple[int, int]]]:
    """Assign markers to strictly increasing scopes in O(max_gap * markers)."""
    scopes: list[list[tuple[int, int]]] = []
    by_last: dict[int, list[int]] = {}
    for marker in markers:
        number = marker[1]
        candidates = [index for prior in range(number - max_gap, number)
                      for index in by_last.get(prior, ())]
        if candidates:
            index = min(candidates, key=lambda i: (scopes[i][0][1], i))
            previous = scopes[index][-1][1]
            by_last[previous].remove(index)
            if not by_last[previous]:
                del by_last[previous]
            scopes[index].append(marker)
        else:
            scopes.append([marker])
            index = len(scopes) - 1
        by_last.setdefault(number, []).append(index)
    return scopes


def _numbered_index(
    text: str, markers: list[tuple[int, int]], all_offsets: list[int]
) -> list[Paragraph]:
    next_offset = {offset: all_offsets[i + 1] if i + 1 < len(all_offsets) else len(text)
                   for i, offset in enumerate(all_offsets)}
    return [
        (number, start, next_offset[start], text[start:next_offset[start]])
        for start, number in markers
    ]


@lru_cache(maxsize=32)
def paragraph_index(text: str, *, min_run: int = 5) -> list[Paragraph]:
    """Return the strongest substantive, monotone decision-paragraph scope."""
    if not text:
        return []
    markers: list[tuple[int, int, str]] = []
    for match in PARAGRAPH_MARK_RE.finditer(text):
        bracket, dot, bare = match.groups()
        markers.append((match.start(), int(bracket or dot or bare),
                        "bracket" if bracket else "dot" if dot else "bare"))
    hypotheses: list[tuple[str, list[tuple[int, int]]]] = []
    for style in ("bracket", "dot", "bare"):
        styled = [(offset, number) for offset, number, marker_style in markers if marker_style == style]
        for scope in monotone_scopes(styled):
            if len(scope) >= min_run:
                hypotheses.append((style, scope))
    if not hypotheses:
        return []
    rank = {"bracket": 2, "dot": 1, "bare": 0}
    primary = [item for item in hypotheses if item[1][0][1] <= 5]
    ordered = sorted(primary or hypotheses,
                     key=lambda item: (len(item[1]), rank[item[0]], -item[1][0][1]), reverse=True)
    for style, candidate in ordered:
        out = _numbered_index(text, candidate, [offset for offset, _number, marker_style in markers
                                                if marker_style == style])
        # A short numbered list followed by a long unnumbered tail otherwise
        # looks like a document-spanning paragraph sequence because the final
        # item inherits EOF as its boundary.  Marker coverage, not that tail,
        # is the structural evidence.
        marker_span = (out[-1][1] - out[0][1]) / len(text)
        start_ratio = out[0][1] / len(text)
        bounded = out[:-1] or out
        median_words = statistics.median(_word_count(item[3]) for item in bounded)
        if median_words < 12 or marker_span < 0.05:
            continue
        if style != "bracket" and sum(_word_count(item[3]) >= 12 for item in out) / len(out) < 0.70:
            continue
        # Bare short ladders near the tail are usually lists/endnotes.
        if style == "bare" and (median_words < 20 or marker_span < 0.15 or start_ratio > 0.70):
            continue
        return out
    return []


def reporter_start_page(*citations: str) -> int | None:
    for citation in citations:
        match = REPORT_PAGE_RE.search(citation or "")
        if match:
            return int(match.group(1))
    return None


def page_markers(text: str, report_start: int | None = None) -> list[tuple[int, int, int]]:
    """Observed Page tokens as (label, marker start, following-text start)."""
    if not text or PAGE_WORD_RE.search(text) is None:
        return []
    markers: list[tuple[int, int, int]] = []
    prior_end = -1
    for match in PAGE_MARK_RE.finditer(text or ""):
        number = int(match.group(1) or match.group(2))
        if match.start() < prior_end or (report_start is not None and number < report_start):
            continue
        markers.append((number, match.start(), match.end()))
        prior_end = match.end()
    return markers


@lru_cache(maxsize=32)
def page_structure(
    text: str, report_start: int | None = None, *, require_report_start: bool = False
) -> list[Page]:
    if require_report_start and report_start is None:
        return []
    markers = page_markers(text, report_start)
    scopes: list[list[tuple[int, int, int]]] = []
    by_last: dict[int, list[int]] = {}
    for marker in markers:
        candidates = by_last.get(marker[0] - 1, [])
        if candidates:
            scope_index = max(candidates, key=lambda item: scopes[item][-1][1])
            prior = scopes[scope_index][-1][0]
            by_last[prior].remove(scope_index)
            if not by_last[prior]:
                del by_last[prior]
            scopes[scope_index].append(marker)
        else:
            scopes.append([marker])
            scope_index = len(scopes) - 1
        by_last.setdefault(marker[0], []).append(scope_index)
    ranked = sorted((scope for scope in scopes if len(scope) >= 3), key=len, reverse=True)
    if not ranked or (len(ranked) > 1 and len(ranked[0]) == len(ranked[1])):
        return []
    best = ranked[0]
    pages = [
        (number, content_start, best[i + 1][1], text[content_start:best[i + 1][1]])
        for i, (number, _marker_start, content_start) in enumerate(best[:-1])
    ]
    if report_start is not None and best[0][0] == report_start + 1:
        pages.insert(0, (report_start, 0, best[0][1], text[:best[0][1]]))
    return pages


# --- Beaver-measured extensions (never substituted for the base) ------

SECTION_MARK_RE_EXT = re.compile(
    # Base label plus up to two capital suffix letters (5A, 17W —
    # LEGISLATION-NS), lookahead widened for label-alone-on-line and
    # repeal/quote stubs. Held-out validated: NS .795->.963, YT
    # .981->.994, precision unchanged.
    r"^[ \t]*(\d{1,8}(?:[.-]\d{1,8}){0,3}[A-Z]{0,2})"
    r"(?=[ \t]+(?:\(?\d|[A-Za-zÀ-ÿ]|[\[*“\"«])|[ \t]*\(|[ \t]*$)",
    re.MULTILINE,
)

LAW_BOLD_RE = re.compile(r"\*\*(\d{1,4}(?:\.\d{1,4})*[A-Z]{0,2})\*\*")

_RANGE_RE = re.compile(
    r"^[ \t]*(?:\*\*)?(\d{1,4}(?:\.\d{1,4})*)"
    r"[ \t]+(?:to|and|à|a|et)[ \t]+"
    r"(\d{1,4}(?:\.\d{1,4})*)(?:\*\*)?(?=[ \t]|$)",
    re.MULTILINE | re.IGNORECASE,
)

_NAMED_HEAD_RE = re.compile(
    r"^#{1,4}[ \t]+[\"“«]?[ \t]*"
    r"(Schedule|Annexe|Form|Formule|Appendix|Appendice|Table|Tableau|"
    r"Preamble|Préambule|Order|Ordonnance)"
    r"[ \t]*[\"”»]?[ \t]*([A-Za-z0-9IVXLC\"“”]{0,12})",
    re.MULTILINE | re.IGNORECASE,
)

_NAMED_CANON = {
    "annexe": "Schedule", "formule": "Form", "appendice": "Appendix",
    "tableau": "Table", "préambule": "Preamble", "ordonnance": "Order",
}

RANGE_EXPANSION_CAP = 400


def expand_ranges(text: str) -> set[str]:
    """Labels recovered from 'N to M' / 'N et M' repeal-range lines.

    The pre-1985 federal oracle collapses 51.6% of its labels into such
    lines; integer interiors only, span capped so a stray match cannot
    fabricate thousands of labels.
    """
    labels: set[str] = set()
    for match in _RANGE_RE.finditer(text):
        lo_raw, hi_raw = match.group(1), match.group(2)
        labels.add(lo_raw)
        labels.add(hi_raw)
        if "." not in lo_raw and "." not in hi_raw:
            lo, hi = int(lo_raw), int(hi_raw)
            if lo < hi <= lo + RANGE_EXPANSION_CAP:
                labels.update(str(n) for n in range(lo, hi + 1))
    return labels


def named_heading_labels(text: str) -> set[str]:
    """'## SCHEDULE "A"' -> 'Schedule A'; repeats gain (n) like the oracle."""
    seen: dict[str, int] = {}
    labels: set[str] = set()
    for match in _NAMED_HEAD_RE.finditer(text):
        kind_raw = match.group(1).lower()
        kind = _NAMED_CANON.get(kind_raw, kind_raw.capitalize())
        tail = match.group(2).strip(' "“”').strip()
        label = f"{kind} {tail}".strip()
        count = seen.get(label, 0) + 1
        seen[label] = count
        labels.add(label if count == 1 else f"{label} ({count})")
    return labels


def law_section_labels(text: str) -> dict[str, set[str]]:
    """Per-detector label sets for recovery AND precision scoring."""
    return {
        "alr_line": {m.group(1) for m in SECTION_MARK_RE.finditer(text)},
        "alr_ext": {m.group(1) for m in SECTION_MARK_RE_EXT.finditer(text)},
        "bold": {m.group(1) for m in LAW_BOLD_RE.finditer(text)},
        "ranges": expand_ranges(text),
        "named": named_heading_labels(text),
    }


_ENDNOTE_MAX_MEDIAN_WORDS = 25
_ENDNOTE_MIN_START_RATIO = 0.70


def endnote_index(text: str) -> list[Paragraph]:
    """Tail note/authority ladders — the scopes paragraph_index REJECTS.

    Beaver extension built from the measured separation in the failure
    taxonomy: endnote ladders sit in the tail (start_ratio ~0.98) with
    short entries (median 21-25 words) where real paragraph scopes span
    the document (0.909) with 300-word medians. 10% of a 1,127-doc
    cross-court sample carries one; near-total for pre-1970 SCC.
    """
    if not text:
        return []
    markers: list[tuple[int, int, str]] = []
    for match in PARAGRAPH_MARK_RE.finditer(text):
        bracket, dot, bare = match.groups()
        markers.append((match.start(), int(bracket or dot or bare),
                        "bracket" if bracket else "dot" if dot else "bare"))
    best: list[Paragraph] = []
    for style in ("bracket", "dot", "bare"):
        styled = [(offset, number) for offset, number, marker_style in markers
                  if marker_style == style]
        offsets = [offset for offset, _n in styled]
        for scope in monotone_scopes(styled):
            if len(scope) < 3 or len(scope) <= len(best):
                continue
            out = _numbered_index(text, scope, offsets)
            if out[0][1] / max(1, len(text)) < _ENDNOTE_MIN_START_RATIO:
                continue
            bounded = out[:-1] or out
            if statistics.median(_word_count(i[3]) for i in bounded) > _ENDNOTE_MAX_MEDIAN_WORDS:
                continue
            best = out
    return best


def structure_cascade(text: str, *citations: str) -> dict:
    """Never report 'nothing' without having looked for everything.

    paragraphs -> pages (reporter-anchored when the citation names an
    SCR page) -> endnote ladders -> heading hints. Only all-empty earns
    kind 'none', and that bucket is a close-inspection queue.
    """
    paragraphs = paragraph_index(text)
    if paragraphs:
        return {"kind": "paragraphs", "count": len(paragraphs),
                "first": paragraphs[0][0], "last": paragraphs[-1][0],
                "span": round((paragraphs[-1][1] - paragraphs[0][1]) / max(1, len(text)), 4)}
    report_start = reporter_start_page(*citations)
    pages = page_structure(text, report_start)
    if pages:
        return {"kind": "pages", "count": len(pages),
                "first": pages[0][0], "last": pages[-1][0],
                "reporter_anchored": report_start is not None}
    notes = endnote_index(text)
    if notes:
        return {"kind": "endnotes", "count": len(notes),
                "first": notes[0][0], "last": notes[-1][0]}
    lines = text.splitlines()
    headingish = sum(
        1 for line in lines
        if 3 <= len(line.strip()) <= 60
        and (line.strip().isupper() or line.strip().rstrip(":").istitle())
    )
    return {"kind": "none", "heading_hint_lines": headingish,
            "lines": len(lines)}


def _parity(sample: int) -> int:
    import sys

    sys.path.insert(0, REFERENCE)
    import a2aj_structure as ref  # noqa: PLC0415

    import duckdb  # noqa: PLC0415

    base = "C:/Users/elias/AppData/Local/ALR Quote Verifier/a2aj_corpus"
    rows = duckdb.connect().execute(
        f"""
        select unofficial_text_en from read_parquet('{base}/cases/*/train.parquet')
        where unofficial_text_en is not null
        using sample {sample} rows (reservoir, 42)
        """
    ).fetchall()
    mismatches = 0
    for (text,) in rows:
        if ref.paragraph_index(text) != paragraph_index(text):
            mismatches += 1
    print(f"parity: {len(rows)} docs, {mismatches} mismatches")
    return 1 if mismatches else 0


if __name__ == "__main__":
    import sys

    if "--parity" in sys.argv:
        raise SystemExit(_parity(300))
    print(__doc__)
