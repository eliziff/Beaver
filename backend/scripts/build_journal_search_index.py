"""Atomically build the optional public_endpoint.db FTS5 search sidecar."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from open_legal_data_bridge import data_root


def default_source() -> Path:
    configured = (
        os.environ.get("MIKE_PUBLIC_ENDPOINT_DB", "").strip()
        or os.environ.get("ALR_PUBLIC_ENDPOINT_DB", "").strip()
    )
    return (
        Path(configured).expanduser()
        if configured
        else data_root() / "providers" / "journals" / "public_endpoint.db"
    )


def default_output() -> Path:
    configured = os.environ.get("MIKE_PUBLIC_ENDPOINT_FTS_DB", "").strip()
    return (
        Path(configured).expanduser()
        if configured
        else data_root() / "providers" / "journals" / "public_endpoint-search.sqlite"
    )


def build(source: Path, output: Path) -> dict[str, object]:
    source = source.resolve()
    output = output.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"public_endpoint.db not found: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    temporary.unlink(missing_ok=True)
    started = time.perf_counter()
    count = 0
    try:
        with closing(
            sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)
        ) as origin:
            with closing(sqlite3.connect(temporary)) as target:
                target.executescript(
                    """
                    PRAGMA journal_mode=OFF;
                    PRAGMA synchronous=OFF;
                    PRAGMA temp_store=MEMORY;
                    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE VIRTUAL TABLE article_search USING fts5(
                        metadata,
                        body,
                        content=''
                    );
                    """
                )
                rows = origin.execute(
                    """
                    SELECT article_id, name_en, citation_en, authors,
                           journal_name, journal_abbrev, text
                    FROM articles
                    WHERE text IS NOT NULL AND length(text) > 0
                    """
                )

                def values():
                    nonlocal count
                    for row in rows:
                        count += 1
                        yield (
                            int(row[0]),
                            " ".join(str(value or "") for value in row[1:6]),
                            row[6],
                        )

                target.executemany(
                    "INSERT INTO article_search(rowid, metadata, body) VALUES (?, ?, ?)",
                    values(),
                )
                target.execute("INSERT INTO article_search(article_search) VALUES ('optimize')")
                stat = source.stat()
                source_metadata = dict(
                    origin.execute(
                        "SELECT key, value FROM export_metadata"
                    ).fetchall()
                )
                target.executemany(
                    "INSERT INTO meta(key, value) VALUES (?, ?)",
                    [
                        ("schema_version", "2"),
                        ("source_size", str(stat.st_size)),
                        ("source_mtime_ms", str(stat.st_mtime_ns // 1_000_000)),
                        ("source_path", str(source)),
                        (
                            "source_schema_version",
                            source_metadata.get("schema_version", ""),
                        ),
                        ("source_created_at", source_metadata.get("created_at", "")),
                        ("article_count", str(count)),
                    ],
                )
                target.commit()
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "source": str(source),
        "output": str(output),
        "articleCount": count,
        "sizeBytes": output.stat().st_size,
        "elapsedSeconds": round(time.perf_counter() - started, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=default_source())
    parser.add_argument("--output", type=Path, default=default_output())
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
