#!/usr/bin/env python3
"""Stream A2AJ JSONL or Parquet snapshots into one local SQLite database."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from open_legal_data_bridge import data_root


SCHEMA = """
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE document (
    id INTEGER PRIMARY KEY,
    doc_type TEXT NOT NULL,
    dataset TEXT NOT NULL,
    citation_en TEXT,
    citation_fr TEXT,
    citation2_en TEXT,
    citation2_fr TEXT,
    name_en TEXT,
    name_fr TEXT,
    document_date_en TEXT,
    document_date_fr TEXT,
    url_en TEXT,
    url_fr TEXT,
    unofficial_text_en TEXT,
    unofficial_text_fr TEXT,
    unofficial_sections_en TEXT,
    unofficial_sections_fr TEXT,
    cases_cited_en TEXT,
    cases_cited_fr TEXT,
    cases_citing_en TEXT,
    cases_citing_fr TEXT,
    citing_cases_count INTEGER,
    upstream_license TEXT
);
CREATE TABLE citation_lookup (
    citation_key TEXT NOT NULL,
    document_id INTEGER NOT NULL,
    PRIMARY KEY (citation_key, document_id)
) WITHOUT ROWID;
"""


def default_output() -> Path:
    configured = os.environ.get("MIKE_A2AJ_BULK_DB", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (data_root() / "providers" / "a2aj" / "a2aj.sqlite").resolve()


def citation_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = value.replace("\u2013", "-").replace("\u2014", "-")
    value = re.sub(r"(?<=\d)\.(?=\d)", "dot", value)
    value = re.sub(r"(?<=\d)-(?=\d)", "dash", value)
    value = re.sub(r"(?<=\d)/(?=\d)", "slash", value)
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def json_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo:
            value = value.astimezone(timezone.utc)
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def field(row: dict[str, Any], name: str, language: str | None = None) -> str | None:
    candidates = [f"{name}_{language}"] if language else [name]
    if language:
        candidates.append(name)
    for candidate in candidates:
        value = json_value(row.get(candidate))
        if value is not None and value.strip():
            return value
    return None


def url(row: dict[str, Any], language: str) -> str | None:
    return field(row, "source_url", language) or field(row, "url", language)


def normalize_doc_type(value: Any) -> str | None:
    normalized = str(value or "").strip().casefold()
    if normalized in {"case", "cases"}:
        return "cases"
    if normalized in {"law", "laws", "statute", "statutes"}:
        return "laws"
    return None


def inferred_doc_type(path: Path, dataset: str) -> str:
    for part in reversed(path.parts):
        found = normalize_doc_type(part)
        if found:
            return found
        if re.search(r"law|legislation|statute|regulation", part, re.I):
            return "laws"
        if re.search(r"case", part, re.I):
            return "cases"
    return (
        "laws"
        if re.search(r"law|legislation|statute|regulation", dataset, re.I)
        else "cases"
    )


def sources(values: list[str]) -> list[tuple[Path, str]]:
    found: dict[Path, str] = {}
    for value in values:
        root = Path(value).expanduser().resolve()
        if root.is_dir():
            for path in sorted(root.rglob("*")):
                if path.is_file() and path.suffix.casefold() in {".jsonl", ".parquet"}:
                    relative = path.relative_to(root)
                    dataset = (
                        relative.parts[0] if len(relative.parts) > 1 else path.stem
                    )
                    found.setdefault(path, dataset)
        elif root.is_file() and root.suffix.casefold() in {".jsonl", ".parquet"}:
            generic = re.match(r"^(?:train|test|validation|part)[-_]", root.stem, re.I)
            found.setdefault(root, root.parent.name if generic else root.stem)
        else:
            raise FileNotFoundError(f"Expected a JSONL/Parquet file or directory: {root}")
    if not found:
        raise ValueError("No .jsonl or .parquet inputs were found")
    return list(found.items())


def jsonl_rows(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8-sig") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: {error.msg}") from error
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{line_number}: expected a JSON object")
            yield row


def parquet_rows(path: Path) -> Iterator[dict[str, Any]]:
    try:
        import pyarrow.parquet as parquet
    except ImportError as error:
        raise RuntimeError(
            "Parquet input requires pyarrow; install it with: "
            "python -m pip install pyarrow"
        ) from error
    parquet_file = parquet.ParquetFile(path)
    for batch in parquet_file.iter_batches(batch_size=1_000):
        yield from batch.to_pylist()


def records(
    inputs: list[tuple[Path, str]],
) -> Iterator[tuple[Path, str, dict[str, Any]]]:
    for path, dataset in inputs:
        rows = (
            parquet_rows(path)
            if path.suffix.casefold() == ".parquet"
            else jsonl_rows(path)
        )
        for row in rows:
            yield path, dataset, row


def document_values(
    document_id: int,
    path: Path,
    dataset_hint: str,
    row: dict[str, Any],
    doc_type_override: str | None = None,
) -> tuple[tuple[Any, ...], set[str]] | None:
    dataset = (field(row, "dataset") or dataset_hint).strip()
    citations = {
        language: (field(row, "citation", language), field(row, "citation2", language))
        for language in ("en", "fr")
    }
    keys = {
        citation_key(value)
        for values in citations.values()
        for value in values
        if value and citation_key(value)
    }
    if not keys:
        return None
    doc_type = (
        doc_type_override
        or normalize_doc_type(row.get("doc_type"))
        or normalize_doc_type(row.get("document_type"))
        or inferred_doc_type(path, dataset)
    )
    values = (
        document_id,
        doc_type,
        dataset,
        citations["en"][0],
        citations["fr"][0],
        citations["en"][1],
        citations["fr"][1],
        field(row, "name", "en"),
        field(row, "name", "fr"),
        field(row, "document_date", "en"),
        field(row, "document_date", "fr"),
        url(row, "en"),
        url(row, "fr"),
        field(row, "unofficial_text", "en"),
        field(row, "unofficial_text", "fr"),
        field(row, "unofficial_sections", "en"),
        field(row, "unofficial_sections", "fr"),
        # Provider-curated citation graph (JSON citation lists) — carried
        # through so no consumer has to re-mine what the corpus states.
        field(row, "cases_cited", "en"),
        field(row, "cases_cited", "fr"),
        field(row, "cases_citing", "en"),
        field(row, "cases_citing", "fr"),
        row.get("citing_cases_count"),
        field(row, "upstream_license"),
    )
    return values, keys


def import_database(args: argparse.Namespace) -> None:
    inputs = sources(args.inputs)
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".new")
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    document_count = citation_count = skipped_count = 0
    document_batch: list[tuple[Any, ...]] = []
    citation_batch: list[tuple[str, int]] = []

    def flush() -> None:
        if not document_batch:
            return
        connection.executemany(
            f"INSERT INTO document VALUES ({','.join('?' for _ in range(23))})",
            document_batch,
        )
        connection.executemany(
            "INSERT INTO citation_lookup VALUES (?, ?)", citation_batch
        )
        document_batch.clear()
        citation_batch.clear()

    try:
        connection.executescript(
            "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;"
            + SCHEMA
        )
        for path, dataset, row in records(inputs):
            imported = document_values(
                document_count + 1,
                path,
                dataset,
                row,
                None if args.doc_type == "auto" else args.doc_type,
            )
            if not imported:
                skipped_count += 1
                continue
            values, keys = imported
            document_count += 1
            document_batch.append(values)
            citation_batch.extend((key, document_count) for key in keys)
            citation_count += len(keys)
            if len(document_batch) == 1_000:
                flush()
        flush()
        connection.executescript(
            """
            CREATE INDEX document_dataset_idx ON document(doc_type, dataset);
            CREATE INDEX document_date_en_idx ON document(document_date_en);
            CREATE INDEX document_date_fr_idx ON document(document_date_fr);
            """
        )
        if args.fts:
            connection.executescript(
                """
                CREATE VIRTUAL TABLE document_search USING fts5(
                    citation_en, citation_fr, citation2_en, citation2_fr,
                    name_en, name_fr, unofficial_text_en, unofficial_text_fr,
                    content='document', content_rowid='id'
                );
                INSERT INTO document_search(
                    rowid, citation_en, citation_fr, citation2_en, citation2_fr,
                    name_en, name_fr, unofficial_text_en, unofficial_text_fr
                )
                SELECT
                    id, citation_en, citation_fr, citation2_en, citation2_fr,
                    name_en, name_fr, unofficial_text_en, unofficial_text_fr
                FROM document;
                """
            )
        metadata = {
            "schema_version": "2",
            "imported_at": datetime.now(timezone.utc).isoformat(),
            "fts": "true" if args.fts else "false",
            "file_count": str(len(inputs)),
            "document_count": str(document_count),
            "citation_count": str(citation_count),
            "skipped_count": str(skipped_count),
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
        print(
            f"Imported {document_count:,} A2AJ documents and "
            f"{citation_count:,} citation keys from {len(inputs):,} files to {output}"
        )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "inputs",
        nargs="+",
        help="A2AJ .jsonl/.parquet files or directories (repeat as needed)",
    )
    result.add_argument("--output", default=str(default_output()))
    result.add_argument(
        "--doc-type",
        choices=("auto", "cases", "laws"),
        default="auto",
        help="Override automatic cases/laws detection for all inputs",
    )
    result.add_argument(
        "--fts",
        action="store_true",
        help="Build the larger optional full-text search index",
    )
    return result


if __name__ == "__main__":
    try:
        import_database(parser().parse_args())
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
