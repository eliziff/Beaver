#!/usr/bin/env python
"""Fail-closed A2AJ citation-grammar baseline and candidate scorer."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "OpenLegalData" / "src"))
sys.path.insert(0, str(REPO / "legal-pdf-parser" / "src"))

from open_legal_data.a2aj import citation_key  # noqa: E402
from open_legal_data.paths import provider_database, provider_directory  # noqa: E402
import legalpdf.grammar_tables as grammar_tables  # noqa: E402

FORMAT = "beaver.citation-grammar-harness.v1"
SPLIT_VERSION = "sha256-v1:language+nul+citation;mod5=0-heldout"
CASE_ENTRY = re.compile(r"^cite\.(?:neutral(?:\.|$)|canlii$|reporter\.)")
TIER_LIMITS = {"smoke": 20, "dev": 500, "full": None}
MAX_DETAILS = 200
PROGRESS_EVERY = 10_000


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def split_name(language: str, citation: str) -> str:
    digest = hashlib.sha256(
        f"citation-grammar-split-v1\0{language}\0{citation}".encode("utf-8")
    ).digest()
    return "heldout" if int.from_bytes(digest[:4], "big") % 5 == 0 else "train"


def occurrence_spans(text: str, citation: str) -> list[tuple[int, int]]:
    exact: list[tuple[int, int]] = []
    start = 0
    while (found := text.find(citation, start)) >= 0:
        end = found + len(citation)
        exact.append((found, end))
        start = end
    if exact:
        return exact
    tokens = citation.split()
    if not tokens:
        return []
    return [
        match.span()
        for match in re.finditer(r"\s+".join(map(re.escape, tokens)), text)
    ]


def first_occurrence_span(text: str, citation: str) -> tuple[int, int] | None:
    found = text.find(citation)
    if found >= 0:
        return found, found + len(citation)
    tokens = citation.split()
    if not tokens:
        return None
    match = re.search(r"\s+".join(map(re.escape, tokens)), text)
    return match.span() if match else None


def citation_class(value: str) -> str:
    if re.fullmatch(r"(?:17|18|19|20)\d{2}\s+CanLII\s+\d+", value):
        return "canlii"
    match = re.fullmatch(r"(?:17|18|19|20)\d{2}\s+(.+?)\s+\d+", value)
    if match:
        court = match.group(1)
        if re.fullmatch(r"[A-Z][A-Z0-9-]{1,15}", court):
            return "neutral-single"
        if " " in court:
            return f"neutral-multitoken:{court}"
        if "." in court:
            return f"neutral-dotted:{court}"
        return f"neutral-other:{court}"
    if value.startswith("[") or re.match(r"^\d+\s+[A-Z]", value):
        return "reporter"
    return "other"


def load_patterns(
    corpus_path: Path, candidate_path: Path | None
) -> tuple[dict[str, re.Pattern[str]], dict[str, re.Pattern[str]] | None, dict]:
    raw = corpus_path.read_bytes()
    tables = grammar_tables.read_corpus(corpus_path)
    failures = [
        failure
        for table in tables.values()
        for failure in grammar_tables.run_vectors(table)
    ]
    if failures:
        raise ValueError("baseline grammar vectors failed:\n" + "\n".join(failures))
    citations = tables["citations"]

    def compile_case(table: dict) -> dict[str, re.Pattern[str]]:
        defs = table.get("defs") or {}
        return {
            entry["id"]: grammar_tables.compile_entry(entry, defs)
            for entry in table["entries"]
            if CASE_ENTRY.match(entry["id"])
        }

    baseline = compile_case(citations)
    metadata = {
        "baseline_sha256": sha256_bytes(raw),
        "baseline_entries": sorted(baseline),
        "candidate": None,
    }
    if not candidate_path:
        return baseline, None, metadata

    candidate_bytes = candidate_path.read_bytes()
    candidate = json.loads(candidate_bytes)
    if candidate.get("format") != "beaver.citation-grammar-candidate.v1":
        raise ValueError("candidate has an unsupported format")
    if set(candidate) - {"format", "name", "defs", "entries"}:
        raise ValueError("candidate has unknown fields")
    entries = candidate.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError("candidate must contain entries")
    proposed = copy.deepcopy(citations)
    proposed["defs"] = {**(proposed.get("defs") or {}), **(candidate.get("defs") or {})}
    by_id = {entry["id"]: entry for entry in proposed["entries"]}
    changed: list[str] = []
    for entry in entries:
        entry_id = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(entry_id, str) or not CASE_ENTRY.match(entry_id):
            raise ValueError(f"candidate entry is outside case citations: {entry_id!r}")
        vectors = entry.get("vectors")
        if not isinstance(vectors, list):
            raise ValueError(f"{entry_id}: missing vectors")
        if not any(vector.get("groups") is None for vector in vectors):
            raise ValueError(f"{entry_id}: needs an adversarial negative vector")
        if not any(vector.get("groups") is not None for vector in vectors):
            raise ValueError(f"{entry_id}: needs a positive vector")
        by_id[entry_id] = entry
        changed.append(entry_id)
    proposed["entries"] = list(by_id.values())
    failures = grammar_tables.run_vectors(proposed)
    if failures:
        raise ValueError("candidate grammar vectors failed:\n" + "\n".join(failures))
    compiled = compile_case(proposed)
    metadata["candidate"] = {
        "name": candidate.get("name") or candidate_path.stem,
        "sha256": sha256_bytes(candidate_bytes),
        "changed_entries": sorted(changed),
        "entries": sorted(compiled),
    }
    return baseline, compiled, metadata


def matches(
    patterns: dict[str, re.Pattern[str]], text: str
) -> list[tuple[int, int, str]]:
    found: list[tuple[int, int, str]] = []
    for entry_id, pattern in patterns.items():
        for match in pattern.finditer(text):
            start, end = match.span()
            if text[start:end] != match.group(0):
                raise AssertionError(f"{entry_id}: source span drift")
            found.append((start, end, entry_id))
    return found


def grammar_hit(
    patterns: dict[str, re.Pattern[str]], source_span: str
) -> bool:
    """Test the exact source spelling without rescanning its whole document."""
    return bool(matches(patterns, source_span))


def grammar_exact_match(
    patterns: dict[str, re.Pattern[str]], source_span: str
) -> bool:
    return any(
        start == 0 and end == len(source_span)
        for start, end, _ in matches(patterns, source_span)
    )


def span_hits(
    spans: list[tuple[int, int, str]], occurrences: list[tuple[int, int]]
) -> bool:
    return any(
        occurrence_start <= start and end <= occurrence_end
        for start, end, _ in spans
        for occurrence_start, occurrence_end in occurrences
    )


def readonly_sqlite(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError(path)
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)


class EvidenceOracle:
    def __init__(self, a2aj: Path, canlii: Path):
        self.a2aj_path = a2aj
        self.canlii_path = canlii
        self.a2aj = readonly_sqlite(a2aj)
        self.canlii = readonly_sqlite(canlii)
        if not self.a2aj.execute(
            "SELECT 1 FROM sqlite_master WHERE name='citation_lookup'"
        ).fetchone():
            raise ValueError("A2AJ citation_lookup is unavailable")
        if not self.canlii.execute(
            "SELECT 1 FROM sqlite_master WHERE name='cases'"
        ).fetchone():
            raise ValueError("CanLII cases table is unavailable")
        self.cache: dict[str, str | None] = {}

    def verify(self, value: str) -> str | None:
        key = citation_key(value)
        if key in self.cache:
            return self.cache[key]
        source = None
        if self.a2aj.execute(
            "SELECT 1 FROM citation_lookup WHERE citation_key=? LIMIT 1", (key,)
        ).fetchone():
            source = "a2aj"
        elif self.canlii.execute(
            "SELECT 1 FROM cases WHERE caseId=? LIMIT 1", (key,)
        ).fetchone():
            source = "canlii"
        self.cache[key] = source
        return source

    def identity(self, verify_hashes: bool) -> dict:
        a2aj_meta = dict(self.a2aj.execute("SELECT key, value FROM meta"))
        return {
            "a2aj": {
                "bytes": self.a2aj_path.stat().st_size,
                "sha256": sha256_file(self.a2aj_path) if verify_hashes else None,
                "schema_version": a2aj_meta.get("schema_version"),
                "imported_at": a2aj_meta.get("imported_at"),
            },
            "canlii": {
                "bytes": self.canlii_path.stat().st_size,
                "sha256": sha256_file(self.canlii_path) if verify_hashes else None,
                "cases": self.canlii.execute("SELECT count(*) FROM cases").fetchone()[0],
            },
        }

    def close(self) -> None:
        self.a2aj.close()
        self.canlii.close()


def source_files(root: Path, verify_hashes: bool) -> tuple[list[dict], dict]:
    cases = root / "cases"
    manifest_path = cases / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    entries = manifest.get("files")
    if manifest.get("version") != 2 or manifest.get("kind") != "cases":
        raise ValueError("unsupported A2AJ cases manifest")
    if not isinstance(entries, list) or not entries:
        raise ValueError("A2AJ cases manifest has no files")
    expected = {entry["path"] for entry in entries}
    discovered = {
        path.relative_to(cases).as_posix() for path in cases.glob("*/train.parquet")
    }
    if discovered != expected:
        raise ValueError(
            f"A2AJ corpus accounting mismatch: missing={sorted(expected-discovered)} "
            f"extra={sorted(discovered-expected)}"
        )
    checked = []
    for number, entry in enumerate(sorted(entries, key=lambda item: item["path"]), 1):
        path = cases / entry["path"]
        if path.stat().st_size != entry["size"]:
            raise ValueError(f"size mismatch: {entry['path']}")
        actual = None
        if verify_hashes:
            print(f"[verify {number}/{len(entries)}] {entry['path']}", flush=True)
            actual = sha256_file(path)
            if actual != entry["sha256"]:
                raise ValueError(f"sha256 mismatch: {entry['path']}")
        checked.append({**entry, "file": path, "verified_sha256": actual})
    return checked, {
        "manifest_sha256": sha256_bytes(manifest_bytes),
        "revision": manifest.get("revision"),
        "files": len(entries),
        "verification": "sha256" if verify_hashes else "manifest+size",
    }


def empty_split() -> dict:
    return {
        "gold": 0,
        "absent": 0,
        "eligible": 0,
        "baseline_found": 0,
        "candidate_found": 0,
    }


def score_shard(
    *,
    source: dict,
    language: str,
    limit: int | None,
    baseline: dict[str, re.Pattern[str]],
    candidate: dict[str, re.Pattern[str]] | None,
    candidate_delta: dict[str, re.Pattern[str]] | None,
    oracle: EvidenceOracle,
    shard_wall_cap: float,
) -> dict:
    import duckdb

    shard_started = time.perf_counter()
    path: Path = source["file"]
    citation = f"citation_{language}"
    alternate = f"citation2_{language}"
    url = f"url_{language}"
    text_column = f"unofficial_text_{language}"
    cited_column = f"cases_cited_{language}"
    con = duckdb.connect()
    columns = {
        row[0]
        for row in con.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]
        ).fetchall()
    }
    required = {"dataset", citation, alternate, url, text_column, cited_column}
    if not required.issubset(columns):
        raise ValueError(f"{source['path']}/{language}: missing {sorted(required-columns)}")
    def iter_documents():
        if limit is None:
            import pyarrow.parquet as parquet

            row_number = 0
            parquet_file = parquet.ParquetFile(path)
            for batch in parquet_file.iter_batches(
                batch_size=2_048,
                columns=[text_column, cited_column],
                use_threads=True,
            ):
                texts = batch.column(0).to_pylist()
                cited_lists = batch.column(1).to_pylist()
                for text, cited in zip(texts, cited_lists):
                    current_row = row_number
                    row_number += 1
                    if text is not None and cited:
                        yield (
                            f"{source['sha256']}:{current_row}",
                            f"{Path(source['path']).parts[0]} row {current_row}",
                            text,
                            cited,
                        )
            return

        query = f"""
            SELECT
              sha256(concat_ws('|', coalesce(dataset, ''), '{language}',
                     coalesce({citation}, ''), coalesce({alternate}, ''),
                     coalesce({url}, ''))) AS doc_id,
              coalesce({citation}, {alternate}, '') AS self_citation,
              {text_column}, {cited_column}
            FROM read_parquet(?)
            WHERE {text_column} IS NOT NULL AND len({cited_column}) > 0
            ORDER BY doc_id
            LIMIT {int(limit)}
        """
        cursor = con.execute(query, [str(path)])
        while rows := cursor.fetchmany(2_048):
            yield from rows
    result = {
        "format": FORMAT,
        "dataset": Path(source["path"]).parts[0],
        "language": language,
        "source_sha256": source["sha256"],
        "docs": 0,
        "chars": 0,
        "splits": {"train": empty_split(), "heldout": empty_split()},
        "failure_classes": {"baseline": {}, "candidate": {}},
        "new_matches": {"attested": 0, "a2aj": 0, "canlii": 0, "review": 0},
        "performance": {
            "baseline_seconds": 0.0,
            "candidate_seconds": 0.0,
            "candidate_precision_seconds": 0.0,
            "shard_wall_seconds": 0.0,
            "shard_wall_cap_seconds": shard_wall_cap,
            "shard_wall_cap_failed": False,
        },
        "misses": [],
        "review_queue": [],
    }
    split_accumulator = 0
    split_items = 0
    digest_modulus = 1 << 256
    baseline_classes: Counter = Counter()
    candidate_classes: Counter = Counter()
    baseline_cache: dict[str, bool] = {}
    candidate_cache: dict[str, bool] = {}
    baseline_exact_cache: dict[str, bool] = {}
    split_cache: dict[str, str] = {}
    for doc_id, self_citation, text, cited in iter_documents():
            result["docs"] += 1
            result["chars"] += len(text)
            perf = result["performance"]
            candidate_spans: list[tuple[int, int, str]] = []
            if candidate_delta:
                if text is None:
                    raise AssertionError("candidate scoring requires source text")
                started = time.perf_counter()
                candidate_spans = matches(candidate_delta, text)
                perf["candidate_precision_seconds"] += time.perf_counter() - started

            gold_ranges: list[tuple[int, int]] = []
            for gold in dict.fromkeys(cited):
                if not isinstance(gold, str) or not gold.strip():
                    continue
                split = split_cache.get(gold)
                if split is None:
                    split = split_name(language, gold)
                    split_cache[gold] = split
                    split_accumulator = (
                        split_accumulator
                        + int.from_bytes(
                            hashlib.sha256(
                                f"{language}\0{gold}\0{split}".encode("utf-8")
                            ).digest(),
                            "big",
                        )
                    ) % digest_modulus
                    split_items += 1
                bucket = result["splits"][split]
                bucket["gold"] += 1
                if candidate_delta:
                    occurrences = occurrence_spans(text, gold)
                else:
                    first = first_occurrence_span(text, gold)
                    occurrences = [first] if first else []
                if not occurrences:
                    bucket["absent"] += 1
                    continue
                bucket["eligible"] += 1
                if candidate_delta:
                    gold_ranges.extend(occurrences)
                source_spellings = (
                    {gold}
                    if text.startswith(gold, occurrences[0][0])
                    else {text[start:end] for start, end in occurrences}
                )
                baseline_hit = False
                for spelling in source_spellings:
                    if spelling not in baseline_cache:
                        started = time.perf_counter()
                        baseline_cache[spelling] = grammar_hit(baseline, spelling)
                        perf["baseline_seconds"] += time.perf_counter() - started
                    baseline_hit |= baseline_cache[spelling]
                candidate_hit = baseline_hit
                if candidate is not None:
                    candidate_hit = False
                    for spelling in source_spellings:
                        if spelling not in candidate_cache:
                            started = time.perf_counter()
                            candidate_cache[spelling] = grammar_hit(candidate, spelling)
                            perf["candidate_seconds"] += time.perf_counter() - started
                        candidate_hit |= candidate_cache[spelling]
                bucket["baseline_found"] += int(baseline_hit)
                bucket["candidate_found"] += int(candidate_hit)
                if not baseline_hit:
                    baseline_classes[citation_class(gold)] += 1
                if not candidate_hit:
                    candidate_classes[citation_class(gold)] += 1
                if (not candidate_hit or candidate is None and not baseline_hit) and len(
                    result["misses"]
                ) < MAX_DETAILS:
                    position = occurrences[0][0]
                    context = (
                        text[max(0, position - 80) : position + len(gold) + 80]
                        if text is not None
                        else gold
                    )
                    result["misses"].append(
                        {
                            "document": self_citation,
                            "gold": gold,
                            "split": split,
                            "class": citation_class(gold),
                            "context": context,
                        }
                    )

            if candidate_delta:
                new_by_range: dict[tuple[int, int], set[str]] = {}
                for start, end, entry_id in candidate_spans:
                    value = text[start:end]
                    if value not in baseline_exact_cache:
                        baseline_exact_cache[value] = grammar_exact_match(baseline, value)
                    if not baseline_exact_cache[value]:
                        new_by_range.setdefault((start, end), set()).add(entry_id)
                for (start, end), entry_ids in new_by_range.items():
                    if any(a <= start and end <= b for a, b in gold_ranges):
                        result["new_matches"]["attested"] += 1
                        continue
                    value = text[start:end]
                    evidence = oracle.verify(value)
                    if evidence:
                        result["new_matches"][evidence] += 1
                        continue
                    result["new_matches"]["review"] += 1
                    if len(result["review_queue"]) < MAX_DETAILS:
                        result["review_queue"].append(
                            {
                                "document": self_citation,
                                "entries": sorted(entry_ids),
                                "match": value,
                                "context": text[max(0, start - 80) : min(len(text), end + 80)],
                            }
                        )
            if result["docs"] % PROGRESS_EVERY == 0:
                print(
                    f"  progress {result['dataset']}/{language}: "
                    f"{result['docs']} docs, {result['chars']:,} chars",
                    flush=True,
                )
    con.close()
    result["failure_classes"]["baseline"] = dict(baseline_classes.most_common())
    result["failure_classes"]["candidate"] = dict(candidate_classes.most_common())
    result["split_digest"] = sha256_bytes(
        f"unique-map-sum-v1\0{split_items}\0{split_accumulator:064x}".encode("utf-8")
    )
    wall = time.perf_counter() - shard_started
    result["performance"]["shard_wall_seconds"] = wall
    result["performance"]["shard_wall_cap_failed"] = wall > shard_wall_cap
    return result


def add_counts(target: dict, source: dict) -> None:
    for key, value in source.items():
        if isinstance(value, int):
            target[key] = target.get(key, 0) + value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", choices=TIER_LIMITS, default="smoke")
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--canlii", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument(
        "--dataset",
        action="append",
        help="score only this dataset (repeatable; diagnostic, never promotable)",
    )
    parser.add_argument(
        "--language",
        action="append",
        choices=("en", "fr"),
        help="score only this language (repeatable; diagnostic, never promotable)",
    )
    parser.add_argument("--shard-wall-cap", type=float, default=15.0)
    parser.add_argument("--verify-files", action="store_true")
    args = parser.parse_args()
    verify_hashes = args.verify_files
    source_root = (
        args.source_root
        or provider_directory("a2aj") / "source"
    ).resolve()
    canlii = (
        args.canlii
        or Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        / "ALR Quote Verifier"
        / "data"
        / "canlii-186d92f8c0a4.db"
    ).resolve()
    corpus_path = REPO / "packages" / "legal-grammar-tables" / "grammar-corpus.json"
    harvested = REPO / "benchmarks" / "grammar_vectors" / "harvested.jsonl"
    scorer_sha = sha256_file(Path(__file__))
    baseline, candidate, grammar = load_patterns(corpus_path, args.candidate)
    candidate_delta = None
    if candidate is not None:
        candidate_delta = {
            entry_id: candidate[entry_id]
            for entry_id in grammar["candidate"]["changed_entries"]
        }
    fingerprint = (grammar["candidate"] or {"sha256": grammar["baseline_sha256"]})[
        "sha256"
    ][:12]
    requested_datasets = sorted(set(args.dataset or []))
    requested_languages = sorted(set(args.language or ("en", "fr")))
    run_options = {
        "tier": args.tier,
        "datasets": requested_datasets,
        "languages": requested_languages,
        "verify_files": verify_hashes,
        "shard_wall_cap": args.shard_wall_cap,
        "source_root": str(source_root),
        "canlii": str(canlii),
    }
    option_fingerprint = sha256_bytes(
        json.dumps(run_options, sort_keys=True).encode("utf-8")
    )[:8]
    out = (
        args.out
        or Path(__file__).parent
        / "results"
        / f"{args.tier}-{fingerprint}-{scorer_sha[:8]}-{option_fingerprint}"
    ).resolve()
    files, source_identity = source_files(source_root, verify_hashes)
    available_datasets = {Path(source["path"]).parts[0] for source in files}
    unknown_datasets = set(requested_datasets) - available_datasets
    if unknown_datasets:
        raise ValueError(f"unknown datasets: {sorted(unknown_datasets)}")
    selected_files = [
        source
        for source in files
        if not requested_datasets
        or Path(source["path"]).parts[0] in requested_datasets
    ]
    complete_corpus = not requested_datasets and not args.language
    oracle = EvidenceOracle(provider_database("a2aj"), canlii)
    print("[oracle] recording identities", flush=True)
    oracle_identity = oracle.identity(verify_hashes)
    limit = TIER_LIMITS[args.tier]
    run_signature = sha256_bytes(
        json.dumps(
            {
                "format": FORMAT,
                "scorer": scorer_sha,
                "grammar": grammar,
                "source": source_identity,
                "oracle": oracle_identity,
                "tier": args.tier,
                "limit": limit,
                "split": SPLIT_VERSION,
                "options": run_options,
            },
            sort_keys=True,
        ).encode("utf-8")
    )
    shards = []
    for source in selected_files:
        dataset = Path(source["path"]).parts[0]
        for language in requested_languages:
            shard_path = out / "shards" / f"{dataset}.{language}.json"
            signature = sha256_bytes(
                f"{run_signature}\0{source['sha256']}\0{language}".encode("utf-8")
            )
            if shard_path.is_file():
                shard = json.loads(shard_path.read_text(encoding="utf-8"))
                if shard.get("signature") != signature:
                    raise ValueError(f"stale checkpoint: {shard_path}")
                print(f"[resume] {dataset}/{language}", flush=True)
            else:
                print(f"[score] {dataset}/{language}", flush=True)
                shard = score_shard(
                    source=source,
                    language=language,
                    limit=limit,
                    baseline=baseline,
                    candidate=candidate,
                    candidate_delta=candidate_delta,
                    oracle=oracle,
                    shard_wall_cap=args.shard_wall_cap,
                )
                shard["signature"] = signature
                atomic_json(shard_path, shard)
            shards.append(shard)
            print(
                f"  done {dataset}/{language}: {shard['docs']} docs, "
                f"heldout {shard['splits']['heldout']['baseline_found']}/"
                f"{shard['splits']['heldout']['eligible']}",
                flush=True,
            )
    oracle.close()

    totals = {
        "docs": sum(shard["docs"] for shard in shards),
        "chars": sum(shard["chars"] for shard in shards),
        "splits": {"train": empty_split(), "heldout": empty_split()},
        "new_matches": {},
        "performance": {
            "baseline_seconds": 0.0,
            "candidate_seconds": 0.0,
            "candidate_precision_seconds": 0.0,
            "shard_wall_seconds": 0.0,
            "max_shard_wall_seconds": 0.0,
            "shard_wall_cap_failures": 0,
        },
    }
    for shard in shards:
        for split in ("train", "heldout"):
            add_counts(totals["splits"][split], shard["splits"][split])
        add_counts(totals["new_matches"], shard["new_matches"])
        perf = shard["performance"]
        totals["performance"]["baseline_seconds"] += perf["baseline_seconds"]
        totals["performance"]["candidate_seconds"] += perf["candidate_seconds"]
        totals["performance"]["candidate_precision_seconds"] += perf[
            "candidate_precision_seconds"
        ]
        totals["performance"]["shard_wall_seconds"] += perf["shard_wall_seconds"]
        totals["performance"]["max_shard_wall_seconds"] = max(
            totals["performance"]["max_shard_wall_seconds"],
            perf["shard_wall_seconds"],
        )
        totals["performance"]["shard_wall_cap_failures"] += int(
            perf["shard_wall_cap_failed"]
        )
    perf = totals["performance"]
    perf["candidate_ratio"] = (
        perf["candidate_seconds"] / perf["baseline_seconds"]
        if candidate is not None and perf["baseline_seconds"]
        else None
    )
    heldout = totals["splits"]["heldout"]
    candidate_core_pass = None
    rejection_reasons: list[str] = []
    if candidate is not None:
        if heldout["candidate_found"] <= heldout["baseline_found"]:
            rejection_reasons.append("heldout recall did not strictly improve")
        if totals["new_matches"].get("review", 0):
            rejection_reasons.append("unresolved plausible false positives")
        if perf["candidate_ratio"] is not None and perf["candidate_ratio"] > 1.10:
            rejection_reasons.append("candidate runtime regressed by more than 10%")
        if perf["shard_wall_cap_failures"]:
            rejection_reasons.append("one or more shards exceeded the wall cap")
        candidate_core_pass = not rejection_reasons
    elif perf["shard_wall_cap_failures"]:
        rejection_reasons.append("one or more shards exceeded the wall cap")
    split_digest = sha256_bytes(
        ("\n".join(
            sorted(
                f"{shard['dataset']}\t{shard['language']}\t{shard['split_digest']}"
                for shard in shards
            )
        ) + "\n").encode("utf-8")
    )
    summary = {
        "format": FORMAT,
        "status": (
            "baseline_green"
            if candidate is None and not rejection_reasons
            else "candidate_pass"
            if candidate_core_pass and not perf["shard_wall_cap_failures"]
            else "candidate_rejected"
            if candidate is not None
            else "baseline_red"
        ),
        "promotion_eligible": bool(
            candidate_core_pass
            and args.tier == "full"
            and complete_corpus
            and verify_hashes
        ),
        "rejection_reasons": rejection_reasons,
        "run_signature": run_signature,
        "scorer_sha256": scorer_sha,
        "split": {"version": SPLIT_VERSION, "digest": split_digest},
        "tier": args.tier,
        "complete_corpus": complete_corpus,
        "verified_file_hashes": verify_hashes,
        "selected_datasets": requested_datasets or sorted(available_datasets),
        "selected_languages": requested_languages,
        "limit_per_dataset_language": limit,
        "grammar": grammar,
        "sources": {
            "a2aj": source_identity,
            "oracles": oracle_identity,
            "harvested_vectors_sha256": sha256_file(harvested),
        },
        "shards": len(shards),
        "totals": totals,
        "runtime": {
            "python": sys.version,
            "duckdb": __import__("duckdb").__version__,
        },
    }
    atomic_json(out / "summary.json", summary)
    print(json.dumps({
        "status": summary["status"],
        "out": str(out),
        "heldout": heldout,
        "new_matches": totals["new_matches"],
        "candidate_ratio": perf["candidate_ratio"],
        "max_shard_wall_seconds": perf["max_shard_wall_seconds"],
        "rejection_reasons": rejection_reasons,
    }, indent=2))
    return 0 if summary["status"] in {"baseline_green", "candidate_pass"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
