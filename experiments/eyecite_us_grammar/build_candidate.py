#!/usr/bin/env python3
"""Build a compact Beaver corpus candidate from the pinned eyecite oracle."""

from __future__ import annotations

import copy
import hashlib
import importlib.metadata
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "legal-pdf-parser" / "src"))

from legalpdf import grammar_tables  # noqa: E402

from inventory import (  # noqa: E402
    EYECITE_COMMIT,
    EYECITE_VERSION,
    LICENSE,
    REPORTERS_DB_COMMIT,
    REPORTERS_DB_VERSION,
)

ENTRY_IDS = (
    "cite.us.reporter.full",
    "cite.us.reporter.short",
    "cite.us.reporter.custom.full",
    "cite.us.reporter.custom.short",
    "cite.us.journal.full",
    "cite.us.journal.short",
    "cite.us.law.full",
    "cite.us.law.short",
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(
        (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    temporary.replace(path)


def sources_for(extractor) -> set[str]:
    editions = (
        *extractor.extra.get("exact_editions", ()),
        *extractor.extra.get("variation_editions", ()),
    )
    return {edition.reporter.source for edition in editions}


def noncapturing(source: str) -> str:
    """Erase captures without changing their matching semantics."""
    output: list[str] = []
    index = 0
    in_class = False
    while index < len(source):
        character = source[index]
        if character == "\\" and index + 1 < len(source):
            output.append(source[index : index + 2])
            index += 2
            continue
        if character == "[" and not in_class:
            in_class = True
        elif character == "]" and in_class:
            in_class = False
        if character == "(" and not in_class:
            if source.startswith("(?P<", index):
                end = source.find(">", index + 4)
                if end < 0:
                    raise ValueError("unterminated Python named group")
                output.append("(?:")
                index = end + 1
                continue
            if not source.startswith("(?", index):
                output.append("(?:")
                index += 1
                continue
        output.append(character)
        index += 1
    portable = "".join(output).replace(r"\ ", " ")
    return re.sub(r"\{,(\d+)\}", r"{0,\1}", portable)


def inner_pattern(source: str) -> str:
    # Every reporters-db extractor uses nonalphanumeric_boundaries_re, which
    # contributes one outer capture. Strip it so Beaver owns the exact span.
    prefix = r"(?:^|[^a-zA-Z0-9])("
    suffix = r")(?:[^a-zA-Z0-9]|$)"
    if not source.startswith(prefix) or not source.endswith(suffix):
        raise ValueError(f"unexpected eyecite extractor wrapper: {source}")
    return noncapturing(source[len(prefix) : -len(suffix)])


def raw_inner_pattern(source: str) -> str:
    prefix = r"(?:^|[^a-zA-Z0-9])("
    suffix = r")(?:[^a-zA-Z0-9]|$)"
    if not source.startswith(prefix) or not source.endswith(suffix):
        raise ValueError(f"unexpected eyecite extractor wrapper: {source}")
    return source[len(prefix) : -len(suffix)]


def split_alternation(source: str) -> set[str]:
    values: list[str] = []
    start = 0
    escaped = False
    for index, character in enumerate(source):
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
        elif character == "|":
            values.append(source[start:index])
            start = index + 1
    values.append(source[start:])
    return set(values)


def alternation(values: set[str]) -> str:
    # eyecite 2.7.8 deliberately permits spacing after periods and between
    # reporter tokens. Use its authoring transform, then freeze only strings.
    from eyecite.tokenizers import _relax_ws

    patterns = {_relax_ws(re.escape(value)).replace(r"\ ", " ") for value in values}
    return "(?:" + "|".join(sorted(patterns, key=lambda value: (-len(value), value))) + ")"


def pattern_alternation(
    values: set[str],
    priorities: dict[str, tuple[int, int]] | None = None,
    precedence: set[tuple[str, str]] | None = None,
) -> str:
    weights = priorities or {}
    base_key = lambda value: (
            -weights.get(value, (0, 0))[0],
            -weights.get(value, (0, 0))[1],
            len(value),
            value,
        )
    remaining = set(values)
    incoming = {value: set() for value in values}
    for before, after in precedence or set():
        if before in remaining and after in remaining and before != after:
            incoming[after].add(before)
    ordered: list[str] = []
    while remaining:
        available = [value for value in remaining if not (incoming[value] & remaining)]
        if not available:
            raise ValueError("eyecite example precedence contains a cycle")
        chosen = min(available, key=base_key)
        ordered.append(chosen)
        remaining.remove(chosen)
    return "(?:" + "|".join(ordered) + ")" if ordered else r"(?!)"


def collect_examples(value: object) -> list[str]:
    if isinstance(value, list):
        return [item for child in value for item in collect_examples(child)]
    if not isinstance(value, dict):
        return []
    found = [item for item in value.get("examples", []) if isinstance(item, str)]
    return [
        *found,
        *(
            item
            for key, child in value.items()
            if key != "examples"
            for item in collect_examples(child)
        ),
    ]


def standard_template(extractor, page: str) -> bool:
    from eyecite.tokenizers import _relax_ws

    source = raw_inner_pattern(extractor.regex)
    prefix = r"(?P<volume>[1-9]\d*) (?P<reporter>"
    if extractor.extra.get("short"):
        suffix = rf"),? at\s?(p(\.|age)?)? (?P<page>{page})"
    else:
        suffix = rf"),? (?P<page>{page})"
    if not extractor.strings or not source.startswith(prefix) or not source.endswith(suffix):
        return False
    reporter = source[len(prefix) : -len(suffix)]
    expected = {_relax_ws(re.escape(value)) for value in extractor.strings}
    return split_alternation(reporter) == expected


def entry(
    entry_id: str,
    pattern: str,
    provenance: str,
    positives: list[str],
    negative: str,
) -> dict:
    return {
        "id": entry_id,
        "pattern": pattern,
        "flags": "",
        "canonical": {},
        "provenance": provenance,
        "vectors": [
            *({"input": value, "groups": {}} for value in positives),
            {"input": negative, "groups": None},
        ],
    }


def main() -> None:
    if importlib.metadata.version("eyecite") != EYECITE_VERSION:
        raise RuntimeError(f"eyecite {EYECITE_VERSION} is required")
    if importlib.metadata.version("reporters-db") != REPORTERS_DB_VERSION:
        raise RuntimeError(f"reporters-db {REPORTERS_DB_VERSION} is required")

    from eyecite.models import CitationToken
    from eyecite.tokenizers import EXTRACTORS
    from reporters_db import JOURNALS, LAWS, REPORTERS

    citations = [
        extractor
        for extractor in EXTRACTORS
        if extractor.constructor == CitationToken.from_match
    ]
    known_sources = {"reporters", "journals", "laws"}
    unknown = [
        (sorted(sources_for(item)), item.strings)
        for item in citations
        if not sources_for(item) or not sources_for(item).issubset(known_sources)
    ]
    if unknown:
        raise ValueError(
            f"{len(unknown)} extractors have unknown source families: {unknown}"
        )
    by_source = {
        source: [item for item in citations if source in sources_for(item)]
        for source in sorted(known_sources)
    }

    page = (
        r"(?:\d+|c?(?:xc|xl|l?x{1,3})(?:ix|iv|v?i{0,3})|"
        r"(?:c?l?)(?:ix|iv|v?i{1,3})|(?:lv|cv|cl|clv)|_+)"
    )
    standard = {
        (source, short): [
            item
            for item in by_source[source]
            if bool(item.extra.get("short")) == short and standard_template(item, page)
        ]
        for source in ("reporters", "journals")
        for short in (False, True)
    }
    custom = {
        (source, short): {
            inner_pattern(item.regex)
            for item in by_source[source]
            if bool(item.extra.get("short")) == short and not standard_template(item, page)
        }
        for source in ("reporters", "journals", "laws")
        for short in (False, True)
    }
    surfaces = {
        key: {surface for item in items for surface in item.strings}
        for key, items in standard.items()
    }
    portable_patterns = {
        pattern for patterns in custom.values() for pattern in patterns
    }
    if any(grammar_tables.validate_pattern(value) for value in portable_patterns):
        raise ValueError("an eyecite custom pattern is not portable")
    for source in ("reporters", "journals"):
        if surfaces[(source, False)] != surfaces[(source, True)]:
            raise ValueError(f"{source} full/short standard catalogues diverged")
    source_data = {"reporters": REPORTERS, "journals": JOURNALS, "laws": LAWS}
    source_examples = {
        source: sorted(set(collect_examples(data)))
        for source, data in source_data.items()
    }
    from eyecite.tokenizers import default_tokenizer

    expected_spans: dict[tuple[str, str], set[tuple[int, int]]] = {}
    for source, examples in source_examples.items():
        for example in examples:
            _, indexed = default_tokenizer.tokenize(example)
            expected_spans[(source, example)] = {
                (token.start, token.end)
                for _, token in indexed
                if isinstance(token, CitationToken)
                and source
                in {
                    edition.reporter.source
                    for edition in (*token.exact_editions, *token.variation_editions)
                }
            }
    priorities: dict[tuple[str, bool], dict[str, tuple[int, int]]] = {
        key: {} for key in custom
    }
    precedence: dict[tuple[str, bool], set[tuple[str, str]]] = {
        key: set() for key in custom
    }
    full_priorities_by_regex: dict[str, tuple[int, int]] = {}
    for source in source_data:
        for item in by_source[source]:
            if item.extra.get("short") or (
                source != "laws" and standard_template(item, page)
            ):
                continue
            pattern = inner_pattern(item.regex)
            matches = [
                (example, item.get_token(match))
                for example in source_examples[source]
                if (match := item.compiled_regex.search(example))
            ]
            priority = (
                sum(
                    (token.start, token.end) in expected_spans[(source, example)]
                    for example, token in matches
                ),
                max((token.end - token.start for _, token in matches), default=0),
            )
            priorities[(source, False)][pattern] = max(
                priority,
                priorities[(source, False)].get(pattern, (0, 0)),
            )
            full_priorities_by_regex[item.regex] = priority
    from eyecite.regexes import short_cite_re

    for source in source_data:
        for item in by_source[source]:
            if not item.extra.get("short") or (
                source != "laws" and standard_template(item, page)
            ):
                continue
            pattern = inner_pattern(item.regex)
            priority = max(
                (
                    value
                    for regex, value in full_priorities_by_regex.items()
                    if short_cite_re(regex) == item.regex
                ),
                default=(0, 0),
            )
            priorities[(source, True)][pattern] = max(
                priority,
                priorities[(source, True)].get(pattern, (0, 0)),
            )
    for source in source_data:
        full_items = [
            item
            for item in by_source[source]
            if not item.extra.get("short")
            and (source == "laws" or not standard_template(item, page))
        ]
        for example in source_examples[source]:
            matches = []
            for item in full_items:
                match = item.compiled_regex.search(example)
                if match:
                    matches.append((inner_pattern(item.regex), item.get_token(match)))
            winners = [
                (pattern, token)
                for pattern, token in matches
                if (token.start, token.end) in expected_spans[(source, example)]
            ]
            for winner, winner_token in winners:
                for loser, loser_token in matches:
                    if winner_token.start == loser_token.start and winner_token.end != loser_token.end:
                        precedence[(source, False)].add((winner, loser))
        short_by_full: dict[str, str] = {}
        for full in full_items:
            short_regex = short_cite_re(full.regex)
            short = next(
                (item for item in by_source[source] if item.regex == short_regex and item.extra.get("short")),
                None,
            )
            if short is not None:
                short_by_full[inner_pattern(full.regex)] = inner_pattern(short.regex)
        precedence[(source, True)] = {
            (short_by_full[before], short_by_full[after])
            for before, after in precedence[(source, False)]
            if before in short_by_full and after in short_by_full
        }

    corpus_path = REPO / "legal-structure" / "data" / "grammar-corpus.json"
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    candidate = copy.deepcopy(corpus)
    citations_table = candidate["tables"]["citations"]
    us_description = (
        " U.S. reporter, journal, law, regulation, constitution, docket, and "
        "short-cite families are a runtime-free authored snapshot of the pinned "
        "eyecite/reporters-db oracle; standard and custom reporter entries stay "
        "separate so overlap resolution cannot hide a valid span."
    )
    if us_description not in citations_table["description"]:
        citations_table["description"] += us_description
    existing_ids = {item["id"] for item in citations_table["entries"]}
    overlap = existing_ids.intersection(ENTRY_IDS)
    if overlap:
        citations_table["entries"] = [
            item for item in citations_table["entries"] if item["id"] not in overlap
        ]

    defs = citations_table["defs"]
    defs.update({
        "us_reporters": alternation(surfaces[("reporters", False)]),
        "us_journals": alternation(surfaces[("journals", False)]),
        "us_reporter_custom_full": pattern_alternation(custom[("reporters", False)], priorities[("reporters", False)], precedence[("reporters", False)]),
        "us_reporter_custom_short": pattern_alternation(custom[("reporters", True)], priorities[("reporters", True)], precedence[("reporters", True)]),
        "us_journal_custom_full": pattern_alternation(custom[("journals", False)], priorities[("journals", False)], precedence[("journals", False)]),
        "us_journal_custom_short": pattern_alternation(custom[("journals", True)], priorities[("journals", True)], precedence[("journals", True)]),
        "us_laws": pattern_alternation(custom[("laws", False)], priorities[("laws", False)], precedence[("laws", False)]),
        "us_laws_short": pattern_alternation(custom[("laws", True)], priorities[("laws", True)], precedence[("laws", True)]),
        "us_page": page,
    })
    receipt_base = (
        f"Derived from eyecite {EYECITE_VERSION} ({EYECITE_COMMIT}) and "
        f"reporters-db {REPORTERS_DB_VERSION} ({REPORTERS_DB_COMMIT}), "
        f"{LICENSE}; runtime-free authored snapshot"
    )
    law_examples = source_examples["laws"]
    if not law_examples:
        raise ValueError("reporters-db supplied no law examples")
    law_full_by_short = {
        short_cite_re(item.regex): item
        for item in by_source["laws"]
        if not item.extra.get("short")
    }
    law_short_examples: set[str] = set()
    for item in by_source["laws"]:
        if not item.extra.get("short"):
            continue
        full = law_full_by_short.get(item.regex)
        if full is None:
            continue
        for example in law_examples:
            match = full.compiled_regex.search(example)
            if not match or not match.groupdict().get("page"):
                continue
            page_start = match.start("page")
            witness = example[:page_start] + "at " + example[page_start:]
            if item.compiled_regex.search(witness):
                law_short_examples.add(witness)
                break
    if not law_short_examples:
        raise ValueError("no law short-cite vectors could be derived")
    citations_table["entries"].extend([
        entry(
            "cite.us.reporter.full",
            r"(?<![A-Za-z0-9])(?<volume>[1-9]\d*) (?<reporter>{{us_reporters}}),? (?<page>{{us_page}})(?![A-Za-z0-9])",
            f"{receipt_base}; standard reporter template factored exactly",
            ["410 U.S. 113", "347 U. S. 483", "123 F.3d 456"],
            "410 NOTAREPORTER 113",
        ),
        entry(
            "cite.us.reporter.short",
            r"(?<![A-Za-z0-9])(?<volume>[1-9]\d*) (?<reporter>{{us_reporters}}),? at\s?(?:p(?:\.|age)?)? (?<page>{{us_page}})(?![A-Za-z0-9])",
            f"{receipt_base}; standard eyecite short-cite template factored exactly",
            ["410 U.S. at 115", "123 F.3d, at p. 460"],
            "410 NOTAREPORTER at 115",
        ),
        entry(
            "cite.us.reporter.custom.full",
            r"(?<![A-Za-z0-9]){{us_reporter_custom_full}}(?![A-Za-z0-9])",
            f"{receipt_base}; {len(custom[(('reporters'), False)])} custom full reporter extractors kept distinct from the standard catalogue for overlap fidelity",
            [
                "140 Lab. Cas. (CCH) P58,886A",
                "81 Misc 3d 1211(A)",
                "T.C.M. (RIA) 2004-279",
            ],
            "Imaginary Reporter P58,886A",
        ),
        entry(
            "cite.us.reporter.custom.short",
            r"(?<![A-Za-z0-9]){{us_reporter_custom_short}}(?![A-Za-z0-9])",
            f"{receipt_base}; {len(custom[(('reporters'), True)])} custom short reporter extractors kept distinct for overlap fidelity",
            [
                "140 Lab. Cas. (CCH) Pat 58,886A",
                "81 Misc 3d at 1211(A)",
            ],
            "Imaginary Reporter at 58,886A",
        ),
        entry(
            "cite.us.journal.full",
            r"(?<![A-Za-z0-9])(?:{{us_journal_custom_full}}|(?<volume>[1-9]\d*) (?<reporter>{{us_journals}}),? (?<page>{{us_page}}))(?![A-Za-z0-9])",
            f"{receipt_base}; standard journal template factored without changing custom extractors",
            ["123 Harv. L. Rev. 456"],
            "123 Imaginary Journal 456",
        ),
        entry(
            "cite.us.journal.short",
            r"(?<![A-Za-z0-9])(?:{{us_journal_custom_short}}|(?<volume>[1-9]\d*) (?<reporter>{{us_journals}}),? at\s?(?:p(?:\.|age)?)? (?<page>{{us_page}}))(?![A-Za-z0-9])",
            f"{receipt_base}; exact eyecite short-cite extractors, template-factored",
            ["123 Harv. L. Rev. at 460"],
            "123 Imaginary Journal at 460",
        ),
        entry(
            "cite.us.law.full",
            r"(?<![A-Za-z0-9]){{us_laws}}(?![A-Za-z0-9])",
            f"{receipt_base}; {len(custom[(('laws'), False)])} deduplicated custom law extractors",
            law_examples[:12],
            "Imaginary Code § 999",
        ),
        entry(
            "cite.us.law.short",
            r"(?<![A-Za-z0-9]){{us_laws_short}}(?![A-Za-z0-9])",
            f"{receipt_base}; {len(custom[(('laws'), True)])} deduplicated eyecite short-cite law extractors",
            sorted(law_short_examples)[:12],
            "Imaginary Code at 999",
        ),
    ])

    failures = grammar_tables.run_vectors(citations_table)
    if failures:
        raise ValueError("candidate vector failures:\n" + "\n".join(failures[:50]))

    output = HERE / "results" / "candidate-corpus.json"
    atomic_json(output, candidate)
    output_bytes = output.read_bytes()
    records = {
        "reporters": sum(len(cluster) for cluster in REPORTERS.values()),
        "journals": sum(len(cluster) for cluster in JOURNALS.values()),
        "laws": sum(len(cluster) for cluster in LAWS.values()),
    }
    atomic_json(HERE / "results" / "candidate-receipt.json", {
        "format": "beaver.eyecite-us-grammar-candidate.v1",
        "eyecite": {"version": EYECITE_VERSION, "commit": EYECITE_COMMIT},
        "reporters_db": {
            "version": REPORTERS_DB_VERSION,
            "commit": REPORTERS_DB_COMMIT,
        },
        "license": LICENSE,
        "source_records": records,
        "source_extractors": {key: len(value) for key, value in by_source.items()},
        "standard_surfaces": {
            f"{source}_{'short' if short else 'full'}": len(values)
            for (source, short), values in surfaces.items()
        },
        "custom_patterns": {
            f"{source}_{'short' if short else 'full'}": len(values)
            for (source, short), values in custom.items()
        },
        "reporter_surfaces_sha256": sha256_text("\n".join(sorted({value for (source, _), values in surfaces.items() if source == "reporters" for value in values}))),
        "journal_surfaces_sha256": sha256_text("\n".join(sorted({value for (source, _), values in surfaces.items() if source == "journals" for value in values}))),
        "custom_patterns_sha256": sha256_text("\n".join(sorted(portable_patterns))),
        "law_examples": len(law_examples),
        "law_short_examples": len(law_short_examples),
        "candidate_bytes": len(output_bytes),
        "candidate_sha256": hashlib.sha256(output_bytes).hexdigest(),
    })
    print(
        f"candidate: {len(output_bytes):,} bytes; "
        f"standard={sum(len(value) for value in surfaces.values()):,}; "
        f"custom={sum(len(value) for value in custom.values()):,}"
    )


if __name__ == "__main__":
    main()
