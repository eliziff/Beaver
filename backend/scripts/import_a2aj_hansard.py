#!/usr/bin/env python3
"""Import A2AJ Hansard (huggingface.co/datasets/a2aj/hansard) into local SQLite.

Two sources, same database:
  - local .jsonl/.parquet files downloaded from the HuggingFace dataset, or
  - the keyless HuggingFace datasets-server rows/filter API (default when no
    inputs are given), so a date-bounded or row-limited slice can be pulled
    without downloading the full 546 MB corpus.

Every row is one intervention (a single speech or procedural entry). The
debate-specific columns are preserved and an FTS5 index over speaker, subject,
order of business and intervention text is always built - search is the point
of this store.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from open_legal_data_bridge import data_root


DATASETS_SERVER = "https://datasets-server.huggingface.co"
HF_DATASET = "a2aj/hansard"
PAGE_SIZE = 100

SCHEMA = """
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE intervention (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL,
    date TEXT,
    jurisdiction TEXT,
    chamber TEXT,
    language TEXT,
    order_of_business TEXT,
    subject_of_business TEXT,
    speaker TEXT,
    intervention_type TEXT,
    text TEXT NOT NULL,
    upstream_license TEXT,
    source_url TEXT
);
"""

FTS = """
CREATE INDEX intervention_date_idx ON intervention(date);
CREATE INDEX intervention_source_idx ON intervention(source_id);
CREATE VIRTUAL TABLE intervention_search USING fts5(
    speaker, subject_of_business, order_of_business, text,
    content='intervention', content_rowid='id'
);
INSERT INTO intervention_search(
    rowid, speaker, subject_of_business, order_of_business, text
)
SELECT id, speaker, subject_of_business, order_of_business, text
FROM intervention;
"""

# HuggingFace column name -> intervention column. The upstream mixes casings.
FIELDS = {
    "ID": "source_id",
    "Date": "date",
    "jurisdiction": "jurisdiction",
    "chamber": "chamber",
    "language": "language",
    "OrderofBusiness": "order_of_business",
    "SubjectofBusiness": "subject_of_business",
    "PersonSpeaking": "speaker",
    "intervention_type": "intervention_type",
    "Intervention": "text",
    "upstream_license": "upstream_license",
    "source_url": "source_url",
}


def default_output() -> Path:
    configured = os.environ.get("MIKE_A2AJ_HANSARD_DB", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (data_root() / "providers" / "a2aj" / "hansard.sqlite").resolve()


def clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def mapped(row: dict[str, Any]) -> dict[str, str | None] | None:
    lowered = {key.casefold(): value for key, value in row.items()}
    record = {
        column: clean(row.get(field, lowered.get(field.casefold())))
        for field, column in FIELDS.items()
    }
    if not record["source_id"] or not record["text"]:
        return None
    return record


def local_files(values: list[str]) -> list[Path]:
    found: list[Path] = []
    for value in values:
        root = Path(value).expanduser().resolve()
        if root.is_dir():
            found.extend(
                path
                for path in sorted(root.rglob("*"))
                if path.is_file()
                and path.suffix.casefold() in {".jsonl", ".parquet"}
            )
        elif root.is_file() and root.suffix.casefold() in {".jsonl", ".parquet"}:
            found.append(root)
        else:
            raise FileNotFoundError(
                f"Expected a JSONL/Parquet file or directory: {root}"
            )
    if not found:
        raise ValueError("No .jsonl or .parquet inputs were found")
    return found


def file_rows(path: Path) -> Iterator[dict[str, Any]]:
    if path.suffix.casefold() == ".parquet":
        try:
            import pyarrow.parquet as parquet
        except ImportError as error:
            raise RuntimeError(
                "Parquet input requires pyarrow; install it with: "
                "python -m pip install pyarrow"
            ) from error
        for batch in parquet.ParquetFile(path).iter_batches(batch_size=1_000):
            yield from batch.to_pylist()
        return
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


def hf_request(endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
    url = f"{DATASETS_SERVER}{endpoint}?{urllib.parse.urlencode(params)}"
    last_error = ""
    for attempt in range(8):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                payload = json.load(response)
        except Exception as error:  # noqa: BLE001 - retried, reported below
            last_error = str(error)
        else:
            if isinstance(payload, dict) and "rows" in payload:
                return payload
            last_error = str(
                payload.get("error", payload) if isinstance(payload, dict)
                else payload
            )
            # The filter index is built lazily server-side; wait it out.
            if "loading" not in last_error:
                raise RuntimeError(f"datasets-server: {last_error}")
        time.sleep(min(2**attempt, 30))
    raise RuntimeError(f"datasets-server: {last_error}")


def hf_rows(args: argparse.Namespace) -> Iterator[dict[str, Any]]:
    conditions = []
    if args.date_from:
        conditions.append(f"\"Date\">='{args.date_from}'")
    if args.date_to:
        conditions.append(f"\"Date\"<='{args.date_to}'")
    params: dict[str, Any] = {
        "dataset": HF_DATASET,
        "config": args.config,
        "split": "train",
    }
    endpoint = "/rows"
    if conditions:
        endpoint = "/filter"
        params["where"] = " AND ".join(conditions)
    offset = 0
    total = None
    while total is None or offset < total:
        payload = hf_request(
            endpoint, {**params, "offset": offset, "length": PAGE_SIZE}
        )
        rows = payload.get("rows") or []
        if total is None:
            total = int(payload.get("num_rows_total") or 0)
            print(f"datasets-server reports {total:,} matching rows")
        if not rows:
            break
        for entry in rows:
            row = entry.get("row") if isinstance(entry, dict) else None
            if isinstance(row, dict):
                yield row
        offset += len(rows)


def wanted(record: dict[str, str | None], args: argparse.Namespace) -> bool:
    date = record["date"] or ""
    if args.date_from and date < args.date_from:
        return False
    if args.date_to and date > args.date_to:
        return False
    return True


def import_database(args: argparse.Namespace) -> None:
    inputs = local_files(args.inputs) if args.inputs else None
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".new")
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    row_count = skipped_count = 0
    seen: set[str] = set()
    batch: list[tuple[Any, ...]] = []

    def flush() -> None:
        if batch:
            connection.executemany(
                f"INSERT INTO intervention VALUES ({','.join('?' for _ in range(13))})",
                batch,
            )
            batch.clear()

    rows = (
        (row for path in inputs for row in file_rows(path))
        if inputs
        else hf_rows(args)
    )
    try:
        connection.executescript(
            "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;"
            + SCHEMA
        )
        for row in rows:
            if args.limit and row_count >= args.limit:
                break
            record = mapped(row)
            if (
                not record
                or not wanted(record, args)
                or record["source_id"] in seen
            ):
                skipped_count += 1
                continue
            seen.add(record["source_id"])
            row_count += 1
            batch.append(
                (row_count, *(record[column] for column in FIELDS.values()))
            )
            if len(batch) == 1_000:
                flush()
                if row_count % 10_000 == 0:
                    print(f"  {row_count:,} interventions...")
        flush()
        connection.executescript(FTS)
        metadata = {
            "schema_version": "1",
            "dataset": HF_DATASET,
            "config": args.config,
            "imported_at": datetime.now(timezone.utc).isoformat(),
            "source": "files" if inputs else "huggingface_datasets_server",
            "date_from": args.date_from or "",
            "date_to": args.date_to or "",
            "row_count": str(row_count),
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
            f"Imported {row_count:,} Hansard interventions "
            f"({skipped_count:,} skipped) to {output}"
        )


def valid_date(value: str) -> str:
    # argparse also runs the empty-string default through this converter.
    if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise argparse.ArgumentTypeError(f"Expected YYYY-MM-DD, got: {value}")
    return value


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "inputs",
        nargs="*",
        help="Local a2aj/hansard .jsonl/.parquet files or directories; "
        "omit to stream from the HuggingFace datasets-server API",
    )
    result.add_argument("--output", default=str(default_output()))
    result.add_argument(
        "--config",
        default="ontario",
        help="HuggingFace dataset config (default: ontario)",
    )
    result.add_argument("--date-from", type=valid_date, default="")
    result.add_argument("--date-to", type=valid_date, default="")
    result.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Stop after this many interventions (0 = no limit)",
    )
    return result


if __name__ == "__main__":
    try:
        import_database(parser().parse_args())
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
