#!/usr/bin/env python3
"""Build the Beaver Stage 1 citator note-up graph from the local A2AJ case corpus.

Stage 1 of docs/citator-good-law-research.md ("exact note-up graph"): every
edge is a literal citation occurrence found in a citing case's text, stored
with the citing paragraph number, character offset, cited-side pinpoint
fragments, and a bounded excerpt (max ~600 chars) so a reader can inspect the
context. No treatment labels, no model calls, no network.

Usage:
  python scripts/build_citator_graph.py [--jurisdiction SCC,FCA,...]
      [--limit N] [--output PATH] [--corpus-root PATH] [--jsonl PATH]

  --jurisdiction  Comma-separated court-family directory names under
                  <corpus-root>/cases (SCC, FC, ONCA, ...; case-insensitive).
                  Default: every family in the corpus manifest.
  --limit         Stop after this many case rows (0 = all) - smoke builds.
  --output        Default: %LOCALAPPDATA%\\ALR Quote Verifier\\citator\\noteup.sqlite
  --corpus-root   Default: %LOCALAPPDATA%\\ALR Quote Verifier\\a2aj_corpus
                  (the ALR Quote Verifier data directory contract; families
                  live under cases/<FAMILY>/train.parquet).
  --jsonl         TESTABILITY INPUT MODE: read corpus-shaped rows (the same
                  column names the parquet files carry) from a JSONL file
                  instead of duckdb-streaming the corpus. The unit test drives
                  this script over a tiny fixture this way. In this mode no
                  duckdb import and no resolution step happen.

Corpus schema (probed with duckdb 2026-07-28, uniform across families):
dataset, citation_en/_fr, citation2_en/_fr, name_en/_fr, document_date_en/_fr
(TIMESTAMPTZ at UTC midnight), url_en/_fr, unofficial_text_en/_fr,
cases_cited_en/_fr, cases_citing_en/_fr, citing_cases_count, upstream_license.
Extraction runs over unofficial_text_en, falling back to unofficial_text_fr
only when there is no English text, so one judgment's two language versions
never double-count the same citation.

Citation discovery, styled spans, pinpoints and versioned authority keys come
from legal_citations. Host paragraphs come from legal-structure. This builder
stores graph evidence and provider records; it owns no citation grammar.
The ALR corpus lookup index must be built with the same shared key version.

Self-citations are skipped: corpus texts open with a header repeating the
decision's own citation ("Neutral citation\n2019 SCC 67"), which would give
nearly every case a spurious edge to itself. A case's own keys are the
citation_lookup_key of its citation_en/citation2_en/citation_fr/citation2_fr.

PROVIDER GRAPH, MINER AS DIFFERENTIAL: the corpus rows carry a curated
citation graph (cases_cited_en/_fr, cases_citing_en/_fr - lists of neutral
citations; 64% of case rows have a non-empty cited list, ~1.0M cited edges
corpus-wide, probed 2026-07-30). Those columns are stored verbatim in
provider_edge as the node-level authority; the citation engine keeps supplying
what the lists cannot (paragraph anchors, offsets, pinpoints, excerpts),
and the build measures the two against each other per doc
(provider_keys_mined_confirmed / provider_keys_unmined /
mined_keys_unlisted in meta) instead of reconciling them.

Output SQLite schema (read by backend/src/lib/caselawCitator.ts; the build
writes <output>.new then os.replace's it, mirroring import_a2aj_hansard.py):
  meta(key, value)
  case_doc(id, path, file_row_number, citation, citation2, name, court,
           date, url, language, occurrence_count)  -- one row per scanned case
  edge(id, cited_key, cited_citation, cited_short, case_id, paragraph,
       text_offset, pinpoints, excerpt)            -- one row per occurrence
  resolution(cited_key, path, file_row_number, exact_value)
  case_key(case_id, citation_key)                  -- each case's own keys
  provider_edge(id, case_id, direction, citation, citation_key)
                                                   -- curated lists, verbatim
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from legal_structure_client import paragraph_blocks
from legal_citations import extract, key_for_text

def citation_lookup_key(value: str) -> str:
    return key_for_text(value) or ""


# ---------------------------------------------------------------------------
# Occurrence extraction over one case text
# ---------------------------------------------------------------------------
EXCERPT_BEFORE = 250
EXCERPT_AFTER = 350
EXCERPT_MAX = 600
WHITESPACE_RE = re.compile(r"\s+")


def excerpt_around(text: str, start: int, end: int) -> str:
    window = text[max(0, start - EXCERPT_BEFORE): min(len(text), end + EXCERPT_AFTER)]
    return WHITESPACE_RE.sub(" ", window).strip()[:EXCERPT_MAX]


def case_occurrences(text: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Project shared-engine citations into graph rows, retaining source offsets."""
    occurrences: list[dict[str, Any]] = []
    kind_counts: dict[str, int] = {}
    for citation in extract(text):
        if citation["form"] != "full":
            continue
        kind = {"can_lii": "canlii", "statute_volume": "statute", "regulation_series": "statute",
                "code": "statute", "publication": citation["authority"]}.get(
                    citation.get("format"), citation.get("format") or citation["authority"])
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        if citation["authority"] != "case" or not citation.get("key"):
            continue
        core = citation["span"]
        pins = ["par" + value for pin in citation.get("pinpoints", []) if pin["kind"] == "paragraph"
                for value in (pin["first"], pin.get("last")) if value]
        occurrences.append({"start": core["start"], "end": core["end"], "kind": kind,
            "citation": core["text"], "key": citation["key"], "short": citation.get("shortName"),
            "pinpoints": ",".join(pins) or None})
    return occurrences, kind_counts


def paragraph_for_offset(
    paragraphs: list[tuple[str, list[str], int, int]], offset: int
) -> int | None:
    for label, _aliases, start, end in paragraphs:
        if start <= offset < end:
            return int(label[3:])
    return None


# ---------------------------------------------------------------------------
# Corpus row sources
# ---------------------------------------------------------------------------
CORPUS_COLUMNS = (
    "dataset", "citation_en", "citation_fr", "citation2_en", "citation2_fr",
    "name_en", "name_fr", "document_date_en", "document_date_fr",
    "url_en", "url_fr", "unofficial_text_en", "unofficial_text_fr",
    "cases_cited_en", "cases_cited_fr", "cases_citing_en", "cases_citing_fr",
)


def default_corpus_root() -> Path:
    """%LOCALAPPDATA%/ALR Quote Verifier/a2aj_corpus - the ALR Quote Verifier
    data-directory contract (verifier_core.paths.data_dir), replicated here so
    Beaver reads the same corpus without importing the reference project."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "ALR Quote Verifier" / "a2aj_corpus"


def default_output() -> Path:
    configured = os.environ.get("MIKE_CITATOR_DB", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "ALR Quote Verifier" / "citator" / "noteup.sqlite"


def corpus_parquet_files(corpus_root: Path, jurisdictions: list[str] | None) -> list[tuple[str, Path]]:
    cases_dir = corpus_root / "cases"
    manifest_path = cases_dir / "manifest.json"
    entries: list[str]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entries = [str(item["path"]) for item in manifest.get("files") or ()]
    except (OSError, ValueError, TypeError, KeyError):
        # Manifest missing: fall back to the directory layout.
        if not cases_dir.is_dir():
            raise FileNotFoundError(
                f"cases corpus not found under {cases_dir} "
                "(pass --corpus-root, or --jsonl for file input)"
            ) from None
        entries = sorted(
            f"{family.name}/{file.name}"
            for family in cases_dir.iterdir() if family.is_dir()
            for file in family.glob("*.parquet")
        )
    wanted = {value.upper() for value in jurisdictions} if jurisdictions else None
    files: list[tuple[str, Path]] = []
    for relative in sorted(entries):
        family = relative.split("/", 1)[0]
        if wanted and family.upper() not in wanted:
            continue
        path = cases_dir / Path(*relative.split("/"))
        if path.is_file():
            files.append((relative, path))
    if not files:
        raise FileNotFoundError(
            f"no case parquet files under {cases_dir}"
            + (f" for jurisdiction(s) {', '.join(sorted(wanted))}" if wanted else "")
        )
    return files


def parquet_rows(files: list[tuple[str, Path]], limit: int) -> Iterator[dict[str, Any]]:
    try:
        import duckdb
    except ImportError as error:
        raise RuntimeError(
            "Reading the parquet corpus requires the duckdb package "
            "(python -m pip install duckdb), or use --jsonl input"
        ) from error
    connection = duckdb.connect()
    connection.execute("PRAGMA disable_progress_bar")
    emitted = 0
    for relative, path in files:
        if limit and emitted >= limit:
            break
        escaped = str(path).replace("'", "''")
        cursor = connection.execute(
            f"SELECT {', '.join(CORPUS_COLUMNS)}, file_row_number "
            f"FROM read_parquet('{escaped}', file_row_number=true) "
            "WHERE unofficial_text_en IS NOT NULL OR unofficial_text_fr IS NOT NULL"
        )
        names = [item[0] for item in cursor.description]
        while True:
            rows = cursor.fetchmany(100)
            if not rows:
                break
            for row in rows:
                record = dict(zip(names, row))
                record["_path"] = relative
                yield record
                emitted += 1
                if limit and emitted >= limit:
                    break
            if limit and emitted >= limit:
                break


def jsonl_rows(path: Path, limit: int) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8-sig") as source:
        emitted = 0
        for line_number, line in enumerate(source, 1):
            if limit and emitted >= limit:
                break
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{line_number}: expected a JSON object")
            yield row
            emitted += 1


def clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def iso_date(value: Any) -> str | None:
    """UTC calendar date for TIMESTAMPTZ values (the corpus stores UTC
    midnights, e.g. 2019-12-19 17:00-07 is the 2019-12-20 decision date);
    ISO date strings pass through."""
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc)
        return value.date().isoformat()
    text = clean(value)
    if text and re.match(r"^\d{4}-\d{2}-\d{2}", text):
        return text[:10]
    return None


def provider_list(row: dict[str, Any], base: str, language: str) -> list[str]:
    """The provider-curated citation list, preferring the language whose text
    was scanned; the other language only when that column is absent (None).
    An empty list is provider data ("no citations"), not absence."""
    for candidate in (language, "fr" if language == "en" else "en"):
        value = row.get(f"{base}_{candidate}")
        if value is not None:
            return [text for item in value if (text := clean(item))]
    return []


def mapped_case(row: dict[str, Any]) -> dict[str, Any] | None:
    english = clean(row.get("unofficial_text_en"))
    text = english or clean(row.get("unofficial_text_fr"))
    if not text:
        return None
    language = "en" if english else "fr"
    own_keys = {
        key
        for field in ("citation_en", "citation2_en", "citation_fr", "citation2_fr")
        if (key := citation_lookup_key(clean(row.get(field)) or ""))
    }
    return {
        "path": clean(row.get("_path")),
        "file_row_number": row.get("file_row_number"),
        "court": clean(row.get("dataset")),
        "citation": clean(row.get("citation_en")) or clean(row.get("citation_fr")),
        "citation2": clean(row.get("citation2_en")) or clean(row.get("citation2_fr")),
        "name": clean(row.get("name_en")) or clean(row.get("name_fr")),
        "date": iso_date(row.get("document_date_en")) or iso_date(row.get("document_date_fr")),
        "url": clean(row.get("url_en")) or clean(row.get("url_fr")),
        "language": language,
        "text": text,
        "own_keys": own_keys,
        "provider_cited": provider_list(row, "cases_cited", language),
        "provider_citing": provider_list(row, "cases_citing", language),
    }


# ---------------------------------------------------------------------------
# Resolution: cited_key -> corpus row candidates, using the lookup index the
# ALR Quote Verifier app builds beside the corpus (read-only; schema "5" has
# lookups(path, file_row_number, field_name, exact_value, lookup_type,
# lookup_key) keyed by the same citation_lookup_key). Data dependency only -
# if the index is missing or its schema is unexpected we skip and record why.
# ---------------------------------------------------------------------------
def resolve_cited_keys(corpus_root: Path, keys: list[str]) -> tuple[list[tuple[str, str, int, str]], str]:
    index_path = corpus_root / "cases" / "lookup.duckdb"
    if not index_path.is_file():
        return [], "skipped: no cases/lookup.duckdb index"
    try:
        import duckdb
        connection = duckdb.connect()
        connection.execute("PRAGMA disable_progress_bar")
        escaped = str(index_path).replace("'", "''")
        connection.execute(f"ATTACH '{escaped}' AS lookup_index (READ_ONLY)")
        metadata = dict(connection.execute(
            "SELECT key, value FROM lookup_index.metadata "
            "WHERE key IN ('schema', 'revision')"
        ).fetchall())
        if metadata.get("schema") != "5":
            return [], f"skipped: unexpected lookup index schema {metadata.get('schema')!r}"
        connection.execute("CREATE TEMP TABLE wanted(key VARCHAR)")
        connection.executemany("INSERT INTO wanted VALUES (?)", [(key,) for key in keys])
        # Alias closure: resolve the keys that occur as edges, then record
        # EVERY citation key of each resolved decision (citation_en/_fr,
        # citation2_en/_fr), so a reader queried with a form that never
        # appears in the scanned texts - the French twin, say - still reaches
        # the decision's edges. Pure corpus evidence, no inferred equivalence.
        rows = connection.execute(
            "WITH targets AS ("
            "  SELECT DISTINCT lookups.path, lookups.file_row_number"
            "  FROM wanted JOIN lookup_index.lookups AS lookups"
            "    ON lookups.lookup_type = 'citation'"
            "   AND lookups.lookup_key = wanted.key"
            ") "
            "SELECT DISTINCT lookups.lookup_key, lookups.path, "
            "       lookups.file_row_number, lookups.exact_value "
            "FROM lookup_index.lookups AS lookups "
            "JOIN targets ON targets.path = lookups.path "
            "           AND targets.file_row_number = lookups.file_row_number "
            "WHERE lookups.lookup_type = 'citation'"
        ).fetchall()
        return (
            [(str(key), str(path), int(row_number), str(value))
             for key, path, row_number, value in rows],
            f"resolved against lookup index revision {metadata.get('revision', '')!r}",
        )
    except Exception as error:  # typed skip, never a guessed resolution
        return [], f"skipped: {error}"


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE case_doc (
    id INTEGER PRIMARY KEY,
    path TEXT,
    file_row_number INTEGER,
    citation TEXT,
    citation2 TEXT,
    name TEXT,
    court TEXT,
    date TEXT,
    url TEXT,
    language TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL
);
CREATE TABLE edge (
    id INTEGER PRIMARY KEY,
    cited_key TEXT NOT NULL,
    cited_citation TEXT NOT NULL,
    cited_short TEXT,
    case_id INTEGER NOT NULL REFERENCES case_doc(id),
    paragraph INTEGER,
    text_offset INTEGER NOT NULL,
    pinpoints TEXT,
    excerpt TEXT NOT NULL
);
CREATE TABLE resolution (
    cited_key TEXT NOT NULL,
    path TEXT NOT NULL,
    file_row_number INTEGER NOT NULL,
    exact_value TEXT NOT NULL
);
CREATE TABLE case_key (
    case_id INTEGER NOT NULL REFERENCES case_doc(id),
    citation_key TEXT NOT NULL,
    PRIMARY KEY (case_id, citation_key)
) WITHOUT ROWID;
CREATE TABLE provider_edge (
    id INTEGER PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES case_doc(id),
    direction TEXT NOT NULL CHECK (direction IN ('cited', 'citing')),
    citation TEXT NOT NULL,
    citation_key TEXT NOT NULL
);
CREATE TABLE authority_metric (
    cited_key TEXT PRIMARY KEY,
    citing_cases INTEGER NOT NULL,
    citing_paragraphs INTEGER NOT NULL,
    occurrences INTEGER NOT NULL
) WITHOUT ROWID;
"""

INDEXES = """
CREATE INDEX edge_cited_idx ON edge(cited_key);
CREATE INDEX edge_case_idx ON edge(case_id);
CREATE INDEX case_doc_citation_idx ON case_doc(citation);
CREATE INDEX resolution_key_idx ON resolution(cited_key);
CREATE INDEX resolution_target_idx ON resolution(path, file_row_number);
CREATE INDEX case_key_key_idx ON case_key(citation_key);
CREATE INDEX provider_edge_key_idx ON provider_edge(citation_key, direction);
CREATE INDEX provider_edge_case_idx ON provider_edge(case_id);
"""


def build(args: argparse.Namespace) -> None:
    started = time.monotonic()
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".new")
    temporary.unlink(missing_ok=True)

    corpus_root = Path(args.corpus_root).expanduser().resolve()
    jurisdictions = (
        [value.strip() for value in args.jurisdiction.split(",") if value.strip()]
        if args.jurisdiction
        else None
    )
    if args.jsonl:
        rows: Iterator[dict[str, Any]] = jsonl_rows(Path(args.jsonl), args.limit)
        source = "jsonl"
        inputs = [Path(args.jsonl).name]
    else:
        files = corpus_parquet_files(corpus_root, jurisdictions)
        rows = parquet_rows(files, args.limit)
        source = "parquet"
        inputs = [relative for relative, _path in files]
        print(f"Reading {len(files)} parquet file(s): "
              + ", ".join(sorted({relative.split('/', 1)[0] for relative, _ in files})))

    connection = sqlite3.connect(temporary)
    counters = {
        "rows_scanned": 0,
        "cases_indexed": 0,
        "rows_skipped_no_text": 0,
        "rows_skipped_duplicate": 0,
        "case_citation_occurrences": 0,
        "self_citations_skipped": 0,
        "edges": 0,
        "provider_cited_docs": 0,
        "provider_cited_edges": 0,
        "provider_citing_edges": 0,
        # Miner-vs-provider differential over docs with a curated cited list:
        # the provider column is the node-level authority; the mined edges
        # carry the occurrence evidence. Divergence is measured, never patched.
        "provider_keys_mined_confirmed": 0,
        "provider_keys_unmined": 0,
        "mined_keys_unlisted": 0,
    }
    kind_totals: dict[str, int] = {}
    seen_identities: set[str] = set()
    edge_batch: list[tuple[Any, ...]] = []
    provider_batch: list[tuple[Any, ...]] = []
    case_key_batch: list[tuple[int, str]] = []

    def flush_edges() -> None:
        if edge_batch:
            connection.executemany(
                "INSERT INTO edge (cited_key, cited_citation, cited_short, case_id,"
                " paragraph, text_offset, pinpoints, excerpt)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                edge_batch,
            )
            edge_batch.clear()
        if provider_batch:
            connection.executemany(
                "INSERT INTO provider_edge (case_id, direction, citation,"
                " citation_key) VALUES (?, ?, ?, ?)",
                provider_batch,
            )
            provider_batch.clear()
        if case_key_batch:
            connection.executemany(
                "INSERT OR IGNORE INTO case_key VALUES (?, ?)", case_key_batch
            )
            case_key_batch.clear()

    try:
        connection.executescript(
            "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;"
            + SCHEMA
        )
        for row in rows:
            counters["rows_scanned"] += 1
            case = mapped_case(row)
            if case is None:
                counters["rows_skipped_no_text"] += 1
                continue
            identity = (
                f"u:{case['url']}" if case["url"]
                else f"c:{case['citation']}" if case["citation"] else None
            )
            if identity:
                if identity in seen_identities:
                    counters["rows_skipped_duplicate"] += 1
                    continue
                seen_identities.add(identity)
            text = case["text"]
            occurrences, kind_counts = case_occurrences(text)
            for kind, count in kind_counts.items():
                kind_totals[kind] = kind_totals.get(kind, 0) + count
            paragraphs = paragraph_blocks(
                case["citation"] or "", text, case["court"] or None
            ) if occurrences else []
            case_id = counters["cases_indexed"] + 1
            case_edges = 0
            mined_keys: set[str] = set()
            for occurrence in occurrences:
                counters["case_citation_occurrences"] += 1
                if occurrence["key"] in case["own_keys"]:
                    counters["self_citations_skipped"] += 1
                    continue
                mined_keys.add(occurrence["key"])
                edge_batch.append((
                    occurrence["key"],
                    occurrence["citation"],
                    occurrence["short"],
                    case_id,
                    paragraph_for_offset(paragraphs, occurrence["start"]),
                    occurrence["start"],
                    occurrence["pinpoints"],
                    excerpt_around(text, occurrence["start"], occurrence["end"]),
                ))
                case_edges += 1
                if len(edge_batch) >= 1_000:
                    flush_edges()
            case_key_batch.extend((case_id, key) for key in case["own_keys"])
            for direction in ("cited", "citing"):
                for citation in case[f"provider_{direction}"]:
                    key = citation_lookup_key(citation)
                    if not key:
                        continue
                    provider_batch.append((case_id, direction, citation, key))
                    counters[f"provider_{direction}_edges"] += 1
            if case["provider_cited"]:
                counters["provider_cited_docs"] += 1
                provider_keys = {
                    key for citation in case["provider_cited"]
                    if (key := citation_lookup_key(citation))
                }
                counters["provider_keys_mined_confirmed"] += len(
                    provider_keys & mined_keys
                )
                counters["provider_keys_unmined"] += len(
                    provider_keys - mined_keys
                )
                counters["mined_keys_unlisted"] += len(
                    mined_keys - provider_keys
                )
            connection.execute(
                "INSERT INTO case_doc (id, path, file_row_number, citation, citation2,"
                " name, court, date, url, language, occurrence_count)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (case_id, case["path"], case["file_row_number"], case["citation"],
                 case["citation2"], case["name"], case["court"], case["date"],
                 case["url"], case["language"], case_edges),
            )
            counters["cases_indexed"] += 1
            counters["edges"] += case_edges
            if counters["cases_indexed"] % 500 == 0:
                flush_edges()
                connection.commit()
                print(f"  {counters['cases_indexed']:,} cases, "
                      f"{counters['edges']:,} edges, "
                      f"{time.monotonic() - started:,.0f}s", flush=True)
        flush_edges()

        distinct_cited = connection.execute(
            "SELECT COUNT(DISTINCT cited_key) FROM edge"
        ).fetchone()[0]
        resolution_note = "skipped: jsonl input mode"
        resolution_rows: list[tuple[str, str, int, str]] = []
        resolved_edge_keys = 0
        if source == "parquet":
            keys = [row[0] for row in connection.execute(
                "SELECT DISTINCT cited_key FROM edge"
            ).fetchall()]
            resolution_rows, resolution_note = resolve_cited_keys(corpus_root, keys)
            connection.executemany(
                "INSERT INTO resolution VALUES (?, ?, ?, ?)", resolution_rows
            )
            resolved_edge_keys = len(
                set(keys) & {row[0] for row in resolution_rows}
            )
        connection.executescript(INDEXES)
        connection.execute(
            """INSERT INTO authority_metric
               SELECT cited_key, COUNT(DISTINCT case_id),
                      COUNT(DISTINCT CAST(case_id AS TEXT) || ':' ||
                        COALESCE(CAST(paragraph AS TEXT), '')),
                      COUNT(*)
               FROM edge GROUP BY cited_key"""
        )
        resolution_keys = len({row[0] for row in resolution_rows})
        metadata = {
            "schema_version": "3",
            "built_at": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "inputs": ", ".join(inputs),
            "jurisdiction": args.jurisdiction or "",
            "limit": str(args.limit),
            "normalization": "legal-citations key version 3; host paragraphs from legal-structure",
            "paragraph_compiler": "legal-structure",
            "resolution": resolution_note,
            "resolved_edge_keys": str(resolved_edge_keys),
            "resolution_keys": str(resolution_keys),
            "resolution_rows": str(len(resolution_rows)),
            "distinct_cited": str(distinct_cited),
            "anchor_counts": json.dumps(kind_totals, sort_keys=True),
            **{key: str(value) for key, value in counters.items()},
        }
        connection.executemany("INSERT INTO meta VALUES (?, ?)", metadata.items())
        connection.commit()
        connection.execute("ANALYZE")
        connection.commit()
    except Exception:
        connection.close()
        temporary.unlink(missing_ok=True)
        raise
    else:
        connection.close()
        os.replace(temporary, output)
        seconds = time.monotonic() - started
        size_mb = output.stat().st_size / 1_048_576
        print(
            f"Note-up graph written to {output}\n"
            f"  cases indexed:           {counters['cases_indexed']:,}\n"
            f"  rows without text:       {counters['rows_skipped_no_text']:,}\n"
            f"  duplicate rows skipped:  {counters['rows_skipped_duplicate']:,}\n"
            f"  case-cite occurrences:   {counters['case_citation_occurrences']:,}\n"
            f"  self-citations skipped:  {counters['self_citations_skipped']:,}\n"
            f"  edges written:           {counters['edges']:,}\n"
            f"  distinct cited keys:     {distinct_cited:,}\n"
            f"  provider cited edges:    {counters['provider_cited_edges']:,} "
            f"({counters['provider_cited_docs']:,} docs)\n"
            f"  provider citing edges:   {counters['provider_citing_edges']:,}\n"
            f"  miner vs provider:       "
            f"{counters['provider_keys_mined_confirmed']:,} confirmed, "
            f"{counters['provider_keys_unmined']:,} provider-only, "
            f"{counters['mined_keys_unlisted']:,} mined-only\n"
            f"  resolution:              {resolution_note} "
            f"({resolved_edge_keys:,} edge keys resolved, "
            f"{resolution_keys:,} alias-closure keys, "
            f"{len(resolution_rows):,} rows)\n"
            f"  anchor counts:           {json.dumps(kind_totals, sort_keys=True)}\n"
            f"  wall time:               {seconds:,.1f}s\n"
            f"  database size:           {size_mb:,.1f} MB"
        )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Build the Beaver Stage 1 citator note-up graph",
    )
    result.add_argument("--jurisdiction", default="",
                        help="comma-separated court families (e.g. SCC,FCA,FC)")
    result.add_argument("--limit", type=int, default=0,
                        help="stop after this many case rows (0 = all)")
    result.add_argument("--output", default=str(default_output()))
    result.add_argument("--corpus-root", default=str(default_corpus_root()))
    result.add_argument("--jsonl", default="",
                        help="read corpus-shaped rows from a JSONL file (tests)")
    return result


if __name__ == "__main__":
    try:
        build(parser().parse_args())
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
