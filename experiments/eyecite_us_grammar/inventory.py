#!/usr/bin/env python3
"""Inventory pinned eyecite grammar inputs and the installed US corpus."""

from __future__ import annotations

import importlib.metadata
import json
import os
import sqlite3
from collections import Counter
from pathlib import Path

EYECITE_VERSION = "2.7.8"
EYECITE_COMMIT = "09165c2d90b4295b4967b1b01b83963c37ab2a98"
REPORTERS_DB_VERSION = "3.2.66"
REPORTERS_DB_COMMIT = "fad63b383b92f9446c223ddc12bf0b6fd1a6b44c"
LICENSE = "BSD-2-Clause"


def courtlistener_path() -> Path:
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    return (
        local
        / "OpenLegalProducts"
        / "LegalData"
        / "providers"
        / "courtlistener"
        / "courtlistener.sqlite"
    )


def main() -> None:
    if importlib.metadata.version("eyecite") != EYECITE_VERSION:
        raise RuntimeError(f"eyecite {EYECITE_VERSION} is required")
    if importlib.metadata.version("reporters-db") != REPORTERS_DB_VERSION:
        raise RuntimeError(f"reporters-db {REPORTERS_DB_VERSION} is required")

    from eyecite.models import CitationToken
    from eyecite.tokenizers import EXTRACTORS

    citations = [
        extractor
        for extractor in EXTRACTORS
        if extractor.constructor == CitationToken.from_match
    ]
    sources = Counter(
        edition.reporter.source
        for extractor in citations
        for edition in (
            *extractor.extra.get("exact_editions", ()),
            *extractor.extra.get("variation_editions", ()),
        )
    )
    sample_regexes: dict[str, str] = {}
    for extractor in citations:
        editions = (
            *extractor.extra.get("exact_editions", ()),
            *extractor.extra.get("variation_editions", ()),
        )
        if editions:
            sample_regexes.setdefault(editions[0].reporter.source, extractor.regex)
    database = courtlistener_path()
    if not database.is_file():
        raise FileNotFoundError(database)
    with sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True) as connection:
        tables = {
            name: sql
            for name, sql in connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        }
        meta = dict(connection.execute("SELECT key, value FROM meta"))

    print(json.dumps({
        "eyecite": {"version": EYECITE_VERSION, "commit": EYECITE_COMMIT},
        "reporters_db": {
            "version": REPORTERS_DB_VERSION,
            "commit": REPORTERS_DB_COMMIT,
        },
        "license": LICENSE,
        "extractors": {
            "all": len(EXTRACTORS),
            "citations": len(citations),
            "short": sum(bool(item.extra.get("short")) for item in citations),
            "regex_characters": sum(len(item.regex) for item in citations),
            "max_regex_characters": max(len(item.regex) for item in citations),
            "edition_sources": sources,
            "sample_regexes": sample_regexes,
        },
        "courtlistener": {
            "path": str(database),
            "bytes": database.stat().st_size,
            "meta": meta,
            "tables": tables,
        },
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
