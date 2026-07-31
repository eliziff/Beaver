"""Dump real A2AJ text with compatibility reference structure.

The paired TypeScript gate feeds each row through Beaver's shipping
compileA2AJSourceDoc. Provider section maps are the native reference for laws;
where none exists, ALR is a compatibility baseline, not truth. Raw provider
text and section maps are kept byte-for-byte. The paired gate validates native
map entries directly against compiled text slices; this probe never invents
provider offsets by iterating a JSON object.

Usage:
  python scripts/skeleton-oracle-probe.py \
      --root "%LOCALAPPDATA%/ALR Quote Verifier/a2aj_corpus" \
      --reference-root "<ALR-Quote-Verifier>" --out probe.jsonl
"""
from __future__ import annotations

import argparse
import bisect
import ctypes
import hashlib
import importlib.util
import json
import multiprocessing as mp
import os
import re
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sourcedoc_client import compile_document


FORK = Path(__file__).resolve().parents[2]
SHARD_ROWS = 4_000
DIAGNOSTIC_CAP_PER_SHARD = 24
DIAGNOSTIC_CAP_TOTAL = 2_000
ASTRAL_RE = re.compile(r"[\U00010000-\U0010ffff]")
OUTCOMES = ("exact", "additive", "refined", "lost", "changed")
Block = tuple[str, int, int]
Shard = tuple[str, str, str, str, str, int, int]

_REFERENCE: Any = None
_WORKER_CON: Any = None


def canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_file(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def git_head(root: Path) -> str | None:
    try:
        return subprocess.run(
            [
                "git",
                "-c",
                f"safe.directory={root.as_posix()}",
                "-C",
                str(root),
                "rev-parse",
                "HEAD",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def utf16_offsets(text: str) -> tuple[list[int], int]:
    positions = [match.start() for match in ASTRAL_RE.finditer(text)]
    return positions, len(text) + len(positions)


def utf16_offset(offset: int, astral_positions: list[int]) -> int:
    return offset + bisect.bisect_left(astral_positions, offset)


def reference_blocks(
    items: list[tuple[Any, ...]],
    prefix: str,
    astral_positions: list[int],
) -> list[Block]:
    return [
        (
            f"{prefix}{label}",
            utf16_offset(start, astral_positions),
            utf16_offset(end, astral_positions),
        )
        for label, start, end, _text in items
    ]


def valid_blocks(items: list[Block], text_length: int) -> bool:
    previous_end = -1
    for label, start, end in items:
        if (
            not label
            or start < 0
            or end < start
            or end > text_length
            or start < previous_end
        ):
            return False
        previous_end = end
    return True


def subsequence(needles: list[Block], haystack: list[Block]) -> bool:
    index = 0
    for item in haystack:
        if index == len(needles):
            break
        if needles[index] == item:
            index += 1
    return index == len(needles)


def strict_refinement(reference: list[Block], actual: list[Block]) -> bool:
    if len(actual) <= len(reference):
        return False
    occurrences: dict[str, int | None] = {}
    for index, (label, _start, _end) in enumerate(actual):
        occurrences[label] = None if label in occurrences else index
    position = 0
    split = False
    for label, start, end in reference:
        while position < len(actual) and actual[position][2] <= start:
            position += 1
        retained = occurrences.get(label)
        if retained is None or retained != position or actual[position][1] != start:
            return False
        cursor = start
        tiles = 0
        while position < len(actual) and actual[position][1] < end:
            _tile_label, tile_start, tile_end = actual[position]
            if tile_start != cursor or tile_end <= tile_start or tile_end > end:
                return False
            cursor = tile_end
            tiles += 1
            position += 1
        if cursor != end:
            return False
        split = split or tiles > 1
    return split


def classify(
    kind: str,
    reference: list[Block],
    actual: list[Block],
    text_length: int,
) -> str:
    if not valid_blocks(reference, text_length) or not valid_blocks(
        actual, text_length
    ):
        return "changed"
    if reference == actual:
        return "exact"
    if len(actual) > len(reference) and subsequence(reference, actual):
        return "additive"
    available = Counter(label for label, _start, _end in actual)
    for label, _start, _end in reference:
        if not available[label]:
            return "lost"
        available[label] -= 1
    if kind in {"paragraph", "section"} and strict_refinement(reference, actual):
        return "refined"
    return "changed"


def self_test() -> None:
    astral, length = utf16_offsets("a😀b")
    assert length == 4
    assert [utf16_offset(value, astral) for value in range(4)] == [0, 1, 3, 4]
    exact = [("par1", 0, 10)]
    assert classify("paragraph", exact, exact, 20) == "exact"
    assert (
        classify("paragraph", exact, [*exact, ("par2", 10, 20)], 20)
        == "additive"
    )
    assert classify(
        "paragraph",
        exact,
        [("par1", 0, 4), ("par2", 4, 10)],
        20,
    ) == "refined"
    assert classify(
        "paragraph",
        [("par1", 0, 4), ("par2", 4, 10)],
        exact,
        20,
    ) == "lost"
    assert classify("paragraph", exact, [("par1", 0, 9)], 20) == "changed"
    assert classify(
        "paragraph",
        exact,
        [("par1", 0, 4), ("par2", 5, 10)],
        20,
    ) == "changed"
    assert (
        classify("page", exact, [("par1", 0, 4), ("par2", 4, 10)], 20)
        == "changed"
    )

def corpus_paths(root: Path, kinds: set[str], families: set[str]) -> list[tuple[str, Path]]:
    available = {
        kind: root / kind if (root / kind).is_dir() else root
        for kind in ("cases", "laws")
    }
    paths: list[tuple[str, Path]] = []
    for kind in ("cases", "laws"):
        if kind not in kinds or not available[kind].is_dir():
            continue
        for path in sorted(available[kind].glob("*/train.parquet")):
            if not families or path.parent.name.upper() in families:
                paths.append((kind, path))
    return paths


def sample_rows(path: Path, columns: list[str], count: int) -> list[dict[str, Any]]:
    """Read deterministic strata without materializing a multi-GB parquet."""
    import pyarrow.parquet as pq

    parquet = pq.ParquetFile(path)
    total = parquet.metadata.num_rows
    if not total:
        return []
    targets = sorted({min(total - 1, (index * total) // count) for index in range(count)})
    rows: list[dict[str, Any]] = []
    first = 0
    target_index = 0
    for group in range(parquet.num_row_groups):
        group_rows = parquet.metadata.row_group(group).num_rows
        last = first + group_rows
        owned: list[int] = []
        while target_index < len(targets) and targets[target_index] < last:
            if targets[target_index] >= first:
                owned.append(targets[target_index] - first)
            target_index += 1
        if owned:
            table = parquet.read_row_group(group, columns=columns)
            rows.extend(table.slice(offset, 1).to_pylist()[0] for offset in owned)
        first = last
        if target_index == len(targets):
            break
    return rows


def value(row: dict[str, Any], field: str, language: str, fallback: bool = True) -> str:
    other = "fr" if language == "en" else "en"
    result = row.get(f"{field}_{language}")
    if not result and fallback:
        result = row.get(f"{field}_{other}")
    return str(result or "")


def blocks(
    items: list[tuple[Any, ...]],
    prefix: str,
    astral_positions: list[int] | None = None,
) -> list[dict[str, Any]]:
    positions = astral_positions or []
    return [
        {
            "label": f"{prefix}{label}",
            "start": utf16_offset(start, positions),
            "end": utf16_offset(end, positions),
        }
        for label, start, end, _text in items
    ]


def kind_root(root: Path, kind: str) -> Path:
    candidate = root / kind
    return candidate if candidate.is_dir() else root


def verified_corpus(
    root: Path, kinds: set[str], families: set[str]
) -> tuple[list[dict[str, Any]], list[tuple[str, Path, str]]]:
    receipts: list[dict[str, Any]] = []
    selected: list[tuple[str, Path, str]] = []
    for kind in ("cases", "laws"):
        if kind not in kinds:
            continue
        base = kind_root(root, kind).resolve()
        manifest_path = base / "manifest.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(f"missing corpus manifest: {manifest_path}")
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes.decode("utf-8"))
        if manifest.get("kind") != kind or not isinstance(manifest.get("files"), list):
            raise ValueError(f"invalid {kind} corpus manifest")
        verified: list[dict[str, Any]] = []
        for item in manifest["files"]:
            relative = str(item.get("path") or "")
            dataset = Path(relative).parent.name
            if families and dataset.upper() not in families:
                continue
            path = (base / relative).resolve()
            try:
                path.relative_to(base)
            except ValueError as error:
                raise ValueError(f"manifest path leaves corpus root: {relative}") from error
            expected_size = int(item.get("size") or -1)
            expected_hash = str(item.get("sha256") or "").lower()
            if not path.is_file() or path.stat().st_size != expected_size:
                raise ValueError(f"corpus file size mismatch: {path}")
            actual_hash = sha256_file(path)
            if actual_hash != expected_hash:
                raise ValueError(f"corpus file hash mismatch: {path}")
            verified.append(
                {
                    "path": relative.replace("\\", "/"),
                    "size": expected_size,
                    "sha256": expected_hash,
                }
            )
            selected.append((kind, path, relative.replace("\\", "/")))
        if not verified:
            raise ValueError(f"no selected {kind} corpus files")
        receipts.append(
            {
                "kind": kind,
                "repository": manifest.get("repository"),
                "revision": manifest.get("revision"),
                "version": manifest.get("version"),
                "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                "selected_files": verified,
                "selected_bytes": sum(item["size"] for item in verified),
                "all_manifest_files": len(manifest["files"]),
            }
        )
    return receipts, selected


def corpus_shards(
    files: list[tuple[str, Path, str]], languages: list[str]
) -> list[Shard]:
    import pyarrow.parquet as pq

    shards: list[Shard] = []
    for kind, path, relative in files:
        rows = pq.ParquetFile(path).metadata.num_rows
        dataset = path.parent.name
        source_id = f"{kind}/{relative}"
        for language in languages:
            for start in range(0, rows, SHARD_ROWS):
                shards.append(
                    (
                        kind,
                        str(path),
                        source_id,
                        dataset,
                        language,
                        start,
                        min(start + SHARD_ROWS, rows),
                    )
                )
    return shards


def init_worker(reference_module: str) -> None:
    global _REFERENCE
    spec = importlib.util.spec_from_file_location(
        "_beaver_alr_a2aj_structure", reference_module
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load ALR a2aj_structure reference")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _REFERENCE = module


def worker_connection() -> Any:
    global _WORKER_CON
    if _WORKER_CON is None:
        import duckdb

        _WORKER_CON = duckdb.connect()
        _WORKER_CON.execute("set threads=1")
    return _WORKER_CON


def language_value(english: Any, french: Any, language: str) -> str:
    primary, secondary = (
        (english, french) if language == "en" else (french, english)
    )
    return str(primary or secondary or "")


def provider_labels(raw: Any) -> tuple[str, set[str]]:
    if raw is None or raw == "":
        return "missing", set()
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return "malformed", set()
    if not isinstance(parsed, dict) or any(
        not isinstance(text, str) for text in parsed.values()
    ):
        return "malformed", set()
    labels = {
        f"sec{str(label).strip()}"
        for label, text in parsed.items()
        if (
            str(label).strip()
            and text.strip()
            and text.strip().casefold() != "[blank]"
        )
    }
    if not labels:
        return "empty", labels
    if len(labels) == 1 and next(iter(labels))[3:].casefold() in {
        "order",
        "ordonnance",
        "proclamation",
    }:
        return "pseudo_instrument", labels
    return "usable", labels


def block_hash(items: list[Block]) -> str:
    return hashlib.sha256(canonical(items)).hexdigest()


def block_preview(items: list[Block]) -> list[Block | tuple[str, int, int]]:
    if len(items) <= 6:
        return items
    return [*items[:3], ("...", len(items) - 6, -1), *items[-3:]]


def first_difference(
    reference: list[Block], actual: list[Block]
) -> dict[str, Any] | None:
    for index in range(max(len(reference), len(actual))):
        expected = reference[index] if index < len(reference) else None
        found = actual[index] if index < len(actual) else None
        if expected != found:
            return {"index": index, "reference": expected, "actual": found}
    return None


def diagnostic_rank(diagnostic: dict[str, Any]) -> str:
    priority = "0" if diagnostic["outcome"] in {"lost", "changed"} else "1"
    digest = hashlib.sha256(
        f"{diagnostic['id']}\0{diagnostic['kind']}\0{diagnostic['outcome']}".encode(
            "utf-8"
        )
    ).hexdigest()
    return priority + digest


def retain_diagnostic(
    diagnostics: list[tuple[str, dict[str, Any]]],
    diagnostic: dict[str, Any],
) -> None:
    score = diagnostic_rank(diagnostic)
    diagnostics.append((score, diagnostic))
    diagnostics.sort(key=lambda item: item[0])
    del diagnostics[DIAGNOSTIC_CAP_PER_SHARD:]


def record_provider_overlap(
    totals: dict[str, Counter[str]],
    bucket: str,
    status: str,
    expected: set[str],
    reference: set[str],
    physical: set[str],
    with_aliases: set[str],
) -> None:
    values = totals.setdefault(bucket, Counter())
    values["maps"] += 1
    values[f"map_{status}_documents"] += 1
    if status != "usable":
        return
    values["documents"] += 1
    values["labels"] += len(expected)
    for lane, found in (
        ("alr", reference),
        ("current_physical", physical),
        ("current_with_aliases", with_aliases),
    ):
        hits = len(expected & found)
        values[f"{lane}_hits"] += hits
        values[f"{lane}_found"] += len(found)
        values[f"{lane}_complete_documents"] += hits == len(expected)


def scan_full_shard(shard: Shard) -> dict[str, Any]:
    kind, path_text, source_id, dataset, language, start, stop = shard
    con = worker_connection()
    escaped_path = path_text.replace("'", "''")
    if kind == "cases":
        query = f"""
            select citation_en, citation_fr, citation2_en, citation2_fr,
                   unofficial_text_{language}
            from read_parquet('{escaped_path}')
            limit {stop - start} offset {start}
        """
    else:
        query = f"""
            select citation_en, citation_fr, citation2_en, citation2_fr,
                   name_en, name_fr, unofficial_text_{language},
                   unofficial_sections_{language}
            from read_parquet('{escaped_path}')
            limit {stop - start} offset {start}
        """

    shard_id = f"{source_id}:{language}:{start}-{stop}"
    comparison_digest = hashlib.sha256()
    outcomes: Counter[str] = Counter()
    provider: dict[str, Counter[str]] = {}
    diagnostics: list[tuple[str, dict[str, Any]]] = []
    documents = skipped_empty = chars = utf16_chars = errors = 0
    reference_seconds = shipping_seconds = shipping_internal_ms = 0.0
    row_index = start
    rows = con.execute(query)
    while True:
        batch = rows.fetchmany(100)
        if not batch:
            break
        for row in batch:
            physical_row = row_index
            row_index += 1
            text = row[4] if kind == "cases" else row[6]
            if not isinstance(text, str) or not text or text.isspace():
                skipped_empty += 1
                continue
            document_id = f"{source_id}#row={physical_row}&lang={language}"
            citation = language_value(row[0], row[1], language)
            alternate = language_value(row[2], row[3], language)
            if not citation:
                citation = alternate
            name = (
                language_value(row[4], row[5], language)
                if kind == "laws"
                else ""
            )
            astral_positions, text_length = utf16_offsets(text)
            documents += 1
            chars += len(text)
            utf16_chars += text_length
            kinds = ("paragraph", "page") if kind == "cases" else ("section",)
            references: dict[str, list[Block]] = {item: [] for item in kinds}
            actuals: dict[str, list[Block]] = {item: [] for item in kinds}
            response: dict[str, Any] | None = None
            issue: str | None = None
            try:
                reference_started = time.perf_counter()
                if kind == "cases":
                    paragraphs = _REFERENCE.paragraph_index(text)
                    report_start = _REFERENCE.reporter_start_page(
                        citation, alternate
                    )
                    pages = _REFERENCE.page_structure(
                        text,
                        report_start,
                        require_report_start=dataset.upper() == "SCC",
                    )
                    references["paragraph"] = reference_blocks(
                        paragraphs, "par", astral_positions
                    )
                    references["page"] = reference_blocks(
                        pages, "page", astral_positions
                    )
                else:
                    sections = _REFERENCE.section_structure(
                        text,
                        allow_hyphen=_REFERENCE.allows_hyphenated_provisions(name),
                    )
                    references["section"] = reference_blocks(
                        sections, "sec", astral_positions
                    )
                reference_seconds += time.perf_counter() - reference_started

                shipping_started = time.perf_counter()
                response = compile_document(
                    {
                        "id": document_id,
                        "docType": kind,
                        "citation": citation,
                        "alternateCitation": alternate,
                        "dataset": dataset,
                        "name": name,
                        "text": text,
                    }
                )
                shipping_seconds += time.perf_counter() - shipping_started
                shipping_internal_ms += float(response.get("elapsedMs") or 0)
                for block_kind in kinds:
                    actuals[block_kind] = [
                        (
                            str(block["label"]),
                            int(block["start"]),
                            int(block["end"]),
                        )
                        for block in response["blocks"][block_kind]
                    ]
            except Exception as error:  # fail closed but finish the receipt
                errors += 1
                issue = f"{type(error).__name__}: {error}"[:300]
                response = None
            finally:
                _REFERENCE.paragraph_index.cache_clear()
                _REFERENCE.page_structure.cache_clear()
                _REFERENCE.section_structure.cache_clear()

            for block_kind in kinds:
                reference = references[block_kind]
                actual = actuals[block_kind]
                outcome = (
                    "changed"
                    if issue
                    else classify(block_kind, reference, actual, text_length)
                )
                outcomes[f"{dataset}\t{language}\t{block_kind}\t{outcome}"] += 1
                comparison = {
                    "id": document_id,
                    "kind": block_kind,
                    "outcome": outcome,
                    "reference_count": len(reference),
                    "actual_count": len(actual),
                    "reference_sha256": block_hash(reference),
                    "actual_sha256": block_hash(actual),
                    "issue": issue,
                }
                comparison_digest.update(canonical(comparison))
                comparison_digest.update(b"\n")
                if outcome != "exact":
                    retain_diagnostic(
                        diagnostics,
                        {
                            **comparison,
                            "dataset": dataset,
                            "language": language,
                            "citation": citation,
                            "first_difference": first_difference(reference, actual),
                            "reference": block_preview(reference),
                            "actual": block_preview(actual),
                        },
                    )

            if kind == "laws":
                map_status, expected = provider_labels(row[7])
                blocks = response["blocks"]["section"] if response else []
                physical = {str(block["label"]) for block in blocks}
                with_aliases = {
                    label
                    for block in blocks
                    for label in [
                        str(block["label"]),
                        *(str(alias) for alias in block.get("aliases", [])),
                    ]
                }
                record_provider_overlap(
                    provider,
                    f"{dataset}\t{language}",
                    map_status,
                    expected,
                    {label for label, _start, _end in references["section"]},
                    physical,
                    with_aliases,
                )

    if row_index != stop:
        raise RuntimeError(f"short parquet shard read: {shard_id}")
    return {
        "id": shard_id,
        "documents": documents,
        "skipped_empty": skipped_empty,
        "chars": chars,
        "utf16_chars": utf16_chars,
        "errors": errors,
        "reference_seconds": reference_seconds,
        "shipping_seconds": shipping_seconds,
        "shipping_internal_ms": shipping_internal_ms,
        "outcomes": dict(outcomes),
        "provider": {key: dict(value) for key, value in provider.items()},
        "comparison_sha256": comparison_digest.hexdigest(),
        "diagnostics": [item for _score, item in diagnostics],
    }


def below_normal_priority() -> None:
    if sys.platform == "win32":
        kernel32 = ctypes.windll.kernel32
        kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000)


def command_version(*command: str) -> str | None:
    try:
        return subprocess.run(
            list(command),
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def shipping_sources() -> dict[str, str]:
    paths = [
        "backend/scripts/skeleton-oracle-probe.py",
        "backend/scripts/sourcedoc_client.py",
        "backend/scripts/sourcedoc-jsonl.ts",
        "backend/src/lib/sourceDocA2AJ.ts",
        "backend/src/lib/sourceDoc.ts",
        "backend/src/lib/statuteSpine.ts",
        "backend/src/lib/text.ts",
        "backend/package.json",
        "backend/package-lock.json",
        "backend/tsconfig.json",
    ]
    return {
        relative: sha256_file(FORK / relative)
        for relative in paths
        if (FORK / relative).is_file()
    }


def outcome_receipt(outcomes: Counter[str]) -> dict[str, Any]:
    rows = []
    totals = Counter()
    for key, count in sorted(outcomes.items()):
        dataset, language, kind, outcome = key.split("\t")
        rows.append(
            {
                "dataset": dataset,
                "language": language,
                "kind": kind,
                "outcome": outcome,
                "count": count,
            }
        )
        totals[outcome] += count
    return {
        "totals": {outcome: totals[outcome] for outcome in OUTCOMES},
        "by_dataset_language_kind": rows,
    }


def provider_receipt(provider: dict[str, Counter[str]]) -> dict[str, Any]:
    total = Counter()
    rows = []
    for key, values in sorted(provider.items()):
        dataset, language = key.split("\t")
        total.update(values)
        labels = values["labels"]
        row: dict[str, Any] = {
            "dataset": dataset,
            "language": language,
            **dict(values),
        }
        for lane in ("alr", "current_physical", "current_with_aliases"):
            hits = values[f"{lane}_hits"]
            found = values[f"{lane}_found"]
            recall = hits / labels if labels else None
            precision = hits / found if found else None
            row[f"{lane}_recall"] = (
                round(recall, 6) if recall is not None else None
            )
            row[f"{lane}_overlap_precision"] = (
                round(precision, 6) if precision is not None else None
            )
            row[f"{lane}_overlap_f1"] = (
                round(2 * recall * precision / (recall + precision), 6)
                if recall is not None and precision is not None and recall + precision
                else None
            )
        rows.append(row)
    labels = total["labels"]
    aggregate: dict[str, Any] = dict(total)
    for lane in ("alr", "current_physical", "current_with_aliases"):
        hits = total[f"{lane}_hits"]
        found = total[f"{lane}_found"]
        recall = hits / labels if labels else None
        precision = hits / found if found else None
        aggregate[f"{lane}_recall"] = (
            round(recall, 6) if recall is not None else None
        )
        aggregate[f"{lane}_overlap_precision"] = (
            round(precision, 6) if precision is not None else None
        )
        aggregate[f"{lane}_overlap_f1"] = (
            round(2 * recall * precision / (recall + precision), 6)
            if recall is not None and precision is not None and recall + precision
            else None
        )
    return {"total": aggregate, "by_dataset_language": rows}


def run_full(
    *,
    root: Path,
    reference_root: Path,
    receipt_path: Path,
    kinds: set[str],
    families: set[str],
    languages: list[str],
    workers: int,
) -> int:
    below_normal_priority()
    started_at = datetime.now(timezone.utc)
    started = time.perf_counter()
    reference_module = (
        reference_root.resolve() / "verifier_core" / "a2aj_structure.py"
    )
    if not reference_module.is_file():
        raise FileNotFoundError(f"missing ALR reference module: {reference_module}")

    corpus, files = verified_corpus(root, kinds, families)
    shards = corpus_shards(files, languages)
    if not shards:
        raise ValueError("no corpus shards selected")
    sources_before = shipping_sources()
    reference_hash = sha256_file(reference_module)
    reference_head = git_head(reference_root.resolve())

    partials: list[dict[str, Any]] = []
    context = mp.get_context("spawn")
    worker_count = min(max(1, workers), len(shards))
    with context.Pool(
        worker_count,
        initializer=init_worker,
        initargs=(str(reference_module),),
    ) as pool:
        for index, partial in enumerate(
            pool.imap_unordered(scan_full_shard, shards, chunksize=1),
            start=1,
        ):
            partials.append(partial)
            print(
                f"reference shard {index}/{len(shards)} "
                f"docs={sum(item['documents'] for item in partials)}",
                flush=True,
            )

    partials.sort(key=lambda item: item["id"])
    outcomes: Counter[str] = Counter()
    provider: dict[str, Counter[str]] = {}
    diagnostics: list[dict[str, Any]] = []
    root_digest = hashlib.sha256()
    for partial in partials:
        outcomes.update(partial["outcomes"])
        for key, values in partial["provider"].items():
            provider.setdefault(key, Counter()).update(values)
        diagnostics.extend(partial["diagnostics"])
        root_digest.update(
            canonical(
                {
                    key: partial[key]
                    for key in (
                        "id",
                        "documents",
                        "skipped_empty",
                        "chars",
                        "utf16_chars",
                        "errors",
                        "comparison_sha256",
                    )
                }
            )
        )
        root_digest.update(b"\n")
    diagnostics.sort(key=diagnostic_rank)
    diagnostics = diagnostics[:DIAGNOSTIC_CAP_TOTAL]

    corpus_after, files_after = verified_corpus(root, kinds, families)
    corpus_unchanged = corpus_after == corpus and [
        (kind, str(path.resolve()), relative)
        for kind, path, relative in files_after
    ] == [
        (kind, str(path.resolve()), relative)
        for kind, path, relative in files
    ]
    sources_after = shipping_sources()
    reference_hash_after = sha256_file(reference_module)
    source_changed = (
        sources_before != sources_after or reference_hash != reference_hash_after
    )
    errors = sum(item["errors"] for item in partials)
    outcome_summary = outcome_receipt(outcomes)
    provider_summary = provider_receipt(provider)
    policy_failed = bool(
        outcome_summary["totals"]["lost"]
        or outcome_summary["totals"]["changed"]
        or provider_summary["total"].get("map_malformed_documents", 0)
        or source_changed
        or not corpus_unchanged
    )
    finished_at = datetime.now(timezone.utc)
    import duckdb
    import pyarrow

    tsx_package = json.loads(
        (FORK / "backend" / "node_modules" / "tsx" / "package.json").read_text(
            encoding="utf-8"
        )
    )
    receipt = {
        "schema": "beaver.sourcedoc.reference-receipt.v1",
        "status": "failed" if policy_failed else "complete",
        "reference_role": "compatibility_floor_not_gold",
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "scope": {
            "kinds": sorted(kinds),
            "languages": languages,
            "families": sorted(families),
            "workers": worker_count,
            "shard_rows": SHARD_ROWS,
        },
        "corpus": corpus,
        "corpus_unchanged_during_run": corpus_unchanged,
        "reference": {
            "root": str(reference_root.resolve()),
            "git_head": reference_head,
            "module": str(reference_module),
            "module_sha256": reference_hash,
            "unchanged_during_run": reference_hash == reference_hash_after,
        },
        "shipping": {
            "git_head": git_head(FORK),
            "source_sha256": sources_before,
            "unchanged_during_run": sources_before == sources_after,
        },
        "runtime": {
            "python": sys.version,
            "node": command_version("node", "--version"),
            "tsx": tsx_package.get("version"),
            "duckdb": duckdb.__version__,
            "pyarrow": pyarrow.__version__,
        },
        "totals": {
            "documents": sum(item["documents"] for item in partials),
            "skipped_empty": sum(item["skipped_empty"] for item in partials),
            "chars": sum(item["chars"] for item in partials),
            "utf16_chars": sum(item["utf16_chars"] for item in partials),
            "errors": errors,
            "reference_seconds": round(
                sum(item["reference_seconds"] for item in partials), 3
            ),
            "shipping_seconds": round(
                sum(item["shipping_seconds"] for item in partials), 3
            ),
            "shipping_internal_ms": round(
                sum(item["shipping_internal_ms"] for item in partials), 3
            ),
        },
        "outcomes": outcome_summary,
        "provider_map_overlap": provider_summary,
        "root_comparison_sha256": root_digest.hexdigest(),
        "shards": [
            {
                key: partial[key]
                for key in (
                    "id",
                    "documents",
                    "skipped_empty",
                    "chars",
                    "utf16_chars",
                    "errors",
                    "comparison_sha256",
                )
            }
            for partial in partials
        ],
        "diagnostics": diagnostics,
    }
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = receipt_path.with_name(f"{receipt_path.name}.tmp")
    temporary.write_text(
        json.dumps(receipt, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(receipt_path)
    print(
        f"wrote {receipt_path} "
        f"sha256={sha256_file(receipt_path)} status={receipt['status']}",
        flush=True,
    )
    return 1 if policy_failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    default_corpus = (
        Path(os.environ["LOCALAPPDATA"]) / "ALR Quote Verifier" / "a2aj_corpus"
        if os.environ.get("LOCALAPPDATA")
        else Path()
    )
    parser.add_argument("--root", type=Path, default=default_corpus)
    parser.add_argument(
        "--reference-root",
        type=Path,
        default=Path(os.environ.get("ALR_QUOTE_VERIFIER_ROOT", "")),
    )
    parser.add_argument("--out", type=Path)
    parser.add_argument("--full-receipt", type=Path)
    parser.add_argument("--kinds", default="cases,laws")
    parser.add_argument("--families", default="")
    parser.add_argument("--langs", default="en,fr")
    parser.add_argument("--workers", type=int, default=max(1, mp.cpu_count() - 2))
    parser.add_argument("--per-dataset", type=int, default=8)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        print("classification and UTF-16 self-test passed")
        return 0
    if not args.reference_root or not (args.reference_root / "verifier_core").is_dir():
        parser.error("--reference-root must point to ALR-Quote-Verifier")
    if not args.root.is_dir():
        parser.error(f"corpus root does not exist: {args.root}")
    if args.per_dataset < 1:
        parser.error("--per-dataset must be positive")
    if args.workers < 1:
        parser.error("--workers must be positive")

    kinds = {item.strip() for item in args.kinds.split(",") if item.strip()}
    if not kinds or kinds - {"cases", "laws"}:
        parser.error("--kinds must contain cases, laws, or both")
    families = {
        item.strip().upper() for item in args.families.split(",") if item.strip()
    }
    languages = [item.strip() for item in args.langs.split(",") if item.strip()]
    if not languages or set(languages) - {"en", "fr"}:
        parser.error("--langs must contain en, fr, or both")
    if args.full_receipt:
        if args.out:
            parser.error("--out and --full-receipt are mutually exclusive")
        return run_full(
            root=args.root,
            reference_root=args.reference_root,
            receipt_path=args.full_receipt,
            kinds=kinds,
            families=families,
            languages=languages,
            workers=args.workers,
        )
    if not args.out:
        parser.error("--out is required unless --full-receipt is used")

    init_worker(
        str(
            args.reference_root.resolve()
            / "verifier_core"
            / "a2aj_structure.py"
        )
    )
    a2aj_structure = _REFERENCE
    paths = corpus_paths(args.root, kinds, families)
    if not paths:
        parser.error("no matching */train.parquet datasets")

    totals = {"cases": 0, "laws": 0}
    with args.out.open("w", encoding="utf-8") as out:
        for kind, path in paths:
            schema = set(path_name for path_name in __import__(
                "pyarrow.parquet", fromlist=["ParquetFile"]
            ).ParquetFile(path).schema.names)
            wanted = [
                field
                for field in (
                    "dataset",
                    "citation_en",
                    "citation_fr",
                    "citation2_en",
                    "citation2_fr",
                    "name_en",
                    "name_fr",
                    "unofficial_text_en",
                    "unofficial_text_fr",
                    "unofficial_sections_en",
                    "unofficial_sections_fr",
                )
                if field in schema
            ]
            rows = sample_rows(path, wanted, args.per_dataset)
            dataset = path.parent.name
            written = 0
            for row in rows:
                dataset = str(row.get("dataset") or dataset)
                for language in languages:
                    text = value(row, "unofficial_text", language, fallback=False)
                    if not text.strip():
                        continue
                    astral_positions, text_length = utf16_offsets(text)
                    citation = (
                        value(row, "citation", language)
                        or value(row, "citation2", language)
                    )
                    alternate = value(row, "citation2", language)
                    name = value(row, "name", language)
                    section_map = None
                    raw_sections = value(row, "unofficial_sections", language)
                    if raw_sections:
                        try:
                            parsed = json.loads(raw_sections)
                            if isinstance(parsed, dict) and all(
                                isinstance(item, str) for item in parsed.values()
                            ):
                                section_map = parsed
                        except json.JSONDecodeError:
                            pass
                    reference = {"paragraph": [], "page": [], "section": []}
                    reference_source = "alr_compatibility"
                    if kind == "cases":
                        paragraphs = a2aj_structure.paragraph_index(text)
                        report_start = a2aj_structure.reporter_start_page(
                            citation, alternate
                        )
                        pages = a2aj_structure.page_structure(
                            text,
                            report_start,
                            require_report_start=dataset.upper() == "SCC",
                        )
                        reference["paragraph"] = blocks(
                            paragraphs, "par", astral_positions
                        )
                        reference["page"] = blocks(
                            pages, "page", astral_positions
                        )
                    else:
                        sections = a2aj_structure.section_structure(
                            text,
                            allow_hyphen=a2aj_structure.allows_hyphenated_provisions(
                                name
                            ),
                        )
                        reference["section"] = blocks(
                            sections, "sec", astral_positions
                        )
                    out.write(
                        json.dumps(
                            {
                                "sourceKind": "case" if kind == "cases" else "law",
                                "dataset": dataset,
                                "language": language,
                                "citation": citation,
                                "alternateCitation": alternate,
                                "name": name,
                                "chars": text_length,
                                "sectionMap": section_map,
                                "referenceSource": reference_source,
                                "reference": reference,
                                "text": text,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    totals[kind] += 1
                    written += 1
                    a2aj_structure.paragraph_index.cache_clear()
                    a2aj_structure.page_structure.cache_clear()
                    a2aj_structure.section_structure.cache_clear()
            print(f"{kind}/{dataset}: {written} texts", flush=True)
    print(
        f"wrote {totals['cases']} case and {totals['laws']} law texts to {args.out}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
