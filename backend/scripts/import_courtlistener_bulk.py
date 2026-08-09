#!/usr/bin/env python3
"""Stream CourtListener's official bulk CSVs into one local SQLite database."""

from __future__ import annotations

import argparse
import bz2
import csv
import os
import re
import sqlite3
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

from open_legal_data_bridge import data_root


SCHEMA = """
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE citation (
    id INTEGER PRIMARY KEY,
    volume TEXT NOT NULL,
    reporter TEXT NOT NULL,
    reporter_key TEXT NOT NULL,
    page TEXT NOT NULL,
    type INTEGER,
    cluster_id INTEGER NOT NULL
);
CREATE TABLE cluster (
    id INTEGER PRIMARY KEY,
    case_name TEXT,
    case_name_short TEXT,
    case_name_full TEXT,
    slug TEXT,
    date_filed TEXT,
    filepath_pdf_harvard TEXT
);
CREATE TABLE opinion (
    id INTEGER PRIMARY KEY,
    cluster_id INTEGER NOT NULL,
    type TEXT,
    author_str TEXT,
    per_curiam TEXT,
    joined_by_str TEXT,
    page_count INTEGER,
    download_url TEXT,
    local_path TEXT,
    plain_text TEXT,
    html TEXT,
    html_lawbox TEXT,
    html_columbia TEXT,
    html_anon_2020 TEXT,
    xml_harvard TEXT,
    xml_scan TEXT,
    html_with_citations TEXT
);
"""


def default_output() -> Path:
    configured = os.environ.get("MIKE_COURTLISTENER_BULK_DB", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (
        data_root() / "providers" / "courtlistener" / "courtlistener.sqlite"
    ).resolve()


@contextmanager
def open_csv(path: Path) -> Iterator[Iterable[str]]:
    if path.name.lower().endswith(".csv.bz2"):
        handle = bz2.open(path, "rt", encoding="utf-8-sig", newline="")
    elif path.suffix.lower() == ".csv":
        handle = path.open(encoding="utf-8-sig", newline="")
    else:
        raise ValueError(f"Expected .csv or .csv.bz2: {path}")
    try:
        yield handle
    finally:
        handle.close()


def rows(path: Path, required: set[str]) -> Iterator[dict[str, str]]:
    with open_csv(path) as handle:
        reader = csv.DictReader(handle, escapechar="\\", doublequote=False)
        missing = required - set(reader.fieldnames or ())
        if missing:
            raise ValueError(f"{path.name} is missing columns: {', '.join(sorted(missing))}")
        yield from reader


def integer(value: str | None) -> int | None:
    value = (value or "").strip()
    return int(value) if value else None


def required_integer(value: str | None, field: str) -> int:
    parsed = integer(value)
    if parsed is None or parsed <= 0:
        raise ValueError(f"{field} must be a positive integer, got {value!r}")
    return parsed


def reporter_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def batched(values: Iterable[tuple], size: int = 1_000) -> Iterator[list[tuple]]:
    batch: list[tuple] = []
    for value in values:
        batch.append(value)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def insert_batches(
    connection: sqlite3.Connection, sql: str, values: Iterable[tuple]
) -> int:
    count = 0
    for batch in batched(values):
        connection.executemany(sql, batch)
        count += len(batch)
    return count


def import_database(args: argparse.Namespace) -> None:
    output = Path(args.output).expanduser().resolve()
    inputs = {
        "citations": Path(args.citations).expanduser().resolve(),
        "clusters": Path(args.clusters).expanduser().resolve(),
        "opinions": Path(args.opinions).expanduser().resolve(),
    }
    for path in inputs.values():
        if not path.is_file():
            raise FileNotFoundError(path)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".new")
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(
            "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;"
            + SCHEMA
        )
        counts: dict[str, int] = {}
        counts["clusters"] = insert_batches(
            connection,
            "INSERT INTO cluster VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                (
                    required_integer(row["id"], "cluster.id"),
                    row.get("case_name") or None,
                    row.get("case_name_short") or None,
                    row.get("case_name_full") or None,
                    row.get("slug") or None,
                    row.get("date_filed") or None,
                    row.get("filepath_pdf_harvard") or None,
                )
                for row in rows(
                    inputs["clusters"],
                    {"id", "case_name", "case_name_short", "case_name_full", "slug"},
                )
            ),
        )
        counts["citations"] = insert_batches(
            connection,
            "INSERT INTO citation VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                (
                    required_integer(row["id"], "citation.id"),
                    row["volume"],
                    row["reporter"],
                    reporter_key(row["reporter"]),
                    row["page"],
                    integer(row.get("type")),
                    required_integer(row["cluster_id"], "citation.cluster_id"),
                )
                for row in rows(
                    inputs["citations"],
                    {"id", "volume", "reporter", "page", "cluster_id"},
                )
            ),
        )
        opinion_fields = (
            "id",
            "cluster_id",
            "type",
            "author_str",
            "per_curiam",
            "joined_by_str",
            "page_count",
            "download_url",
            "local_path",
            "plain_text",
            "html",
            "html_lawbox",
            "html_columbia",
            "html_anon_2020",
            "xml_harvard",
            "xml_scan",
            "html_with_citations",
        )
        counts["opinions"] = insert_batches(
            connection,
            f"INSERT INTO opinion VALUES ({','.join('?' for _ in opinion_fields)})",
            (
                tuple(
                    integer(row.get(field))
                    if field == "page_count"
                    else required_integer(row.get(field), f"opinion.{field}")
                    if field in {"id", "cluster_id"}
                    else row.get(field) or None
                    for field in opinion_fields
                )
                for row in rows(inputs["opinions"], {"id", "cluster_id"})
            ),
        )
        connection.executescript(
            """
            CREATE INDEX citation_lookup_idx
                ON citation(volume, reporter_key, page);
            CREATE INDEX citation_cluster_idx ON citation(cluster_id);
            CREATE INDEX opinion_cluster_idx ON opinion(cluster_id);
            CREATE VIRTUAL TABLE cluster_search USING fts5(
                case_name, case_name_short, case_name_full,
                content='cluster', content_rowid='id'
            );
            INSERT INTO cluster_search(rowid, case_name, case_name_short, case_name_full)
                SELECT id, case_name, case_name_short, case_name_full FROM cluster;
            INSERT INTO cluster_search(cluster_search) VALUES('optimize');
            """
        )
        if args.opinion_fts:
            connection.executescript(
                """
                CREATE VIRTUAL TABLE opinion_search USING fts5(
                    cluster_id UNINDEXED, body
                );
                INSERT INTO opinion_search(cluster_id, body)
                    SELECT cluster_id, COALESCE(
                        NULLIF(plain_text, ''),
                        NULLIF(html_with_citations, ''),
                        NULLIF(xml_harvard, ''),
                        NULLIF(html, ''),
                        NULLIF(html_lawbox, ''),
                        NULLIF(html_columbia, ''),
                        NULLIF(html_anon_2020, ''),
                        NULLIF(xml_scan, ''),
                        ''
                    )
                    FROM opinion;
                INSERT INTO opinion_search(opinion_search) VALUES('optimize');
                """
            )
        metadata = {
            "schema_version": "1",
            "imported_at": datetime.now(timezone.utc).isoformat(),
            "opinion_fts": "true" if args.opinion_fts else "false",
            **{f"{name}_file": path.name for name, path in inputs.items()},
            **{f"{name}_count": str(count) for name, count in counts.items()},
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
            f"Imported {counts['citations']:,} citations, {counts['clusters']:,} "
            f"clusters, and {counts['opinions']:,} opinions to {output}"
        )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--citations", required=True, help="Official citations CSV/BZ2")
    result.add_argument(
        "--clusters", required=True, help="Official opinion-clusters CSV/BZ2"
    )
    result.add_argument("--opinions", required=True, help="Official opinions CSV/BZ2")
    result.add_argument("--output", default=str(default_output()))
    result.add_argument(
        "--opinion-fts",
        action="store_true",
        help="Build a much larger full-opinion search index for offline search",
    )
    return result


if __name__ == "__main__":
    field_limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(field_limit)
            break
        except OverflowError:
            field_limit //= 10
    import_database(parser().parse_args())
