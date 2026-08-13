#!/usr/bin/env python3
"""Index court and era metadata for a stratified CourtListener opinion sample."""

from __future__ import annotations

import argparse
import bz2
import csv
import json
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

from open_legal_data_bridge import data_root


def default_cache() -> Path:
    return (data_root() / "cache" / "courtlistener").resolve()


def rows(path: Path):
    with bz2.open(path, "rt", encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle, escapechar="\\", doublequote=False)


def metadata(connection: sqlite3.Connection, key: str) -> str | None:
    result = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return result[0] if result else None


def set_metadata(connection: sqlite3.Connection, key: str, value: object) -> None:
    connection.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, str(value))
    )


def import_opinions(connection: sqlite3.Connection, parts: Path) -> None:
    for part in sorted(parts.glob("part-*.csv.bz2")):
        if connection.execute(
            "SELECT 1 FROM part WHERE name = ?", (part.name,)
        ).fetchone():
            continue
        values = [(int(row["id"]), int(row["cluster_id"]), part.name) for row in rows(part)]
        with connection:
            connection.executemany(
                "INSERT OR IGNORE INTO opinion(id, cluster_id, part) VALUES (?, ?, ?)",
                values,
            )
            connection.execute(
                "INSERT INTO part(name, rows) VALUES (?, ?)", (part.name, len(values))
            )
        print(f"  {part.name}: {len(values):,} rows", flush=True)


def import_clusters(connection: sqlite3.Connection, source: Path) -> None:
    if metadata(connection, "clusters_complete") == "true":
        return
    wanted = {
        row[0]
        for row in connection.execute(
            "SELECT DISTINCT opinion.cluster_id FROM opinion "
            "LEFT JOIN cluster ON cluster.id = opinion.cluster_id WHERE cluster.id IS NULL"
        )
    }
    started = time.monotonic()
    scanned = found = 0
    pending: list[tuple[int, int | None, str | None, str | None, str | None]] = []
    for row in rows(source):
        scanned += 1
        cluster_id = int(row["id"])
        if cluster_id in wanted:
            docket = row.get("docket_id", "").strip()
            pending.append(
                (
                    cluster_id,
                    int(docket) if docket else None,
                    row.get("date_filed") or None,
                    row.get("case_name") or None,
                    row.get("precedential_status") or None,
                )
            )
            wanted.remove(cluster_id)
            found += 1
        if len(pending) >= 1_000:
            with connection:
                connection.executemany("INSERT OR REPLACE INTO cluster VALUES (?, ?, ?, ?, ?)", pending)
            pending = []
        if scanned % 100_000 == 0:
            elapsed = max(time.monotonic() - started, 0.001)
            print(
                f"  clusters: {scanned:,} scanned, {found:,} found, "
                f"{scanned / elapsed:,.0f} rows/s",
                flush=True,
            )
    if pending:
        with connection:
            connection.executemany("INSERT OR REPLACE INTO cluster VALUES (?, ?, ?, ?, ?)", pending)
    if wanted:
        raise RuntimeError(f"Cluster dump is missing {len(wanted):,} sampled cluster IDs")
    with connection:
        set_metadata(connection, "clusters_complete", "true")


def import_dockets(connection: sqlite3.Connection, source: Path) -> None:
    if metadata(connection, "dockets_complete") == "true":
        return
    wanted = {
        row[0]
        for row in connection.execute(
            "SELECT DISTINCT cluster.docket_id FROM cluster "
            "LEFT JOIN docket ON docket.id = cluster.docket_id "
            "WHERE cluster.docket_id IS NOT NULL AND docket.id IS NULL"
        )
    }
    started = time.monotonic()
    scanned = found = 0
    pending: list[tuple[int, str]] = []
    for row in rows(source):
        scanned += 1
        docket_id = int(row["id"])
        if docket_id in wanted:
            pending.append((docket_id, row["court_id"]))
            wanted.remove(docket_id)
            found += 1
        if len(pending) >= 1_000:
            with connection:
                connection.executemany("INSERT OR REPLACE INTO docket VALUES (?, ?)", pending)
            pending = []
        if scanned % 250_000 == 0:
            elapsed = max(time.monotonic() - started, 0.001)
            print(
                f"  dockets: {scanned:,} scanned, {found:,} found, "
                f"{scanned / elapsed:,.0f} rows/s",
                flush=True,
            )
        if not wanted:
            break
    if pending:
        with connection:
            connection.executemany("INSERT OR REPLACE INTO docket VALUES (?, ?)", pending)
    if wanted:
        raise RuntimeError(f"Docket dump is missing {len(wanted):,} sampled docket IDs")
    with connection:
        set_metadata(connection, "dockets_complete", "true")


def import_courts(connection: sqlite3.Connection, source: Path) -> None:
    values = [
        (
            row["id"],
            row.get("citation_string") or None,
            row.get("short_name") or None,
            row.get("full_name") or None,
            row.get("jurisdiction") or None,
            row.get("parent_court_id") or None,
        )
        for row in rows(source)
    ]
    with connection:
        connection.executemany("INSERT OR REPLACE INTO court VALUES (?, ?, ?, ?, ?, ?)", values)
        set_metadata(connection, "courts_complete", "true")


def summary(connection: sqlite3.Connection) -> dict[str, object]:
    decades = Counter()
    for (date_filed,) in connection.execute(
        "SELECT cluster.date_filed FROM opinion JOIN cluster ON cluster.id = opinion.cluster_id"
    ):
        year = (date_filed or "")[:4]
        if year.isdigit():
            decades[str(int(year) // 10 * 10)] += 1
    top_courts = [
        {"id": row[0], "name": row[1], "opinions": row[2]}
        for row in connection.execute(
            "SELECT court.id, COALESCE(court.full_name, court.short_name, court.id), COUNT(*) "
            "FROM opinion JOIN cluster ON cluster.id = opinion.cluster_id "
            "JOIN docket ON docket.id = cluster.docket_id "
            "JOIN court ON court.id = docket.court_id "
            "GROUP BY court.id ORDER BY COUNT(*) DESC, court.id LIMIT 50"
        )
    ]
    jurisdictions = dict(
        connection.execute(
            "SELECT COALESCE(court.jurisdiction, 'unknown'), COUNT(*) "
            "FROM opinion JOIN cluster ON cluster.id = opinion.cluster_id "
            "JOIN docket ON docket.id = cluster.docket_id "
            "JOIN court ON court.id = docket.court_id GROUP BY 1 ORDER BY 1"
        )
    )
    scalar = lambda sql: connection.execute(sql).fetchone()[0]
    return {
        "opinions": scalar("SELECT COUNT(*) FROM opinion"),
        "clusters": scalar("SELECT COUNT(*) FROM cluster"),
        "dockets": scalar("SELECT COUNT(*) FROM docket"),
        "courts": scalar(
            "SELECT COUNT(DISTINCT docket.court_id) FROM cluster "
            "JOIN docket ON docket.id = cluster.docket_id"
        ),
        "date_min": scalar("SELECT MIN(date_filed) FROM cluster"),
        "date_max": scalar("SELECT MAX(date_filed) FROM cluster"),
        "decades": dict(sorted(decades.items())),
        "jurisdictions": jurisdictions,
        "top_courts": top_courts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--cache-dir", default=str(default_cache()))
    parser.add_argument("--ranges", type=int, default=256)
    parser.add_argument("--range-bytes", type=int, default=5 * 1024 * 1024)
    args = parser.parse_args()

    field_limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(field_limit)
            break
        except OverflowError:
            field_limit //= 10

    cache = Path(args.cache_dir).expanduser().resolve()
    sample = cache / f"opinions-{args.snapshot}.stratified-{args.ranges}x{args.range_bytes}"
    if not (sample / "manifest.json").is_file():
        raise FileNotFoundError(f"Incomplete opinion sample: {sample}")
    sources = {
        "clusters": cache / f"opinion-clusters-{args.snapshot}.csv.bz2",
        "dockets": cache / f"dockets-{args.snapshot}.csv.bz2",
        "courts": cache / f"courts-{args.snapshot}.csv.bz2",
    }
    for source in sources.values():
        if not source.is_file():
            raise FileNotFoundError(source)

    database_path = sample / "catalog.sqlite"
    connection = sqlite3.connect(database_path)
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS part (name TEXT PRIMARY KEY, rows INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS opinion (
            id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL, part TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS opinion_cluster_idx ON opinion(cluster_id);
        CREATE TABLE IF NOT EXISTS cluster (
            id INTEGER PRIMARY KEY, docket_id INTEGER, date_filed TEXT,
            case_name TEXT, precedential_status TEXT
        );
        CREATE TABLE IF NOT EXISTS docket (id INTEGER PRIMARY KEY, court_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS court (
            id TEXT PRIMARY KEY, citation_string TEXT, short_name TEXT,
            full_name TEXT, jurisdiction TEXT, parent_court_id TEXT
        );
        """
    )
    print("Importing sampled opinion IDs", flush=True)
    import_opinions(connection, sample / "parts")
    print("Joining full cluster metadata", flush=True)
    import_clusters(connection, sources["clusters"])
    print("Joining full docket-to-court metadata", flush=True)
    import_dockets(connection, sources["dockets"])
    print("Importing court names", flush=True)
    import_courts(connection, sources["courts"])
    result = summary(connection)
    connection.close()
    temporary = sample / "coverage.json.tmp"
    temporary.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    temporary.replace(sample / "coverage.json")
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()
