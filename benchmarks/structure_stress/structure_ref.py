"""REFERENCE/COMPATIBILITY CODE ONLY; never a production or sweep candidate.

The measured Beaver candidate is always shipping ``compileA2AJSourceDoc`` via
``backend/scripts/sourcedoc-jsonl.ts``. No product correctness claim may be
derived from this module; it exists only to reproduce historical ALR behavior
for compatibility analysis.

Faithful port of ALR's corpus-proven structure detectors.

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
expansion and named-heading recovery are provider-section-map-supported
mechanisms (the pre-1985 federal maps collapse 51.6% of their labels
into ranges; 4.18% of all provider-map labels are non-numeric).

Paragraph-side extensions (2026-07-30, from the full-sweep none-queue
close inspection: 17/29 sampled "no structure" docs were complete
[1]..[N] ladders the guards rejected): short complete bracket ladders
(contiguous from 1, ladder owns the doc) are accepted below min_run;
the substance guard is median>=12 OR mean>=20 words so "I agree."
concurrence tails cannot sink a real ladder; cascade span credits the
final paragraph's body bounded by 2x median length. These deliberately
diverge from the ALR reference — `--parity` now reports the docs the
extensions newly capture; parity on the accepted-by-both set is the
invariant that must hold.
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
FIDELITY_ENGINE_SRC = r"..\..\universal-legal-pdf-engine\src"

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
    hypotheses: list[tuple[str, list[tuple[int, int]], bool]] = []
    for style in ("bracket", "dot", "bare"):
        styled = [(offset, number) for offset, number, marker_style in markers if marker_style == style]
        for scope in monotone_scopes(styled):
            if len(scope) >= min_run:
                hypotheses.append((style, scope, False))
            elif (
                style == "bracket"
                and len(scope) >= 2
                and [n for _, n in scope] == list(range(1, len(scope) + 1))
            ):
                # Complete short [1]..[N] ladders are real structure in
                # short orders / oral reasons / costs rulings — 17 of 29
                # docs in the none-queue close-inspection sample
                # (2026-07-30) were exactly this shape, killed by min_run.
                # Contiguity from 1 excludes quoted-fragment ladders and
                # bracketed years ([1999] parses as 1999).
                hypotheses.append((style, scope, True))
    if not hypotheses:
        return []
    rank = {"bracket": 2, "dot": 1, "bare": 0}
    # Short-complete hypotheses are a last resort: they must never enter
    # the primary/fallback decision for full scopes (a tail [1]..[4] list
    # in a big doc would otherwise shadow the real ladder — [1969] SCR
    # 277 regression in the reservoir differential).
    full = [item for item in hypotheses if not item[2]]
    short = [item for item in hypotheses if item[2]]
    primary = [item for item in full if item[1][0][1] <= 5]
    key = lambda item: (len(item[1]), rank[item[0]], -item[1][0][1])  # noqa: E731
    ordered = sorted(primary or full, key=key, reverse=True) + sorted(
        short, key=key, reverse=True
    )
    for style, candidate, short_complete in ordered:
        out = _numbered_index(text, candidate, [offset for offset, _number, marker_style in markers
                                                if marker_style == style])
        # A short numbered list followed by a long unnumbered tail otherwise
        # looks like a document-spanning paragraph sequence because the final
        # item inherits EOF as its boundary.  Marker coverage, not that tail,
        # is the structural evidence.
        marker_span = (out[-1][1] - out[0][1]) / len(text)
        start_ratio = out[0][1] / len(text)
        bounded = out[:-1] or out
        counts = [_word_count(item[3]) for item in bounded]
        median_words = statistics.median(counts)
        # Median alone rejects real ladders whose tail is short "I
        # agree" concurrence lines; the mean stays high when a ladder
        # carries substantive prose anywhere, and stays low for the
        # uniformly-tiny items of quoted lists.
        # Substance = median prose, or mean pulled up by real reasons
        # (concurrence tails sink the median: "ROWLES, J.A.: I agree."),
        # or at least one full prose paragraph (max) — quoted lists and
        # endnote ladders are uniformly tiny on all three.
        substantive = (
            median_words >= 12
            or statistics.fmean(counts) >= 20
            or max(counts) >= 30
        )
        if short_complete:
            # The ladder IS the document. Case headers are bounded
            # absolutely (~500-900 chars) OR relatively (half the doc) —
            # sub-1.5KB oral rulings fail the ratio while 2-4KB costs
            # rulings fail the absolute, so accept either; a tail
            # fragment in a 22KB doc fails both plus the size cap.
            if (
                len(text) <= 6000
                and (out[0][1] <= 1200 or start_ratio <= 0.5)
                and max(_word_count(item[3]) for item in out) >= 30
            ):
                return out
            continue
        if not substantive or marker_span < 0.05:
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
    # 2026-07-30 laws-vet extensions: optional trailing dot after the
    # label ("1. There is established...", "2.(1) In this section" — the
    # NT/PE drafting convention, worth ~6pp of full-corpus recovery) and
    # an optional markdown heading prefix ("### 61.01 Enforcement of
    # Orders" — NB rules of court).
    r"^(?:#{1,6}[ \t]+)?[ \t]*(\d{1,8}(?:[.-]\d{1,8}){0,3}[A-Z]{0,2})\.?"
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
    r"(Schedule|Annexe|Formulaire|Form|Formule|Appendix|Appendice|Table|Tableau|"
    r"Preamble|Préambule|Order|Ordonnance)(?![A-Za-zÀ-ÿ])"
    r"[ \t]*[\"”»]?[ \t]*([A-Za-z0-9IVXLC.\"“”]{0,12})",
    re.MULTILINE | re.IGNORECASE,
)

# Oracle-measured tail discipline (fp_scan 2026-07-29: 'Form s',
# 'Order to' drove named precision to 0.293): identifiers are digits,
# romans, or a single capital — case-sensitive on purpose, re.I on the
# heading regex would let 'of'/'to' through the roman branch. Bare
# labels only for units that appear bare in provider section-map keys.
_NAMED_TAIL_OK = re.compile(
    r"(?:No\.?[ \t]*)?(?:\d{1,4}(?:\.\d{1,3})?[A-Za-z]?|[IVXLC]{1,7}|[A-Z])$"
)
_NAMED_BARE_OK = frozenset({"Schedule", "Appendix", "Preamble"})

_NAMED_CANON = {
    "annexe": "Schedule", "formule": "Form", "formulaire": "Form",
    "appendice": "Appendix", "tableau": "Table", "préambule": "Preamble",
    "ordonnance": "Order",
}

RANGE_EXPANSION_CAP = 400


def expand_ranges(text: str) -> set[str]:
    """Labels recovered from 'N to M' / 'N et M' repeal-range lines.

    The pre-1985 federal provider maps collapse 51.6% of their labels into such
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
    """'## SCHEDULE "A"' -> 'Schedule A'; repeats gain (n) like provider maps.

    Labels keep the heading's SURFACE language: provider maps key the surface
    form on both en rows ('Schedule I') and fr rows ('Annexe I'), and the
    old fr->en translation via _NAMED_CANON never matched anything (laws
    vet 2026-07-30) — _NAMED_CANON survives only to normalize the kind
    for the bare-label whitelist check."""
    seen: dict[str, int] = {}
    labels: set[str] = set()
    for match in _NAMED_HEAD_RE.finditer(text):
        kind_raw = match.group(1).lower()
        kind_canonical = _NAMED_CANON.get(kind_raw, kind_raw.capitalize())
        tail = match.group(2).strip(' "“”').rstrip(".").strip()
        if tail:
            if not _NAMED_TAIL_OK.fullmatch(tail):
                continue
        elif kind_canonical not in _NAMED_BARE_OK:
            continue
        label = f"{kind_raw.capitalize()} {tail}".strip()
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


# --- copied from the text-fidelity engine (reference etiquette:
# copy + provenance + --parity drift check, never a runtime import) --

# shared/grammar-tables/footnote-labels.json entry label.line-start
# (engine binding core.py:36 _LABEL_RE), verbatim as expanded and
# compiled by legalpdf.grammar_tables: re.ASCII, portable \s expanded
# to the source-whitespace class.
NOTE_LABEL_RE = re.compile(
    r"^[ \t\n\r\f\v\x1c-\x1f\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*"
    r"(?P<label>\d{1,4}|[*†‡§¶#])"
    r"(?:[ \t\n\r\f\v\x1c-\x1f\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[.)\],:;-])",
    re.ASCII,
)
# engine core.py:1764 — the heading line that opens a note region.
NOTES_HEADING_RE = re.compile(r"(?:end)?notes?", re.IGNORECASE)

_ENDNOTE_MAX_MEDIAN_WORDS = 25
_ENDNOTE_MIN_START_RATIO = 0.70


def endnote_index(text: str) -> list[Paragraph]:
    """Tail note ladders, anchored the way the engine's fidelity pass anchors them.

    The label grammar and the region-opening rules are the engine's,
    not ours: labels are shared-table entry label.line-start (the
    engine's _LABEL_RE, matched per line exactly as core.py does), and
    a ladder is credited only where core._infer_note_region_modes
    would open a note region — at expected number 1, or under a
    Notes/Endnotes heading line. Marker↔note pairing stays geometric
    and engine-only; the text plane reports its anchor type instead of
    imitating pairing it cannot see. Tail-position and short-entry
    guards remain Beaver-measured text-plane constraints (taxonomy
    2026-07-29: tail ladders at start_ratio ~0.98 with 21-25-word
    medians vs document-spanning 300-word decision scopes). FP modes
    this closed: room lists (405..), year tables (1985..), appendix
    [55]+ bracket labels.
    """
    if not text:
        return []
    numbered: list[tuple[int, int]] = []
    heading_ends: list[int] = []
    offset = 0
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        if NOTES_HEADING_RE.fullmatch(stripped.rstrip(":").strip()):
            heading_ends.append(offset + len(line))
        match = NOTE_LABEL_RE.match(line)
        if match and match.group("label").isdigit():
            numbered.append((offset + match.start("label"),
                             int(match.group("label"))))
        offset += len(line)
    all_offsets = [marker_offset for marker_offset, _n in numbered]
    best: list[Paragraph] = []
    for scope in monotone_scopes(numbered):
        if len(scope) < 3 or len(scope) <= len(best):
            continue
        opens_at_one = scope[0][1] == 1
        heading_anchored = any(
            scope[0][0] - 400 <= end <= scope[0][0] for end in heading_ends
        )
        if not (opens_at_one or heading_anchored):
            continue
        out = _numbered_index(text, scope, all_offsets)
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
        # Span credits the final paragraph's body, bounded by 2x the
        # median paragraph length: marker-offset-only span mechanically
        # flagged every correct short judgment (its whole last paragraph
        # plus signatures counted as "uncovered"), while an unbounded
        # end would let an EOF-inherited tail hide genuinely narrow
        # scopes (quoted lists, order enumerations).
        body_lens = [p[2] - p[1] for p in paragraphs[:-1]] or [
            paragraphs[-1][2] - paragraphs[-1][1]
        ]
        credit = min(
            paragraphs[-1][2] - paragraphs[-1][1],
            2 * statistics.median(body_lens),
        )
        span = (paragraphs[-1][1] + credit - paragraphs[0][1]) / max(1, len(text))
        return {"kind": "paragraphs", "count": len(paragraphs),
                "first": paragraphs[0][0], "last": paragraphs[-1][0],
                "span": round(min(span, 1.0), 4)}
    report_start = reporter_start_page(*citations)
    pages = page_structure(text, report_start)
    if pages:
        return {"kind": "pages", "count": len(pages),
                "first": pages[0][0], "last": pages[-1][0],
                "reporter_anchored": report_start is not None}
    notes = endnote_index(text)
    if notes:
        return {"kind": "endnotes", "count": len(notes),
                "first": notes[0][0], "last": notes[-1][0],
                "anchor": "sequence_start" if notes[0][0] == 1
                else "notes_heading"}
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

    # The engine is a reference too: the note-label copy must stay
    # byte-equal to the table entry the engine actually compiles.
    from pathlib import Path  # noqa: PLC0415

    engine_src = (Path(__file__).resolve().parent / FIDELITY_ENGINE_SRC).resolve()
    sys.path.insert(0, str(engine_src))
    from legalpdf.grammar_tables import compile_table_entry  # noqa: PLC0415

    fidelity = compile_table_entry("label.line-start")
    drift = (fidelity.pattern != NOTE_LABEL_RE.pattern
             or fidelity.flags != NOTE_LABEL_RE.flags)
    print(f"label.line-start copy: {'DRIFT' if drift else 'byte-equal'}")
    return 1 if mismatches or drift else 0


if __name__ == "__main__":
    import sys

    if "--parity" in sys.argv:
        raise SystemExit(_parity(300))
    print(__doc__)
