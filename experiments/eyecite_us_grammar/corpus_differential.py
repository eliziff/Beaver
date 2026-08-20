#!/usr/bin/env python3
"""Corpus-scale exact-span differential against installed CourtListener text."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "legal-pdf-parser" / "src"))

from eyecite.models import CitationToken  # noqa: E402
from eyecite.tokenizers import NOMINATIVE_REPORTER_NAMES, default_tokenizer  # noqa: E402

from build_candidate import atomic_json  # noqa: E402
from differential import candidate_patterns, token_sources  # noqa: E402

DATABASE = Path(
    r"C:\Users\elias\AppData\Local\OpenLegalProducts\LegalData\providers"
    r"\courtlistener\courtlistener.sqlite"
)


def oracle_spans(text: str) -> set[tuple[int, int]]:
    _, indexed = default_tokenizer.tokenize(text)
    return {
        (token.start, token.end)
        for _, token in indexed
        if isinstance(token, CitationToken)
        and token_sources(token).intersection({"reporters", "journals", "laws"})
    }


def candidate_spans(patterns, text: str) -> set[tuple[int, int]]:
    raw = sorted(
        {
            (match.span(), entry_id)
            for entry_id, pattern in patterns.items()
            for match in pattern.finditer(text)
        },
        key=lambda item: (item[0][0], -item[0][1]),
    )
    resolved: list[tuple[tuple[int, int], str]] = []
    for span, entry_id in raw:
        if resolved and span[0] < resolved[-1][0][1]:
            previous_span, previous_id = resolved[-1]
            previous_text = text[previous_span[0] : previous_span[1]].lstrip()
            nominative = any(
                previous_text.startswith(name) for name in NOMINATIVE_REPORTER_NAMES
            )
            if (
                nominative
                and previous_id.startswith("cite.us.reporter.custom.")
                and entry_id in {"cite.us.reporter.full", "cite.us.reporter.short"}
            ):
                resolved[-1] = (span, entry_id)
            continue
        resolved.append((span, entry_id))
    return {span for span, _ in resolved}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    started = time.perf_counter()
    patterns = candidate_patterns()
    compiled_seconds = time.perf_counter() - started
    connection = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
    total_rows, total_chars = connection.execute(
        "SELECT count(*), coalesce(sum(length(body)), 0) FROM opinion_search"
    ).fetchone()
    limit = min(args.limit, total_rows) if args.limit else total_rows
    checkpoint = HERE / "results" / (
        f"corpus-checkpoint-{limit}.json" if args.limit else "corpus-checkpoint.json"
    )
    completed = 0
    citations = 0
    false_negatives = 0
    false_positives = 0
    examples: list[dict] = []
    oracle_seconds = 0.0
    candidate_seconds = 0.0
    cursor = connection.execute(
        "SELECT rowid, body FROM opinion_search ORDER BY rowid LIMIT ?", (limit,)
    )
    scan_started = time.perf_counter()
    for rowid, body in cursor:
        text = body or ""
        step_started = time.perf_counter()
        expected = oracle_spans(text)
        oracle_seconds += time.perf_counter() - step_started
        step_started = time.perf_counter()
        actual = candidate_spans(patterns, text)
        candidate_seconds += time.perf_counter() - step_started
        missing = expected - actual
        extra = actual - expected
        citations += len(expected)
        false_negatives += len(missing)
        false_positives += len(extra)
        if (missing or extra) and len(examples) < 100:
            examples.append({
                "rowid": rowid,
                "missing": [text[start:end] for start, end in sorted(missing)[:10]],
                "extra": [text[start:end] for start, end in sorted(extra)[:10]],
            })
        completed += 1
        if completed % 100 == 0 or completed == limit:
            elapsed = time.perf_counter() - scan_started
            receipt = {
                "completed": completed,
                "total": limit,
                "citations": citations,
                "false_negatives": false_negatives,
                "false_positives": false_positives,
                "scan_seconds": round(elapsed, 3),
                "oracle_seconds": round(oracle_seconds, 3),
                "candidate_seconds": round(candidate_seconds, 3),
                "rows_per_second": round(completed / elapsed, 3),
                "examples": examples,
            }
            atomic_json(checkpoint, receipt)
            print(
                f"corpus {completed:,}/{limit:,}; citations={citations:,}; "
                f"fn={false_negatives:,}; fp={false_positives:,}; "
                f"{completed / elapsed:.1f} rows/s",
                flush=True,
            )
    result = {
        "format": "beaver.eyecite-us-corpus-differential.v1",
        "database_rows": total_rows,
        "database_characters": total_chars,
        "checked_rows": completed,
        "compile_seconds": round(compiled_seconds, 3),
        "scan_seconds": round(time.perf_counter() - scan_started, 3),
        "oracle_seconds": round(oracle_seconds, 3),
        "candidate_seconds": round(candidate_seconds, 3),
        "citations": citations,
        "false_negatives": false_negatives,
        "false_positives": false_positives,
        "examples": examples,
    }
    output = HERE / "results" / (
        f"corpus-result-{limit}.json" if args.limit else "corpus-result.json"
    )
    atomic_json(output, result)
    print(json.dumps(result, indent=2))
    return 1 if false_negatives or false_positives else 0


if __name__ == "__main__":
    raise SystemExit(main())
