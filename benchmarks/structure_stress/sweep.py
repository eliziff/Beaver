"""Structure stress sweep over every local corpus.

For each document: run every grammar-table entry (prefilter-gated) and
the structure detectors (paragraph ladder, page marks, law sections),
score against the corpus's own oracle where one exists, and aggregate.
Regex is the measured bottleneck. On the full tier, workers read their
own parquet row slices (pyarrow decodes ~500 MB/s) and return per-shard
aggregates, so the parent never touches document text — the first full
run fed whole documents from a single-threaded duckdb loop through IPC
and starved 4 workers down to a 4.6% duty cycle (~26 h projected).
Sampled tiers keep the legacy parent-fed path (deterministic order).

  python -X utf8 sweep.py --tier smoke
  python -X utf8 sweep.py --tier full --source a2aj_laws --workers 10

Summaries: results/<tier>/<source>.summary.json (committed).
Failures:  results/<tier>/<source>.failures.jsonl (local, capped).
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import re
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORK = HERE.parent.parent
ENGINE_SRC = FORK / "universal-legal-pdf-engine" / "src"
TABLES_DIR = FORK / "shared" / "grammar-tables"
A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")


def _public_endpoint_db() -> Path:
    """Resolve the overlay-extracted journals DB by glob, never by its
    content-hash filename: overlay_store.db_path() re-derives the hash on
    every reference rebuild and sweeps stale copies, so the newest
    public_endpoint-*.db is the live one and a pinned name breaks silently
    (reinvention-ledger item 5)."""
    root = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\data")
    candidates = sorted(root.glob("public_endpoint*.db"),
                        key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise FileNotFoundError(f"no public_endpoint*.db under {root}")
    return candidates[0]

# Literal gates: a doc whose lowercased text contains none of the entry's
# literals skips that entry. Harness-side only — tables stay pure. Keyed
# loosely; entries without a key always run.
PREFILTERS: dict[str, list[str]] = {
    "cite.statute.splitter": ["rsc", "rso", "rsa", "rss", "rsm", "rsq", "rsy",
                              "rsbc", "rsnl", "rsnb", "rsns", "rspei", "rsnwt",
                              "cqlr", "ccsm", "sc ", "so ", "sa ", "ss ", "sm ",
                              "sq ", "sy ", "sbc", "snl", "snb", "sns", "snwt"],
    "cite.statute.toa": ["rsc", "rso", "rsa", "rss", "rsm", "rsq", "rsy",
                         "rsbc", "rsnl", "rsnb", "rsns", "rspei", "rsnwt",
                         "cqlr", "ccsm", "sc ", "so ", "sa ", "ss ", "sm ",
                         "sq ", "sy ", "sbc", "snl", "snb", "sns", "snwt",
                         "reg", "oic", "sor", "si ", "cfr"],
    "cite.canlii": ["canlii"],
    "cite.url": ["http", "www.", "perma.cc", "doi:"],
    "cite.url.prefix": ["http", "www."],
    "ref.token": ["supra", "ibid"],
    "ref.pure.splitter": ["supra", "ibid"],
    "ref.pure.toa": ["supra", "ibid"],
    "ref.inline.toa": ["supra", "ibid"],
    "ref.supra-note.linking": ["supra"],
    "ref.cross-reference": ["supra", "ibid", "note"],
    "marker.inline-fn": ["\u27e6"],
    "trap.double-zero-width": ["\u200b"],
    "ref.history.toa": ["rev", "aff", "vari", "leave"],
    "ref.quoted-work-author": ['"', "\u201c"],
    "label.superscript": ["\u2070", "\u00b9", "\u00b2", "\u00b3", "\u2074",
                          "\u2075", "\u2076", "\u2077", "\u2078", "\u2079"],
    "title.legal.splitter": ["act", "code", "rule", "regulation",
                             "convention", "treaty"],
    "title.legal.toa": ["act", "code", "rule", "regulation",
                        "convention", "treaty"],
    "title.named-code": ["code", "rule"],
    "cite.quoted": ['"', "\u201c"],
    "cite.secondary": ["("],
    "frame.book": ["("],
    "cite.statute.judgment": ["r.s", "s.c", "s.o", "s.a", "s.s", "s.m",
                              "s.b", "s.n", "s.y", "s.p", "c.c.s.m", "rs",
                              "sc ", "sched"],
    # Dotless heads (LRC/LC/CQLR/LRTFP...) shipped real matches the dotted
    # list missed — probes/shard_gate_check.py caught three in sample; the
    # 2-char members are deliberately broad, a gate may only over-pass.
    "cite.statute.judgment.fr": ["l.r", "l.c", "l.o", "l.m", "c.p.l.m",
                                 "r.l.r.q", "c.q.l.r", "lr", "lc ", "lo ",
                                 "lm ", "cqlr", "rlrq", "cplm"],
}

# Grammars authored for SHORT STRINGS (a footnote, a label line, a locator)
# are semantically meaningless and often quadratic over whole documents \u2014
# they are exercised by the engine's grammar_differential over footnote
# corpora instead. The whole-document sweep skips them.
SHORT_STRING_ENTRIES = {
    "shortform.splitter",
    "shortform.toa",
    "signal.prefix.splitter",
    "signal.prefix.toa",
    "ref.pure.splitter",
    "ref.pure.toa",
    "label.pure",
    "label.line-start",
    "label.standalone",
    "attach.link",
    "bracket.editorial",
    "boundary.sentence.engine",
    "boundary.conjunction",
}

SLOW_DOC_SECONDS = 2.0

# Structure detection is ALR's corpus-proven machinery, ported with a
# 0-mismatch parity proof in structure_ref.py. The naive detectors that
# used to live here scored 43% presence accuracy and 31% flag precision
# against hand-verified gold; the port scores 95% / 93%.
from structure_ref import law_section_labels, structure_cascade  # noqa: E402

PILCROW_RE = re.compile(r"¶\s?\d")
PAGE_MARK_JOURNAL_RE = re.compile(r"^[ \t]*\[page\s+(\d{1,5})\][ \t]*$", re.I | re.M)
PAGE_MARK_TOA_RE = re.compile(
    r"^\s*(?:\[\s*)?(?:original\s+)?page\s+([A-Za-z]?\d{1,4})(?:\s*\])?\s*$",
    re.I | re.M,
)
ANY_BRACKET_LABEL_RE = re.compile(r"\[(\d{1,4})\]")

_ENTRIES: list[
    tuple[str, "re.Pattern[str]", list[str] | None, list[str] | None, int]
] = []

try:  # the private home since 3.11; sre_parse is the deprecated alias
    from re import _parser as _sre_parser  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover
    import sre_parse as _sre_parser  # type: ignore[no-redef]

_GATE_MIN_LEN = 3
_GATE_MAX_ALTERNATIVES = 12


def _literal_candidates(nodes) -> list[list[str]]:
    """Candidate OR-sets of mandatory lowercase literals for a parsed regex
    sequence: every match of the sequence must contain at least one literal
    from each returned set. Sound by construction — only nodes that appear
    in every match contribute; optional/lookaround/class nodes just break
    the current literal run."""
    candidates: list[list[str]] = []
    run: list[str] = []

    def flush() -> None:
        if len("".join(run)) >= _GATE_MIN_LEN:
            candidates.append(["".join(run)])
        run.clear()

    for op, av in nodes:
        opname = str(op).rsplit(".", 1)[-1]
        if opname == "LITERAL":
            run.append(chr(av).lower())
            continue
        flush()
        if opname == "SUBPATTERN":
            candidates.extend(_literal_candidates(av[3]))
        elif opname in {"MAX_REPEAT", "MIN_REPEAT", "POSSESSIVE_REPEAT"}:
            if av[0] >= 1:
                candidates.extend(_literal_candidates(av[2]))
        elif opname == "BRANCH":
            union: list[str] = []
            for alternative in av[1]:
                alt_sets = _literal_candidates(alternative)
                if not alt_sets:
                    union = []
                    break
                union.extend(
                    max(alt_sets, key=lambda s: min(len(lit) for lit in s))
                )
            if union:
                candidates.append(union)
    flush()
    return candidates


def _derive_gate(rx: "re.Pattern[str]") -> list[str] | None:
    """Best mandatory-literal OR-set for a compiled pattern, or None."""
    try:
        nodes = _sre_parser.parse(rx.pattern, rx.flags)
    except Exception:
        return None
    usable = [
        sorted(set(candidate))
        for candidate in _literal_candidates(nodes)
        if len(set(candidate)) <= _GATE_MAX_ALTERNATIVES
        and all(len(literal) >= _GATE_MIN_LEN for literal in candidate)
    ]
    if not usable:
        return None
    return max(usable, key=lambda c: (min(len(lit) for lit in c), -len(c)))


_ANCHOR_MAX_WIDTH = 4000
_ANCHOR_MAX_ALTERNATIVES = 48
_ANCHOR_MIN_LEN = 2
# Entries whose windowed counts diverged from full scans in
# shard_gate_check: full-scan only.
_NO_ANCHOR: set[str] = set()
# Unbounded repeats (\s+, \d+, ...) get an assumed span instead of a
# refusal. This makes the window pad a HEURISTIC bound, not a proof —
# exactly the epistemic class of the hand PREFILTERS, and covered the same
# way: shard_gate_check asserts windowed counts == full-scan counts over
# the reservoir sample before every launch, and _count_matches falls back
# to a full scan whenever a window match touches its boundary (the
# clipped-shorter-match case).
_ASSUMED_REPEAT_SPAN = 64

# Per-match-mandatory literal sets read off the pattern alternations by
# hand where the AST walk bottoms out (heads hidden behind expanded
# (?<!\w) lookbehinds). Same contract as derived anchors: every match's
# text contains at least one literal; proven by the probe's windowed-vs-
# full differential before every launch.
_HAND_ANCHORS: dict[str, list[str]] = {
    "pinpoint.para.splitter": ["para", "¶"],
    "signal.aggressive": [
        "citing", "cited", "quoting", "quoted", "discussing", "discussed",
        "applying", "applied", "relying", "relied", "following",
        "followed", "adopting", "adopted", "amended", "amending",
        "adding", "rev", "aff", "penalty", "republished", "accord",
        "contra", "compare", "cf", "see",
    ],
    "signal.citation.toa": [
        "see", "cf", "compare", "contra", "citing", "cited", "quoting",
        "quoted", "discussing", "discussed", "applying", "applied",
        "relying", "relied", "following", "followed", "rev", "aff",
    ],
    # signal.source has TWO branches: the sentence-start signals AND an
    # inline branch (citing/quoting/rev'd/aff'd/...). The anchor set must
    # cover both — the first cut covered only the sentence branch and the
    # reservoir differential flagged 131 undercounts.
    "signal.source": [
        "see", "cf", "compare", "contra", "citing", "cited", "quoting",
        "quoted", "discussing", "discussed", "applying", "applied",
        "relying", "relied", "following", "followed", "rev", "aff",
    ],
}


def _node_max_width(nodes) -> int | None:
    """Upper bound on characters a parsed sequence can consume, with
    unbounded repeats assumed to span <= max(64, 4x unit). Lookaround
    content counts as consuming (over-estimate keeps the window pad safe);
    AT nodes count 1 because \\b consults one neighbouring char.
    None = an op we refuse to reason about."""
    total = 0
    for op, av in nodes:
        opname = str(op).rsplit(".", 1)[-1]
        if opname in {"LITERAL", "NOT_LITERAL", "IN", "ANY", "AT"}:
            total += 1
        elif opname == "SUBPATTERN":
            width = _node_max_width(av[3])
            if width is None:
                return None
            total += width
        elif opname == "ATOMIC_GROUP":
            width = _node_max_width(av)
            if width is None:
                return None
            total += width
        elif opname in {"MAX_REPEAT", "MIN_REPEAT", "POSSESSIVE_REPEAT"}:
            width = _node_max_width(av[2])
            if width is None:
                return None
            if av[1] == _sre_parser.MAXREPEAT:
                # Assumed span, capped: nested unbounded repeats otherwise
                # compound (4x of 4x of ...) into widths that disqualify
                # the whole pattern. A repeat's real-text span does not
                # grow with its syntactic nesting depth.
                total += min(
                    max(_ASSUMED_REPEAT_SPAN, 4 * width),
                    4 * _ASSUMED_REPEAT_SPAN,
                )
            else:
                # Bounded repeats are exact arithmetic — never cap them.
                # (A cap here clipped signal.source's {0,100} tail and the
                # clipped regex failed entirely inside its window, which
                # the edge clip-guard cannot see. 133 reservoir mismatches.)
                total += av[1] * width
        elif opname in {"ASSERT", "ASSERT_NOT"}:
            width = _node_max_width(av[1])
            if width is None:
                return None
            total += width
        elif opname == "BRANCH":
            widths = [_node_max_width(alt) for alt in av[1]]
            if any(w is None for w in widths):
                return None
            total += max(widths)
        else:  # GROUPREF etc.: typed refusal, not a guess
            return None
    return total


def _derive_anchor(rx: "re.Pattern[str]") -> tuple[list[str], int] | None:
    """(anchor OR-set, window pad) for windowed scanning, or None.

    Every match contains at least one anchor literal (same soundness
    argument as _derive_gate: mandatory nodes only, lowercased search over
    lowered text over-finds and never under-finds), and the whole match
    plus its lookaround context spans at most `pad` chars. So every match
    lies inside [hit - pad, hit + pad + 1] of some anchor hit, and the
    regex only needs to run inside those windows."""
    try:
        nodes = _sre_parser.parse(rx.pattern, rx.flags)
    except Exception:
        return None
    width = _node_max_width(nodes)
    if width is None or width > _ANCHOR_MAX_WIDTH:
        return None
    usable = [
        sorted(set(candidate))
        for candidate in _literal_candidates(nodes)
        if len(set(candidate)) <= _ANCHOR_MAX_ALTERNATIVES
        and all(len(literal) >= _ANCHOR_MIN_LEN for literal in candidate)
    ]
    if not usable:
        return None
    anchors = max(usable, key=lambda c: (min(len(lit) for lit in c), -len(c)))
    return anchors, width


def _entry_anchor(
    eid: str, rx: "re.Pattern[str]"
) -> tuple[list[str], int] | None:
    """Anchor set for an entry: AST-derived when possible, else the hand
    PREFILTER literals. Hand literals are per-DOC heuristics promoted to
    per-MATCH anchors — covered by shard_gate_check's zero-tolerance
    windowed-vs-full differential over the reservoir, and by the boundary
    clip-guard in _count_matches. Entries in _NO_ANCHOR opted out after a
    probe mismatch."""
    if eid in _NO_ANCHOR:
        return None
    derived = _derive_anchor(rx)
    if derived is not None:
        return derived
    hand = _HAND_ANCHORS.get(eid) or PREFILTERS.get(eid)
    if not hand:
        return None
    try:
        nodes = _sre_parser.parse(rx.pattern, rx.flags)
    except Exception:
        return None
    width = _node_max_width(nodes)
    if width is None or width > _ANCHOR_MAX_WIDTH:
        return None
    return list(hand), width


def _count_matches(
    rx: "re.Pattern[str]",
    text: str,
    lower: str,
    anchors: list[str],
    pad: int,
) -> int:
    """Count of rx matches in text, scanning only merged windows around
    anchor hits. Equivalent to full finditer (probe-proven): windows are
    disjoint, every match lies wholly inside one, and finditer's
    pos/endpos keep \\b and lookbehind context (unlike slicing)."""
    hits: list[int] = []
    for lit in anchors:
        i = lower.find(lit)
        while i >= 0:
            hits.append(i)
            i = lower.find(lit, i + 1)
    if not hits:
        return 0
    hits.sort()
    # Merge into disjoint windows and measure REAL coverage — anchor hits
    # cluster (citations sit in dense runs), so merged coverage is far
    # below the naive 2*pad*len(hits) estimate.
    windows: list[tuple[int, int]] = []
    lo = hits[0] - pad
    hi = hits[0] + pad + 1
    for h in hits[1:]:
        if h - pad <= hi:
            hi = h + pad + 1
        else:
            windows.append((max(0, lo), hi))
            lo, hi = h - pad, h + pad + 1
    windows.append((max(0, lo), hi))
    end = len(text)
    if sum(w_hi - w_lo for w_lo, w_hi in windows) > 0.6 * end:
        # Windows cover most of the doc; full scan is cheaper.
        return sum(1 for _ in rx.finditer(text))
    n = 0
    for w_lo, w_hi in windows:
        for m in rx.finditer(text, w_lo, min(w_hi, end)):
            if m.end() >= w_hi - 1 and w_hi < end:
                # Match touches the window edge: the pad (heuristic for
                # unbounded repeats) may have clipped it. Full scan.
                return sum(1 for _ in rx.finditer(text))
            n += 1
    return n


def _load_entries() -> list[tuple[str, "re.Pattern[str]", list[str] | None]]:
    sys.path.insert(0, str(ENGINE_SRC))
    from legalpdf.grammar_tables import compile_entry  # noqa: PLC0415

    entries = []
    for path in sorted(TABLES_DIR.glob("*.json")):
        table = json.loads(path.read_text(encoding="utf-8"))
        defs = table.get("defs") or {}
        for entry in table.get("entries", []):
            if entry["id"] in SHORT_STRING_ENTRIES:
                continue
            rx = compile_entry(entry, defs)
            gate = PREFILTERS.get(entry["id"]) or _derive_gate(rx)
            anchors, pad = _entry_anchor(entry["id"], rx) or (None, 0)
            entries.append((entry["id"], rx, gate, anchors, pad))
    return entries


def _init_worker() -> None:
    global _ENTRIES
    _ENTRIES = _load_entries()




MAX_DOC_CHARS = 8_000_000


def scan_doc(job: tuple[str, str, str, dict]) -> dict:
    """(doc_id, kind, text, oracle) -> per-doc record."""
    doc_id, kind, text, oracle = job
    t0 = time.perf_counter()
    if len(text) > MAX_DOC_CHARS:
        # One giant document must never take a worker down; record and
        # scan the head only.
        oracle = dict(oracle)
        oracle["truncated_from"] = len(text)
        text = text[:MAX_DOC_CHARS]
    lower = text.lower()
    # .lower() can change length in unicode edge cases (e.g. 'İ' -> 2
    # chars); anchor offsets would misalign, so windowing needs equal
    # lengths — otherwise fall back to full scans for this doc.
    windowable = len(lower) == len(text)
    matches: dict[str, int] = {}
    for eid, rx, gates, anchors, pad in _ENTRIES:
        if gates is not None and not any(g in lower for g in gates):
            continue
        if anchors is not None and windowable:
            n = _count_matches(rx, text, lower, anchors, pad)
        else:
            n = sum(1 for _ in rx.finditer(text))
        if n:
            matches[eid] = n

    record: dict = {
        "id": doc_id,
        "kind": kind,
        "chars": len(text),
        "matches": matches,
        "pilcrows": len(PILCROW_RE.findall(text)),
        "fail": [],
    }

    if kind == "case":
        self_cite = oracle.get("self_cite") or ""
        window = text[:3000]
        record["self_cite_found"] = bool(self_cite) and self_cite in window
        record["cited_count"] = oracle.get("cited_count", 0)
        cite_hits = sum(
            matches.get(k, 0)
            for k in ("cite.neutral", "cite.neutral.tribunal", "cite.canlii",
                      "cite.reporter.splitter")
        )
        if record["cited_count"] > 0 and cite_hits == 0:
            record["fail"].append("cites_expected_none_found")
        # No structure detected is never a verdict: paragraphs, then
        # reporter-anchored pages, then endnote ladders, then heading
        # hints. Only all-empty lands in the close-inspection bucket.
        structure = structure_cascade(text, self_cite)
        record["structure"] = structure
        if structure["kind"] == "none":
            record["fail"].append("no_addressable_structure")
            lines = text.splitlines() or [""]
            mean_line = len(text) / max(1, len(lines))
            if mean_line > 600 and len(ANY_BRACKET_LABEL_RE.findall(text)) >= 8:
                # Labels exist but sit mid-line: a corpus defect (four
                # Sept-Oct 2003 BCCA rows found so far), not absence.
                record["fail"].append("line_collapsed")
        elif structure["kind"] == "paragraphs" and structure.get("span", 1.0) < 0.55:
            # Accepted scope covers under 55% of the document — the
            # host-vs-quote competition residual worth surfacing (2.2%
            # of accepted BCCA scopes).
            record["fail"].append("paragraph_scope_narrow")
    elif kind == "law":
        want = set(oracle.get("section_labels") or [])
        num = oracle.get("num_sections") or 0
        detected = law_section_labels(text)
        combined = (
            detected["alr_ext"] | detected["bold"] | detected["ranges"]
            | detected["named"]
        )
        def _rec(found: set) -> float | None:
            return len(want & found) / len(want) if want else None
        def _prec(found: set) -> float | None:
            return len(want & found) / len(found) if found else None
        record["sections"] = {
            "oracle": num,
            "recovery_combined": _rec(combined),
            "detectors": {
                name: {"rec": _rec(found), "prec": _prec(found)}
                for name, found in detected.items()
            },
        }
        best = record["sections"]["recovery_combined"] or 0.0
        if want and best < 0.5:
            record["fail"].append(f"section_recovery_{best:.2f}")
    elif kind == "journal":
        want = oracle.get("page_labels") or []
        found = {m.group(1) for m in PAGE_MARK_JOURNAL_RE.finditer(text)}
        found |= {m.group(1) for m in PAGE_MARK_TOA_RE.finditer(text)}
        wanted = [str(w) for w in want]
        rec = (
            sum(1 for w in wanted if w in found) / len(wanted) if wanted else None
        )
        record["pages"] = {"oracle": len(wanted), "recovery": rec}
        if wanted and rec is not None and rec < 0.8:
            record["fail"].append(f"page_recovery_{rec:.2f}")

    wall = time.perf_counter() - t0
    record["wall"] = round(wall, 4)
    if wall > SLOW_DOC_SECONDS:
        record["fail"].append("slow_doc")
    if oracle.get("truncated_from"):
        record["truncated_from"] = oracle["truncated_from"]
        record["fail"].append("oversize_doc")
    return record


# ── sources ──────────────────────────────────────────────────────────


def _cases_jobs(con, tier: str, langs: list[str]):
    per_court = {"smoke": 150, "dev": 2000, "full": 10**9}[tier]
    fr_cap = {"smoke": 50, "dev": 500, "full": 10**9}[tier]
    courts = sorted(
        p.parent.name for p in (A2AJ / "cases").glob("*/train.parquet")
    )
    for court in courts:
        pq = (A2AJ / "cases" / court / "train.parquet").as_posix()
        for lang in langs:
            cap = per_court if lang == "en" else fr_cap
            # Full tier takes everything: ordering would force duckdb to
            # sort whole parquets (BCSC is 916 MB) — that is what killed
            # the first full run. Sampled tiers keep the deterministic
            # order.
            order = "" if tier == "full" else f"order by citation_{lang}"
            print(f"[cases] {court}:{lang} start", flush=True)
            rows = con.execute(
                f"""
                select citation_{lang}, unofficial_text_{lang},
                       len(cases_cited_{lang}) as cited
                from read_parquet('{pq}')
                where unofficial_text_{lang} is not null
                {order}
                limit {cap}
                """
            )
            while True:
                batch = rows.fetchmany(200)
                if not batch:
                    break
                for cite, text, cited in batch:
                    yield (
                        f"{court}:{cite}:{lang}",
                        "case",
                        text,
                        {"self_cite": cite, "cited_count": cited or 0},
                    )


def _laws_jobs(con, tier: str, langs: list[str]):
    per_set = {"smoke": 100, "dev": 10**9, "full": 10**9}[tier]
    sets = sorted(p.parent.name for p in (A2AJ / "laws").glob("*/train.parquet"))
    for name in sets:
        pq = (A2AJ / "laws" / name / "train.parquet").as_posix()
        for lang in langs:
            order = "" if tier == "full" else f"order by citation_{lang}"
            print(f"[laws] {name}:{lang} start", flush=True)
            rows = con.execute(
                f"""
                select citation_{lang}, unofficial_text_{lang},
                       unofficial_sections_{lang}, num_sections_{lang}
                from read_parquet('{pq}')
                where unofficial_text_{lang} is not null
                {order}
                limit {per_set}
                """
            )
            while True:
                batch = rows.fetchmany(100)
                if not batch:
                    break
                for cite, text, sections_json, num in batch:
                    try:
                        labels = list(json.loads(sections_json or "{}").keys())
                    except (json.JSONDecodeError, TypeError, AttributeError):
                        labels = []
                    yield (
                        f"{name}:{cite}:{lang}",
                        "law",
                        text,
                        {"section_labels": labels, "num_sections": num or 0},
                    )


def _journal_jobs(tier: str):
    cap = {"smoke": 100, "dev": 10**9, "full": 10**9}[tier]
    con = sqlite3.connect(_public_endpoint_db())
    rows = con.execute(
        """
        select a.article_id, a.text,
               (select json_group_array(p.page_label)
                from article_pages p where p.article_id = a.article_id
                order by p.page_order) as labels
        from articles a
        where a.text is not null and length(a.text) > 200
        order by a.article_id limit ?
        """,
        (cap,),
    )
    for article_id, text, labels_json in rows:
        labels = json.loads(labels_json or "[]")
        yield (f"journal:{article_id}", "journal", text, {"page_labels": labels})
    con.close()


# ── driver ───────────────────────────────────────────────────────────


def _empty_agg(name: str) -> dict:
    return {
        "source": name,
        "docs": 0,
        "chars": 0,
        "fail_docs": 0,
        "fail_reasons": Counter(),
        "entry_docs": Counter(),
        "entry_matches": Counter(),
        "structure_kinds": Counter(),
        "slow_docs": 0,
    }


def _fold_record(
    agg: dict,
    rec: dict,
    failures: list[dict],
    recoveries: list[tuple[str, float]],
    *,
    failure_cap: int,
) -> None:
    """One doc record into an aggregate — shared by both pool shapes so the
    parent-fed and shard-fed paths cannot drift."""
    agg["docs"] += 1
    agg["chars"] += rec["chars"]
    for eid, n in rec["matches"].items():
        agg["entry_docs"][eid] += 1
        agg["entry_matches"][eid] += n
    structure = rec.get("structure")
    if structure:
        agg["structure_kinds"][structure["kind"]] += 1
    for key in ("sections", "pages"):
        sub = rec.get(key)
        if sub:
            vals = [
                v
                for k, v in sub.items()
                if k.startswith("recovery") and v is not None
            ]
            if vals:
                recoveries.append((rec["id"].split(":", 1)[0], max(vals)))
    if rec["fail"]:
        agg["fail_docs"] += 1
        for reason in rec["fail"]:
            agg["fail_reasons"][reason.split("_0")[0]] += 1
        if "slow_doc" in rec["fail"]:
            agg["slow_docs"] += 1
        if len(failures) < failure_cap:
            failures.append(rec)


def _summarize(
    agg: dict,
    recoveries: list[tuple[str, float]],
    wall: float,
    out_dir: Path,
    name: str,
) -> dict:
    mb = agg["chars"] / 1e6
    values = [value for _, value in recoveries]
    recovery_by_set: dict[str, list[float]] = {}
    for prefix, value in recoveries:
        recovery_by_set.setdefault(prefix, []).append(value)
    summary = {
        **{k: v for k, v in agg.items() if not isinstance(v, Counter)},
        "fail_reasons": dict(agg["fail_reasons"].most_common()),
        "entry_docs": dict(agg["entry_docs"].most_common()),
        "entry_matches": dict(agg["entry_matches"].most_common()),
        "structure_kinds": dict(agg["structure_kinds"].most_common()),
        "mb": round(mb, 1),
        "wall_s": round(wall, 1),
        "mb_per_s": round(mb / wall, 2) if wall else None,
        "recovery_mean": round(sum(values) / len(values), 4) if values else None,
        "recovery_n": len(values),
        "recovery_by_set": {
            k: {"mean": round(sum(v) / len(v), 4), "n": len(v)}
            for k, v in sorted(recovery_by_set.items())
        },
    }
    (out_dir / f"{name}.summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return summary


def run_source(name: str, jobs, workers: int, out_dir: Path) -> dict:
    t0 = time.time()
    agg = _empty_agg(name)
    recoveries: list[tuple[str, float]] = []
    failures: list[dict] = []
    with mp.Pool(
        workers, initializer=_init_worker, maxtasksperchild=200
    ) as pool:
        for rec in pool.imap_unordered(scan_doc, jobs, chunksize=16):
            _fold_record(agg, rec, failures, recoveries, failure_cap=2000)
    with open(out_dir / f"{name}.failures.jsonl", "w", encoding="utf-8") as out:
        for rec in failures:
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return _summarize(agg, recoveries, time.time() - t0, out_dir, name)


# ── sharded full tier ────────────────────────────────────────────────

SLICE_ROWS = 4000
SHARD_FAILURE_CAP = 2000


def _corpus_shards(source: str, langs: list[str]):
    """Tiny (path, set, kind, lang, row range) jobs; each worker reads its
    own rows so the parent never holds document text."""
    import pyarrow.parquet as pq  # noqa: PLC0415

    base = A2AJ / ("cases" if source == "a2aj_cases" else "laws")
    kind = "case" if source == "a2aj_cases" else "law"
    shards = []
    for path in sorted(base.glob("*/train.parquet")):
        rows = pq.ParquetFile(path).metadata.num_rows
        for lang in langs:
            for start in range(0, rows, SLICE_ROWS):
                shards.append(
                    (
                        path.as_posix(),
                        path.parent.name,
                        kind,
                        lang,
                        start,
                        min(start + SLICE_ROWS, rows),
                    )
                )
    return shards


_WORKER_CON = None


def _worker_con():
    """One single-threaded duckdb connection per worker. threads=1 keeps the
    parquet scan in file order (offset/limit slices stay exact and disjoint)
    and streams pages instead of decoding whole row groups — these corpora
    are single-row-group files, so a pyarrow iter_batches reader held the
    ENTIRE decoded column chunk (~2.5 GB for BCSC) per worker and six
    workers OOMed the machine (MemoryError, first sharded launch)."""
    global _WORKER_CON
    if _WORKER_CON is None:
        import duckdb  # noqa: PLC0415

        _WORKER_CON = duckdb.connect()
        _WORKER_CON.execute("set threads=1")
    return _WORKER_CON


def scan_shard(shard: tuple[str, str, str, str, int, int]) -> dict:
    """Worker: read own parquet row slice (streaming duckdb), scan each doc,
    return a partial aggregate + capped failures instead of per-doc records."""
    pq_path, name, kind, lang, start, stop = shard
    con = _worker_con()
    if kind == "case":
        query = f"""
            select citation_{lang}, unofficial_text_{lang},
                   len(cases_cited_{lang}) as cited
            from read_parquet('{pq_path}')
            limit {stop - start} offset {start}
        """
    else:
        query = f"""
            select citation_{lang}, unofficial_text_{lang},
                   unofficial_sections_{lang}, num_sections_{lang}
            from read_parquet('{pq_path}')
            limit {stop - start} offset {start}
        """
    agg = _empty_agg(kind)
    failures: list[dict] = []
    recoveries: list[tuple[str, float]] = []
    rows = con.execute(query)
    while True:
        batch = rows.fetchmany(100)
        if not batch:
            break
        for row in batch:
            cite, text = row[0], row[1]
            if not text:
                continue
            if kind == "case":
                oracle = {"self_cite": cite, "cited_count": row[2] or 0}
            else:
                try:
                    labels = list(json.loads(row[2] or "{}").keys())
                except (json.JSONDecodeError, TypeError, AttributeError):
                    labels = []
                oracle = {"section_labels": labels, "num_sections": row[3] or 0}
            rec = scan_doc((f"{name}:{cite}:{lang}", kind, text, oracle))
            _fold_record(
                agg, rec, failures, recoveries, failure_cap=SHARD_FAILURE_CAP
            )
    agg["failures"] = failures
    agg["recoveries"] = recoveries
    return agg


def run_source_sharded(
    name: str, shards: list, workers: int, out_dir: Path
) -> dict:
    t0 = time.time()
    agg = _empty_agg(name)
    recoveries: list[tuple[str, float]] = []
    failures: list[dict] = []
    done = 0
    with mp.Pool(workers, initializer=_init_worker) as pool:
        for partial in pool.imap_unordered(scan_shard, shards, chunksize=1):
            for key in ("docs", "chars", "fail_docs", "slow_docs"):
                agg[key] += partial[key]
            for key in ("fail_reasons", "entry_docs", "entry_matches",
                        "structure_kinds"):
                agg[key].update(partial[key])
            recoveries.extend(partial["recoveries"])
            if len(failures) < 2000:
                failures.extend(partial["failures"][: 2000 - len(failures)])
            done += 1
            print(
                f"[{name}] shard {done}/{len(shards)} "
                f"docs={agg['docs']} mb={agg['chars'] / 1e6:.0f}",
                flush=True,
            )
    with open(out_dir / f"{name}.failures.jsonl", "w", encoding="utf-8") as out:
        for rec in failures:
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return _summarize(agg, recoveries, time.time() - t0, out_dir, name)


def _below_normal_priority() -> None:
    """Throttle rule: corpus-scale runs must not fight the foreground.
    Workers inherit the parent's priority class at spawn."""
    if sys.platform == "win32":
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", choices=["smoke", "dev", "full"], default="smoke")
    parser.add_argument(
        "--source",
        action="append",
        choices=["a2aj_cases", "a2aj_laws", "journals"],
        help="repeatable; default all",
    )
    parser.add_argument("--workers", type=int, default=max(2, mp.cpu_count() - 2))
    parser.add_argument("--langs", default="en,fr")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    _below_normal_priority()

    import duckdb  # noqa: PLC0415

    langs = [lang.strip() for lang in args.langs.split(",") if lang.strip()]
    out_dir = Path(args.out) if args.out else HERE / "results" / args.tier
    out_dir.mkdir(parents=True, exist_ok=True)
    sources = args.source or ["a2aj_cases", "a2aj_laws", "journals"]
    con = duckdb.connect()

    for name in sources:
        if args.tier == "full" and name in {"a2aj_cases", "a2aj_laws"}:
            shards = _corpus_shards(name, langs)
            summary = run_source_sharded(name, shards, args.workers, out_dir)
            print(
                f"{name}: {summary['docs']} docs, {summary['mb']} MB, "
                f"{summary['wall_s']}s ({summary['mb_per_s']} MB/s), "
                f"{summary['fail_docs']} fail docs; "
                f"recovery_mean={summary['recovery_mean']}"
            )
            continue
        if name == "a2aj_cases":
            jobs = _cases_jobs(con, args.tier, langs)
        elif name == "a2aj_laws":
            jobs = _laws_jobs(con, args.tier, langs)
        else:
            jobs = _journal_jobs(args.tier)
        summary = run_source(name, jobs, args.workers, out_dir)
        print(
            f"{name}: {summary['docs']} docs, {summary['mb']} MB, "
            f"{summary['wall_s']}s ({summary['mb_per_s']} MB/s), "
            f"{summary['fail_docs']} fail docs; "
            f"recovery_mean={summary['recovery_mean']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
