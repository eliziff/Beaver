#!/usr/bin/env python3
"""Check every installed CourtListener citation row by grouped reporter shape."""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "legal-pdf-parser" / "src"))

from build_candidate import atomic_json  # noqa: E402
from corpus_differential import (  # noqa: E402
    DATABASE,
    candidate_spans,
    oracle_spans,
)
from differential import candidate_patterns  # noqa: E402


def main() -> int:
    started = time.perf_counter()
    patterns = candidate_patterns()
    connection = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
    progress_calls = 0

    def progress() -> int:
        nonlocal progress_calls
        progress_calls += 1
        if progress_calls % 500 == 0:
            print(f"provider SQL scan: {progress_calls * 100_000:,} VM operations", flush=True)
        return 0

    connection.set_progress_handler(progress, 100_000)
    groups = connection.execute(
        "SELECT reporter, count(*), min(volume), min(page) "
        "FROM citation GROUP BY reporter ORDER BY reporter"
    ).fetchall()
    print(f"provider SQL grouped {len(groups):,} reporter surfaces", flush=True)
    checked_rows = 0
    oracle_rows = 0
    unsupported_rows = 0
    mismatch_rows = 0
    examples: list[dict] = []
    checkpoint = HERE / "results" / "provider-checkpoint.json"
    for index, (reporter, count, volume, page) in enumerate(groups, 1):
        value = f"{volume} {reporter} {page}"
        expected = oracle_spans(value)
        actual = candidate_spans(patterns, value)
        checked_rows += count
        if expected:
            oracle_rows += count
        else:
            unsupported_rows += count
        if expected != actual:
            mismatch_rows += count
            if len(examples) < 100:
                examples.append({
                    "reporter": reporter,
                    "rows": count,
                    "value": value,
                    "eyecite": sorted(expected),
                    "candidate": sorted(actual),
                })
        if index % 100 == 0 or index == len(groups):
            receipt = {
                "completed_reporters": index,
                "total_reporters": len(groups),
                "checked_rows": checked_rows,
                "oracle_rows": oracle_rows,
                "unsupported_rows": unsupported_rows,
                "mismatch_rows": mismatch_rows,
                "examples": examples,
            }
            atomic_json(checkpoint, receipt)
            print(
                f"provider {index:,}/{len(groups):,}; rows={checked_rows:,}; "
                f"oracle={oracle_rows:,}; mismatches={mismatch_rows:,}",
                flush=True,
            )
    result = {
        "format": "beaver.eyecite-us-provider-differential.v1",
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "reporter_surfaces": len(groups),
        "checked_rows": checked_rows,
        "oracle_rows": oracle_rows,
        "unsupported_rows": unsupported_rows,
        "mismatch_rows": mismatch_rows,
        "examples": examples,
    }
    atomic_json(HERE / "results" / "provider-result.json", result)
    print(json.dumps(result, indent=2))
    return 1 if mismatch_rows else 0


if __name__ == "__main__":
    raise SystemExit(main())
