#!/usr/bin/env python3
"""Exact-span differential for the pinned eyecite US grammar snapshot."""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "legal-pdf-parser" / "src"))

from legalpdf import grammar_tables  # noqa: E402
from legalpdf.deterministic_citations import split_footnote_recall_first  # noqa: E402

from build_candidate import (  # noqa: E402
    ENTRY_IDS,
    atomic_json,
    sources_for,
    standard_template,
)


def candidate_patterns() -> dict[str, re.Pattern[str]]:
    corpus = json.loads(
        (HERE / "results" / "candidate-corpus.json").read_text(encoding="utf-8")
    )
    table = corpus["tables"]["citations"]
    entries = {item["id"]: item for item in table["entries"]}
    return {
        entry_id: grammar_tables.compile_entry(entries[entry_id], table["defs"])
        for entry_id in ENTRY_IDS
    }


def oracle_tokens(text: str):
    from eyecite.models import CitationToken
    from eyecite.tokenizers import default_tokenizer

    _, indexed = default_tokenizer.tokenize(text)
    return [token for _, token in indexed if isinstance(token, CitationToken)]


def token_sources(token) -> set[str]:
    return {
        edition.reporter.source
        for edition in (*token.exact_editions, *token.variation_editions)
    }


def check_witness(
    *,
    value: str,
    entry_id: str,
    source: str,
    short: bool,
    extractor,
    patterns: dict[str, re.Pattern[str]],
) -> str | None:
    context = f"See {value}, now."
    expected_span = (4, 4 + len(value))
    candidate = patterns[entry_id].search(context)
    if candidate is None or candidate.span() != expected_span:
        return f"candidate {entry_id} missed exact span for {value!r}"
    expected_anchors = {
        # Four catalogue strings are authored in both reporters and journals;
        # the product's deterministic precedence classifies them as journals.
        "reporters": {"reporter", "journal", "neutral"},
        "journals": {"journal"},
    }[source]
    production_anchors = {
        anchor
        for part in split_footnote_recall_first(context).parts
        for anchor in part.anchors
    }
    if expected_anchors.isdisjoint(production_anchors):
        return f"production splitter missed {sorted(expected_anchors)} anchor for {value!r}"
    oracle_match = extractor.compiled_regex.search(context)
    if oracle_match is None:
        return f"eyecite extractor missed its authored {source} witness {value!r}"
    oracle = extractor.get_token(oracle_match)
    if (oracle.start, oracle.end) != expected_span:
        return (
            f"eyecite extractor span for {source} {value!r}: "
            f"{(oracle.start, oracle.end)} != {expected_span}"
        )
    bounded = (("X" + value, (1, 1 + len(value))), (value + "X", (0, len(value))))
    for text, forbidden_span in bounded:
        if any(match.span() == forbidden_span for match in patterns[entry_id].finditer(text)):
            return f"candidate {entry_id} crossed alphanumeric boundary: {text!r}"
    return None


def collect_examples(value: object) -> list[str]:
    if isinstance(value, list):
        return [item for child in value for item in collect_examples(child)]
    if not isinstance(value, dict):
        return []
    found = [
        item
        for item in value.get("examples", [])
        if isinstance(item, str)
    ]
    return [
        *found,
        *(
            item
            for key, child in value.items()
            if key != "examples"
            for item in collect_examples(child)
        ),
    ]


def example_spans(
    value: str,
    source: str,
    patterns: dict[str, re.Pattern[str]],
) -> tuple[set[tuple[int, int]], set[tuple[int, int]]]:
    singular = {"reporters": "reporter", "journals": "journal", "laws": "law"}[source]
    expected = {
        (token.start, token.end)
        for token in oracle_tokens(value)
        if source in token_sources(token)
    }
    raw = sorted({
        match.span()
        for entry_id, pattern in patterns.items()
        if entry_id.startswith(f"cite.us.{singular}.")
        for match in pattern.finditer(value)
    }, key=lambda span: (span[0], -span[1]))
    actual: set[tuple[int, int]] = set()
    offset = 0
    for span in raw:
        if span[0] >= offset:
            actual.add(span)
            offset = span[1]
    return expected, actual


def extractor_witness(extractor, examples: list[str], full_by_short: dict[str, object]):
    for value in examples:
        match = extractor.compiled_regex.search(value)
        if match:
            token = extractor.get_token(match)
            return value, (token.start, token.end)
    if not extractor.extra.get("short"):
        return None
    full = full_by_short.get(extractor.regex)
    if full is None:
        return None
    for value in examples:
        match = full.compiled_regex.search(value)
        if match and match.groupdict().get("page"):
            page_start = match.start("page")
            short_value = value[:page_start] + "at " + value[page_start:]
            short_match = extractor.compiled_regex.search(short_value)
            if short_match:
                token = extractor.get_token(short_match)
                return short_value, (token.start, token.end)
    return None


def main() -> int:
    from eyecite.models import CitationToken
    from eyecite.tokenizers import EXTRACTORS
    from reporters_db import JOURNALS, LAWS, REPORTERS

    started = time.perf_counter()
    patterns = candidate_patterns()
    compiled_seconds = time.perf_counter() - started
    citation_extractors = [
        item for item in EXTRACTORS if item.constructor == CitationToken.from_match
    ]
    page = (
        r"(?:\d+|c?(?:xc|xl|l?x{1,3})(?:ix|iv|v?i{0,3})|"
        r"(?:c?l?)(?:ix|iv|v?i{1,3})|(?:lv|cv|cl|clv)|_+)"
    )
    standard = {
        (source, short): [
            item
            for item in citation_extractors
            if source in sources_for(item)
            and bool(item.extra.get("short")) == short
            and standard_template(item, page)
        ]
        for source in ("reporters", "journals")
        for short in (False, True)
    }
    witnesses = {
        key: {
            value: item
            for item in items
            for value in item.strings
        }
        for key, items in standard.items()
    }
    source_data = {"reporters": REPORTERS, "journals": JOURNALS, "laws": LAWS}
    examples = {
        source: sorted(set(collect_examples(data)))
        for source, data in source_data.items()
    }
    jobs = [
        *(
            (f"123 {value} 456", "cite.us.reporter.full", "reporters", False, item)
            for value, item in sorted(witnesses[("reporters", False)].items())
        ),
        *(
            (f"123 {value} at 456", "cite.us.reporter.short", "reporters", True, item)
            for value, item in sorted(witnesses[("reporters", True)].items())
        ),
        *(
            (f"123 {value} 456", "cite.us.journal.full", "journals", False, item)
            for value, item in sorted(witnesses[("journals", False)].items())
        ),
        *(
            (f"123 {value} at 456", "cite.us.journal.short", "journals", True, item)
            for value, item in sorted(witnesses[("journals", True)].items())
        ),
    ]
    failures: list[str] = []
    checkpoint = HERE / "results" / "catalog-checkpoint.json"
    for index, (value, entry_id, source, short, extractor) in enumerate(jobs, 1):
        failure = check_witness(
            value=value,
            entry_id=entry_id,
            source=source,
            short=short,
            extractor=extractor,
            patterns=patterns,
        )
        if failure and len(failures) < 100:
            failures.append(failure)
        if index % 500 == 0 or index == len(jobs):
            elapsed = time.perf_counter() - started
            atomic_json(
                checkpoint,
                {
                    "completed": index,
                    "total": len(jobs),
                    "failures": failures,
                    "elapsed_seconds": round(elapsed, 3),
                },
            )
            print(
                f"catalog {index:,}/{len(jobs):,}; failures={len(failures)}; "
                f"elapsed={elapsed:.1f}s",
                flush=True,
            )

    example_mismatches = 0
    for source, values in examples.items():
        for value in values:
            expected, actual = example_spans(value, source, patterns)
            if expected != actual:
                example_mismatches += 1
                if len(failures) < 100:
                    failures.append(
                        f"{source} example {value!r}: eyecite={sorted(expected)}, "
                        f"candidate={sorted(actual)}"
                    )

    custom_extractors = [
        item
        for item in citation_extractors
        if len(sources_for(item)) == 1
        and next(iter(sources_for(item))) in source_data
        and (
            next(iter(sources_for(item))) == "laws"
            or not standard_template(item, page)
        )
    ]
    from eyecite.regexes import short_cite_re

    full_by_short = {
        short_cite_re(item.regex): item
        for item in custom_extractors
        if not item.extra.get("short")
    }
    custom_checks = 0
    custom_overlap_resolutions: list[str] = []
    unwitnessed: list[str] = []
    for item in custom_extractors:
        source = next(iter(sources_for(item)))
        witness = extractor_witness(item, examples[source], full_by_short)
        if witness is None:
            unwitnessed.append(item.regex)
            continue
        value, expected_span = witness
        singular = {"reporters": "reporter", "journals": "journal", "laws": "law"}[source]
        suffix = "short" if item.extra.get("short") else "full"
        entry_id = (
            f"cite.us.reporter.custom.{suffix}"
            if source == "reporters"
            else f"cite.us.{singular}.{suffix}"
        )
        actual_spans = {match.span() for match in patterns[entry_id].finditer(value)}
        custom_checks += 1
        expected_anchors = {
            "reporters": {"reporter", "neutral"},
            "journals": {"journal"},
            "laws": {"statute"},
        }[source]
        production_anchors = {
            anchor
            for part in split_footnote_recall_first(value).parts
            for anchor in part.anchors
        }
        if expected_anchors.isdisjoint(production_anchors) and len(failures) < 100:
            failures.append(
                f"production splitter missed {sorted(expected_anchors)} anchor for {value!r}"
            )
        if expected_span not in actual_spans and len(custom_overlap_resolutions) < 100:
            custom_overlap_resolutions.append(
                f"{entry_id} missed custom exact span {expected_span} in {value!r}: "
                f"{sorted(actual_spans)}"
            )

    result = {
        "format": "beaver.eyecite-us-catalog-differential.v1",
        "compile_seconds": round(compiled_seconds, 3),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "standard_surfaces": {
            f"{source}_{'short' if short else 'full'}": len(values)
            for (source, short), values in witnesses.items()
        },
        "source_examples": {source: len(values) for source, values in examples.items()},
        "example_mismatches": example_mismatches,
        "custom_extractors": len(custom_extractors),
        "custom_exact_span_checks": custom_checks,
        "custom_overlap_resolutions": len(custom_overlap_resolutions),
        "custom_overlap_examples": custom_overlap_resolutions,
        "unwitnessed_custom_extractors": len(unwitnessed),
        "checks": len(jobs),
        "failures": failures,
    }
    atomic_json(HERE / "results" / "catalog-result.json", result)
    print(json.dumps(result, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
