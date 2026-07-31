"""Footnote/endnote pairing over the public_endpoint.db plaintext export.

Lightweight plaintext adapter of the canonical footnote-pairing essentials -
label backbone by global monotone-chain dynamic program, refs assigned
under first-occurrence monotonicity with page proximity, abstain over
guess. Deliberately not a PDF parser: no kraken/ppdoc/codex
inference; geometry-free, because the input is OUR OWN rendered plaintext:

  - `[page N]` lines are printed by the export from article_pages, so the
    page map is walked as data (journals doctrine: never detect pages);
  - note labels render as `N<TAB>` at line start, so label candidates are
    the export's own note rendering (still disciplined by the backbone DP
    - stray digit-led table rows lose the chain);
  - in-body ref markers survive only as digits glued to the preceding
    word/punctuation ("disabilities.2 FASD"), the plaintext analogue of
    the orphaned-superscript problem; sites are admitted only for
    backbone label values and assigned monotonically.

Once digital-native articles' upstream fn_ref/fn_label annotations are
fully registered in journals.db, that becomes the preferred source for
those articles; this pass covers everything the plaintext export carries
today and states its own quality (crossref witnesses, truncation and
ambiguity counters) per article.

Output: %LOCALAPPDATA%/ALR Quote Verifier/citator/journal_commentary.sqlite
  meta            provenance + counters (source db path/size/mtime, ...)
  article         per-article pairing stats and quality witnesses
  note            paired/label_only notes with normalized body, the
                  proposition sentence and passage at the ref site, hashes
  note_citation   case citations found in each note body (anchor grammar
                  from build_citator_graph.py), keyed by cited_key for the
                  citator join

  python -X utf8 scripts/pair_journal_footnotes.py --limit 100   # sample
  python -X utf8 scripts/pair_journal_footnotes.py               # full
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_citator_graph import case_occurrences  # noqa: E402

SCHEMA_VERSION = "beaver.journal_commentary.v1"
ENGINE_NAME = "backend/scripts/pair_journal_footnotes.py"

# ---------------------------------------------------------------------------
# Shared grammar tables (versioned JSON contract, authored in
# shared/grammar-tables/). Minimal loader: JS named groups -> Python, ASCII
# \d as the tables demand; correctness is PROVEN at startup by running each
# entry's own vectors - a vector failure aborts the build.
# ---------------------------------------------------------------------------
TABLE_DIR = Path(__file__).resolve().parents[2] / "shared" / "grammar-tables"


def _load_grammar(table_file: str, wanted: set[str]) -> dict[str, re.Pattern[str]]:
    table = json.loads((TABLE_DIR / table_file).read_text(encoding="utf8"))
    out: dict[str, re.Pattern[str]] = {}
    for entry in table["entries"]:
        if entry["id"] not in wanted:
            continue
        pattern = re.sub(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P<\1>", entry["pattern"])
        flags = re.ASCII
        for flag in entry.get("flags", ""):
            flags |= {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}[flag]
        compiled = re.compile(pattern, flags)
        for vector in entry.get("vectors", ()):
            match = compiled.search(vector["input"])
            groups = vector.get("groups")
            if groups is None:
                if entry["id"] == "label.line-start" and match:
                    raise SystemExit(
                        f"grammar vector regression: {entry['id']} matched {vector['input']!r}"
                    )
                continue
            if not match or any(match.group(k) != v for k, v in groups.items()):
                raise SystemExit(
                    f"grammar vector regression: {entry['id']} on {vector['input']!r}"
                )
        out[entry["id"]] = compiled
    missing = wanted - set(out)
    if missing:
        raise SystemExit(f"grammar entries missing from {table_file}: {missing}")
    return out


_GRAMMAR = {
    **_load_grammar("footnote-labels.json", {"label.line-start", "boundary.sentence.engine"}),
}
LABEL_RE = _GRAMMAR["label.line-start"]
SENTENCE_EDGE_RE = _GRAMMAR["boundary.sentence.engine"]

# Ref-site candidates in normalized body text: 1-3 digits glued to the
# preceding non-space non-digit character (the export flattens superscript
# markers this way), followed by whitespace or end. Admission is gated to
# backbone label values plus monotone assignment below - the pattern is a
# candidate generator, not a verdict (TFP: scores, not gates).
REF_SITE_RE = re.compile(r"(?<=[^\s\d])(?P<num>\d{1,3})(?=\s|$)")
STRONG_GLUE = set(".,;:!?\"'”’)]")

# Note cross-references; pattern from the engine's vendored TFP detector
# (universal-legal-pdf-engine legalpdf/note_crossrefs.py CROSSREF_PATTERN).
# An unresolved cross-reference is a pairing-quality witness.
CROSSREF_RE = re.compile(
    r"\b(?:(?:supra|infra),?\s+(?:foot)?notes?|op\.?\s*cit\.?,?\s+(?:foot)?notes?"
    r"|see\s+(?:also\s+)?footnote)\s+(\d{1,3})\b",
    re.IGNORECASE,
)

# Consumer-side filter (the shared anchor grammar itself is untouched):
# journal note bodies are dense with "12 January 2025" access dates and
# "17 No. 1" volume/issue strings, both of which satisfy the reporter
# shape. Dropped matches are counted, never silently.
DATE_SHAPED_RE = re.compile(
    r"^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|"
    r"September|October|November|December|janvier|février|mars|avril|mai|"
    r"juin|juillet|août|septembre|octobre|novembre|décembre)\s+\d{4}$",
    re.IGNORECASE,
)
ISSUE_SHAPED_RE = re.compile(r"^\d{1,4}\s+No\.?\s+\d+$", re.IGNORECASE)

SOFT_HYPHEN_JOIN_RE = re.compile(r"­\r?\n")
PAGE_MARKER_PROBE_RE = re.compile(r"^\[page [^\]\n]{1,40}\]", re.MULTILINE)


# ---------------------------------------------------------------------------
# Page segmentation - walk the article_pages map exactly like
# backend/src/lib/journalArticles.ts pageBlocks: the map is the authority on
# which pages exist; each label's marker line is located, never discovered.
# ---------------------------------------------------------------------------
def page_segments(
    text: str, page_rows: list[tuple[str, int | None]]
) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    cursor = 0
    for label, pdf_page in page_rows:
        label = str(label or "").strip()
        if not label:
            continue
        marker = f"[page {label}]"
        at = text.find(marker, cursor)
        while at >= 0:
            line_start = text.rfind("\n", 0, at) + 1
            line_end = at + len(marker)
            next_break = text.find("\n", line_end)
            tail = text[line_end : next_break if next_break >= 0 else len(text)]
            if not text[line_start:at].strip(" \t") and not tail.strip(" \t\r"):
                found.append(
                    {"label": label, "pdf_page": pdf_page, "marker_start": line_start,
                     "content_start": (next_break + 1) if next_break >= 0 else len(text)}
                )
                cursor = line_end
                break
            at = text.find(marker, line_end)
    segments: list[dict[str, object]] = []
    if found and found[0]["marker_start"] > 0:
        segments.append({"label": None, "pdf_page": None, "start": 0,
                         "end": found[0]["marker_start"]})
    elif not found:
        segments.append({"label": None, "pdf_page": None, "start": 0, "end": len(text)})
    for index, page in enumerate(found):
        end = found[index + 1]["marker_start"] if index + 1 < len(found) else len(text)
        segments.append({"label": page["label"], "pdf_page": page["pdf_page"],
                         "start": page["content_start"], "end": end})
    return segments


CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def normalize_flow(raw: str) -> str:
    """Join soft-hyphen wraps, flatten hard wraps to spaces, keep blank
    lines as paragraph breaks, collapse runs of spaces."""
    text = SOFT_HYPHEN_JOIN_RE.sub("", raw).replace("­", "")
    text = CONTROL_RE.sub(" ", text)
    paragraphs = re.split(r"\n[ \t]*\n+", text)
    joined = [re.sub(r"\s+", " ", p).strip() for p in paragraphs]
    return "\n\n".join(p for p in joined if p)


# ---------------------------------------------------------------------------
# Label extraction per page segment. A candidate is the export's own note
# rendering: label.line-start match whose label is immediately followed by a
# TAB. Note body runs to the next label line or the segment end (a note
# continuing past the page boundary is truncated and counted - abstain over
# guess).
# ---------------------------------------------------------------------------
def segment_notes(
    text: str, segment: dict[str, object], page_index: int
) -> tuple[list[dict[str, object]], str]:
    start, end = int(segment["start"]), int(segment["end"])
    lines: list[tuple[int, str]] = []
    offset = start
    for line in text[start:end].splitlines(keepends=True):
        lines.append((offset, line))
        offset += len(line)
    # Three export dialects render note labels: `N<TAB>` (body may start
    # on the next line), `N.<TAB>` (trailing period before the tab -
    # Osgoode/Dalhousie style; section headings share this shape and are
    # out-competed by the backbone DP), and `N<2+ spaces>body` (OCR lane;
    # same-line content required, so bare page-number furniture lines
    # never become candidates). Anything else digit-led is excluded.
    label_lines: list[tuple[int, int, str, int]] = []  # (line idx, offset, value, body col)
    for index, (line_offset, line) in enumerate(lines):
        match = LABEL_RE.match(line)
        if not match:
            continue
        after = match.end("label")
        if line[after : after + 1] in ".)]" and line[after + 1 : after + 2] in "\t ":
            after += 1
        if line[after : after + 1] == "\t":
            label_lines.append((index, line_offset, match.group("label"), after + 1))
        elif line[after : after + 2] == "  ":
            rest = line[after:]
            content = rest.lstrip(" ")
            if content.strip():
                label_lines.append(
                    (index, line_offset, match.group("label"),
                     after + (len(rest) - len(content)))
                )
    notes: list[dict[str, object]] = []
    for position, (line_index, line_offset, value, body_col) in enumerate(label_lines):
        body_end = (
            label_lines[position + 1][1] if position + 1 < len(label_lines) else end
        )
        body_start = line_offset + body_col
        body = normalize_flow(text[body_start:body_end])
        notes.append({
            "value": value,
            "page_index": page_index,
            "order": line_offset,
            "body": body,
            # Only a WITNESSED cut counts: the page's final note ending
            # without sentence-terminal punctuation (its tail lives in the
            # next page's note zone, which plaintext cannot attribute).
            "truncated_at_page_end": (
                body_end == end
                and position + 1 == len(label_lines)
                and bool(body)
                and body[-1] not in ".!?\"'”’)]"
            ),
        })
    # Physical reading order puts the note zone at the segment tail, so the
    # body is everything before the first label line.
    first_label_line = label_lines[0][0] if label_lines else len(lines)
    body_raw = "".join(line for _offset, line in lines[:first_label_line])
    return notes, body_raw


# ---------------------------------------------------------------------------
# Backbone selection for the derived plaintext export: the best increasing chain
# (gap 1..5) over numeric label candidates in reading order wins; flanking
# segments recurse; single unsupported chains are dropped. Support = a
# same-value ref site within one page.
# ---------------------------------------------------------------------------
def backbone_indexes(
    labels: list[dict[str, object]], supported: set[int]
) -> set[int]:
    numeric = [i for i, lab in enumerate(labels) if str(lab["value"]).isdigit()]
    selected: set[int] = set()

    def best_chain(indexes: list[int]) -> list[int]:
        if not indexes:
            return []
        states: dict[int, tuple[int, int, int, tuple[int, ...]]] = {}
        best: tuple[int, int, int, tuple[int, ...]] = (0, 0, 0, ())
        for position, label_index in enumerate(indexes):
            value = int(labels[label_index]["value"])
            support = int(label_index in supported)
            state = (1, support, 0, (label_index,))
            for previous_index in indexes[:position]:
                previous_value = int(labels[previous_index]["value"])
                gap = value - previous_value
                if not 1 <= gap <= 5 or previous_index not in states:
                    continue
                prior = states[previous_index]
                candidate = (prior[0] + 1, prior[1] + support,
                             prior[2] - (gap - 1), (*prior[3], label_index))
                if candidate[:3] > state[:3]:
                    state = candidate
            states[label_index] = state
            if state[:3] > best[:3]:
                best = state
        return list(best[3])

    def select(indexes: list[int]) -> None:
        chain = best_chain(indexes)
        if not chain:
            return
        chain_supported = any(index in supported for index in chain)
        only_note_one = (
            len(numeric) == 1 and len(chain) == 1
            and str(labels[chain[0]]["value"]) == "1"
        )
        if len(chain) < 2 and not chain_supported and not only_note_one:
            return
        selected.update(chain)
        first = indexes.index(chain[0])
        last = indexes.index(chain[-1])
        select(indexes[:first])
        select(indexes[last + 1 :])

    select(numeric)
    return selected


# ---------------------------------------------------------------------------
# Sentence at a ref site - port of legalpdf/core.py _sentence_at over the
# boundary.sentence.engine grammar; assigned marker digits are stripped from
# the returned proposition (the plaintext analogue of _INLINE_FN_RE).
# ---------------------------------------------------------------------------
def sentence_at(text: str, offset: int) -> tuple[int, int]:
    boundaries = list(SENTENCE_EDGE_RE.finditer(text))
    previous = [match for match in boundaries if match.end() <= offset]
    if previous and not text[previous[-1].end() : offset].strip():
        end = previous[-1].end()
        start = previous[-2].end() if len(previous) > 1 else 0
    else:
        start = previous[-1].end() if previous else 0
        following = next((m for m in boundaries if m.start() >= offset), None)
        end = following.end() if following else len(text)
    return start, end


def strip_sites(text: str, base: int, sites: list[tuple[int, int]]) -> str:
    """Remove assigned marker digit spans (absolute offsets) from text
    starting at absolute offset base."""
    out: list[str] = []
    cursor = 0
    for start, end in sorted(sites):
        s, e = start - base, end - base
        if e <= 0 or s >= len(text):
            continue
        out.append(text[cursor:max(cursor, s)])
        cursor = max(cursor, e)
    out.append(text[cursor:])
    return re.sub(r"\s+", " ", "".join(out)).strip()


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf8")).hexdigest()


# ---------------------------------------------------------------------------
# Per-article pairing
# ---------------------------------------------------------------------------
def pair_article(text: str, page_rows: list[tuple[str, int | None]]) -> dict[str, object]:
    segments = page_segments(text, page_rows)
    labels: list[dict[str, object]] = []
    bodies: list[dict[str, object]] = []  # per segment: normalized body + page
    for page_index, segment in enumerate(segments):
        notes, body_raw = segment_notes(text, segment, page_index)
        labels.extend(notes)
        normalized = normalize_flow(body_raw)
        bodies.append({"page_index": page_index, "text": normalized})
    labels.sort(key=lambda lab: int(lab["order"]))

    # One body stream with absolute offsets and a page lookup.
    stream_parts: list[str] = []
    stream_pages: list[tuple[int, int]] = []  # (start offset, page_index)
    cursor = 0
    for body in bodies:
        stream_pages.append((cursor, int(body["page_index"])))
        stream_parts.append(str(body["text"]))
        cursor += len(str(body["text"])) + 2
    stream = "\n\n".join(stream_parts)

    def page_of(offset: int) -> int:
        page = 0
        for start, page_index in stream_pages:
            if offset >= start:
                page = page_index
        return page

    sites_by_value: dict[str, list[dict[str, object]]] = {}
    for match in REF_SITE_RE.finditer(stream):
        value = match.group("num").lstrip("0") or "0"
        sites_by_value.setdefault(value, []).append({
            "start": match.start("num"), "end": match.end("num"),
            "page_index": page_of(match.start("num")),
            "strong": stream[match.start("num") - 1] in STRONG_GLUE,
        })

    supported = {
        index for index, lab in enumerate(labels)
        if str(lab["value"]).isdigit()
        and any(abs(int(site["page_index"]) - int(lab["page_index"])) <= 1
                for site in sites_by_value.get(str(int(lab["value"])), ()))
    }
    selected = backbone_indexes(labels, supported)

    # Footnote vs endnote mode: footnote mode when most selected labels have
    # a same-page same-value site; endnote scoring is order-only.
    same_page = sum(
        1 for index in selected
        if any(int(site["page_index"]) == int(labels[index]["page_index"])
               for site in sites_by_value.get(str(int(labels[index]["value"])), ()))
    )
    footnote_mode = bool(selected) and same_page / max(1, len(selected)) >= 0.5

    # Restart sequences over selected labels in reading order (engine port).
    restart_sequence = 1
    previous_numeric: int | None = None
    paired: list[dict[str, object]] = []
    assigned_cursor = 0
    ambiguous_sites = 0
    for index, label in enumerate(labels):
        if index not in selected:
            continue
        numeric = int(label["value"])
        if previous_numeric is not None and numeric <= previous_numeric:
            restart_sequence += 1
            assigned_cursor = 0
        previous_numeric = numeric
        candidates = [
            site for site in sites_by_value.get(str(numeric), ())
            if int(site["start"]) >= assigned_cursor
        ]
        if footnote_mode:
            candidates = [
                site for site in candidates
                if int(site["page_index"]) <= int(label["page_index"]) + 1
            ]
            ranked = sorted(candidates, key=lambda site: (
                not site["strong"],
                abs(int(site["page_index"]) - int(label["page_index"])),
                int(site["start"]),
            ))
        else:
            ranked = sorted(candidates, key=lambda site: (
                not site["strong"], int(site["start"]),
            ))
        chosen = ranked[0] if ranked else None
        if chosen is not None and len(ranked) > 1 and (
            ranked[1]["strong"] == chosen["strong"]
            and ranked[1]["page_index"] != chosen["page_index"]
        ):
            ambiguous_sites += 1
        if chosen is not None:
            assigned_cursor = int(chosen["end"])
        paired.append({
            "label": str(numeric),
            "restart_sequence": restart_sequence,
            "note_page_index": int(label["page_index"]),
            "body": str(label["body"]),
            "truncated": bool(label["truncated_at_page_end"]),
            "site": chosen,
        })

    # Propositions and passages at assigned sites.
    assigned_spans = [
        (int(note["site"]["start"]), int(note["site"]["end"]))
        for note in paired if note["site"] is not None
    ]
    previous_end = 0
    for note in sorted(
        [n for n in paired if n["site"] is not None],
        key=lambda n: int(n["site"]["start"]),
    ):
        site = note["site"]
        start, end = sentence_at(stream, int(site["start"]))
        note["proposition"] = strip_sites(
            stream[start:end], start,
            [s for s in assigned_spans if start <= s[0] < end],
        )
        passage_start = max(previous_end, 0)
        note["passage"] = strip_sites(
            stream[passage_start:int(site["start"])], passage_start,
            [s for s in assigned_spans if passage_start <= s[0] < int(site["start"])],
        )[-1200:]
        previous_end = int(site["end"])

    # Cross-reference quality witness over selected note bodies.
    backbone_values = {str(int(note["label"])) for note in paired}
    crossrefs = unresolved = 0
    for note in paired:
        for match in CROSSREF_RE.finditer(str(note["body"])):
            crossrefs += 1
            if (match.group(1).lstrip("0") or "0") not in backbone_values:
                unresolved += 1

    return {
        "notes": paired,
        "symbol_labels_dropped": sum(
            1 for lab in labels if not str(lab["value"]).isdigit()
        ),
        "labels_candidates": len(labels),
        "labels_selected": len(selected),
        "refs_assigned": len(assigned_spans),
        "ambiguous_sites": ambiguous_sites,
        "footnote_mode": footnote_mode,
        "crossrefs": crossrefs,
        "crossrefs_unresolved": unresolved,
        "pages": len(segments),
    }


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def source_db_path() -> Path:
    configured = (os.environ.get("MIKE_PUBLIC_ENDPOINT_DB") or "").strip()
    if configured:
        return Path(configured)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return (Path(base) / "OpenLegalProducts" / "LegalData" / "providers"
            / "journals" / "public_endpoint.db")


def default_output() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "ALR Quote Verifier" / "citator" / "journal_commentary.sqlite"


OUTPUT_SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE article (
    article_id INTEGER PRIMARY KEY,
    dataset TEXT, citation TEXT, name TEXT, date TEXT,
    journal_name TEXT, authors TEXT, url TEXT,
    pages INTEGER, labels_candidates INTEGER, labels_selected INTEGER,
    refs_assigned INTEGER, ambiguous_sites INTEGER,
    footnote_mode INTEGER, crossrefs INTEGER, crossrefs_unresolved INTEGER
);
CREATE TABLE note (
    id INTEGER PRIMARY KEY,
    article_id INTEGER NOT NULL REFERENCES article(article_id),
    label TEXT NOT NULL, restart_sequence INTEGER NOT NULL,
    pair_status TEXT NOT NULL,          -- paired | label_only
    note_page_label TEXT, ref_page_label TEXT,
    body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
    truncated_at_page_end INTEGER NOT NULL,
    proposition TEXT, proposition_sha256 TEXT,
    passage TEXT
);
CREATE TABLE note_citation (
    note_id INTEGER NOT NULL REFERENCES note(id),
    rank INTEGER NOT NULL,
    kind TEXT NOT NULL, citation TEXT NOT NULL, cited_key TEXT NOT NULL,
    case_short TEXT, pinpoints TEXT
);
CREATE INDEX note_citation_key ON note_citation(cited_key);
CREATE INDEX note_article ON note(article_id);
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=source_db_path())
    parser.add_argument("--output", type=Path, default=default_output())
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    if not args.db.is_file():
        raise SystemExit(f"source not found: {args.db}")
    source = sqlite3.connect(f"file:{args.db.as_posix()}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row

    args.output.parent.mkdir(parents=True, exist_ok=True)
    building = args.output.with_suffix(".building.sqlite")
    if building.exists():
        building.unlink()
    out = sqlite3.connect(building)
    out.executescript(OUTPUT_SCHEMA)

    where = "text IS NOT NULL AND length(text) > 0"
    total = source.execute(f"SELECT count(*) FROM articles WHERE {where}").fetchone()[0]
    limit_sql = f" LIMIT {int(args.limit)}" if args.limit else ""
    started = time.time()
    stats = {"articles": 0, "notes": 0, "paired": 0, "citations": 0,
             "no_labels": 0, "truncated": 0, "symbol_labels_dropped": 0,
             "citations_dropped_dateshaped": 0}
    for row in source.execute(
        f"SELECT article_id, dataset, citation_en, name_en, document_date_en,"
        f" journal_name, authors, galley_url, url_en, text FROM articles"
        f" WHERE {where} ORDER BY article_id{limit_sql}"
    ):
        page_rows = [
            (page["page_label"], page["pdf_page"])
            for page in source.execute(
                "SELECT page_label, pdf_page FROM article_pages"
                " WHERE article_id = ? ORDER BY page_order", (row["article_id"],)
            )
        ]
        result = pair_article(row["text"], page_rows)
        stats["articles"] += 1
        stats["symbol_labels_dropped"] += int(result["symbol_labels_dropped"])
        if not result["labels_selected"]:
            stats["no_labels"] += 1
        out.execute(
            "INSERT INTO article VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["article_id"], row["dataset"], row["citation_en"], row["name_en"],
             row["document_date_en"], row["journal_name"], row["authors"],
             row["galley_url"] or row["url_en"], result["pages"],
             result["labels_candidates"], result["labels_selected"],
             result["refs_assigned"], result["ambiguous_sites"],
             int(bool(result["footnote_mode"])), result["crossrefs"],
             result["crossrefs_unresolved"]),
        )
        for note in result["notes"]:
            stats["notes"] += 1
            body = str(note["body"])
            proposition = note.get("proposition")
            paired_status = "paired" if note["site"] is not None else "label_only"
            if paired_status == "paired":
                stats["paired"] += 1
            if note["truncated"]:
                stats["truncated"] += 1
            cursor = out.execute(
                "INSERT INTO note (article_id, label, restart_sequence, pair_status,"
                " note_page_label, ref_page_label, body, body_sha256,"
                " truncated_at_page_end, proposition, proposition_sha256, passage)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (row["article_id"], note["label"], note["restart_sequence"],
                 paired_status, str(note["note_page_index"]),
                 str(note["site"]["page_index"]) if note["site"] else None,
                 body, sha256(body), int(note["truncated"]),
                 proposition, sha256(proposition) if proposition else None,
                 note.get("passage")),
            )
            occurrences, _kinds = case_occurrences(body)
            kept = []
            for occurrence in occurrences:
                if occurrence["kind"] == "reporter" and (
                    DATE_SHAPED_RE.match(occurrence["citation"])
                    or ISSUE_SHAPED_RE.match(occurrence["citation"])
                ):
                    stats["citations_dropped_dateshaped"] += 1
                    continue
                kept.append(occurrence)
            for rank, occurrence in enumerate(kept, start=1):
                stats["citations"] += 1
                out.execute(
                    "INSERT INTO note_citation VALUES (?,?,?,?,?,?,?)",
                    (cursor.lastrowid, rank, occurrence["kind"],
                     occurrence["citation"], occurrence["key"],
                     occurrence["short"], occurrence["pinpoints"]),
                )
        if stats["articles"] % 500 == 0:
            out.commit()
            print(f"[pair] {stats['articles']}/{total if not args.limit else args.limit}"
                  f" articles, {stats['paired']}/{stats['notes']} notes paired,"
                  f" {stats['citations']} citations", flush=True)

    src_stat = args.db.stat()
    meta = {
        "schema_version": SCHEMA_VERSION,
        "engine": ENGINE_NAME,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_path": str(args.db),
        "source_size": str(src_stat.st_size),
        "source_mtime_ms": str(int(src_stat.st_mtime * 1000)),
        "grammar_tables": str(TABLE_DIR),
        **{f"count_{key}": str(value) for key, value in stats.items()},
    }
    out.executemany("INSERT INTO meta VALUES (?,?)", sorted(meta.items()))
    out.commit()
    out.close()
    if args.output.exists():
        args.output.unlink()
    building.rename(args.output)
    print(f"[pair] done in {time.time() - started:.0f}s -> {args.output}")
    for key, value in stats.items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
