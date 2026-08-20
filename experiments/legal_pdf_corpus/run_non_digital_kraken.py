#!/usr/bin/env python3
"""Resumable runner for Kraken-lite OCR over every accepted non-digital PDF."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any


REQUEST_SCHEMA = "legalpdf.document-request.v1"
RECEIPT_SCHEMA = "legalpdf.non-digital-kraken-receipt.v2"
RUN_SCHEMA = "legalpdf.non-digital-kraken-run.v2"
RUNNER_CONTRACT = "750-non-digital-anti-cheat-v2"
FLOAT_DIAGNOSTIC_ABS_TOLERANCE = 1e-8


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(temporary, path)


def accepted_non_digital(corpus_root: Path) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    with (corpus_root / "ledger.jsonl").open(encoding="utf-8") as source:
        for line in source:
            row = json.loads(line)
            key = row.get("candidate_id") or row.get("relative_path") or row.get("url")
            latest[str(key)] = row
    rows = [
        row
        for row in latest.values()
        if row.get("status") == "accepted" and row.get("generation") == "non_digital"
    ]
    rows.sort(key=lambda row: (int(row["page_count"]), str(row["candidate_id"])))
    if len(rows) != 750 or len({row["candidate_id"] for row in rows}) != 750:
        raise RuntimeError(f"expected 750 unique accepted non_digital rows, found {len(rows)}")
    missing = [row["relative_path"] for row in rows if not (corpus_root / row["relative_path"]).is_file()]
    if missing:
        raise RuntimeError(f"{len(missing)} accepted PDFs are missing; first: {missing[0]}")
    return rows


def run_contract(
    binary: Path, request: Path, timeout: int, cache_max_bytes: int
) -> tuple[dict[str, Any], float]:
    started = time.monotonic()
    environment = os.environ.copy()
    environment["LEGALPDF_CACHE_MAX_BYTES"] = str(cache_max_bytes)
    process = subprocess.run(
        [str(binary), "contract", str(request)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        creationflags=getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0),
        env=environment,
    )
    elapsed = time.monotonic() - started
    if process.returncode:
        raise RuntimeError(process.stderr[-20_000:] or f"legalpdf exited {process.returncode}")
    return json.loads(process.stdout), elapsed


def gunzip_bytes(path: Path) -> bytes:
    with gzip.open(path, "rb") as source:
        return source.read()


def first_difference(left: Any, right: Any, path: str = "$") -> str:
    if type(left) is not type(right):
        return f"{path}: {type(left).__name__} != {type(right).__name__}"
    if isinstance(left, dict):
        if left.keys() != right.keys():
            return f"{path}: keys differ"
        for key in left:
            if left[key] != right[key]:
                return first_difference(left[key], right[key], f"{path}.{key}")
    elif isinstance(left, list):
        if len(left) != len(right):
            return f"{path}: lengths {len(left)} != {len(right)}"
        for index, (left_item, right_item) in enumerate(zip(left, right, strict=True)):
            if left_item != right_item:
                return first_difference(left_item, right_item, f"{path}[{index}]")
    return f"{path}: {left!r} != {right!r}"


def first_difference_outside_float_tolerance(
    left: Any,
    right: Any,
    path: str = "$",
    tolerance: float = FLOAT_DIAGNOSTIC_ABS_TOLERANCE,
) -> str | None:
    """Diagnose tiny JSON float drift without weakening exact replay parity."""
    if type(left) is not type(right):
        return f"{path}: {type(left).__name__} != {type(right).__name__}"
    if isinstance(left, float):
        return None if abs(left - right) <= tolerance else f"{path}: {left!r} != {right!r}"
    if isinstance(left, dict):
        if left.keys() != right.keys():
            return f"{path}: keys differ"
        for key in left:
            difference = first_difference_outside_float_tolerance(
                left[key], right[key], f"{path}.{key}", tolerance
            )
            if difference is not None:
                return difference
        return None
    if isinstance(left, list):
        if len(left) != len(right):
            return f"{path}: lengths {len(left)} != {len(right)}"
        for index, (left_item, right_item) in enumerate(zip(left, right, strict=True)):
            difference = first_difference_outside_float_tolerance(
                left_item, right_item, f"{path}[{index}]", tolerance
            )
            if difference is not None:
                return difference
        return None
    return None if left == right else f"{path}: {left!r} != {right!r}"


def runtime_manifest(arguments: argparse.Namespace) -> dict[str, Any]:
    assets = {
        "binary": arguments.binary.resolve(),
        "model": arguments.model.resolve(),
        "codec": arguments.codec.resolve(),
        "runtime": arguments.runtime.resolve(),
        "layout": arguments.layout.resolve(),
    }
    for name, path in assets.items():
        if not path.is_file():
            raise RuntimeError(f"missing {name}: {path}")
    hashes = {name: sha256(path) for name, path in assets.items()}
    cpu_fallback = arguments.backend != "cpu"
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "hashes": hashes,
                "tier": arguments.tier,
                "backend": arguments.backend,
                "device": arguments.device,
                "cpu_fallback": cpu_fallback,
                "runner_contract": RUNNER_CONTRACT,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    device = "default" if arguments.backend == "cpu" else arguments.device
    fallback = "cpu" if cpu_fallback else "none"
    ocr_identity = (
        f"kraken-lite-rust-v2:backend={arguments.backend}:device={device}:fallback={fallback}:"
        f"model={hashes['model']}:codec={hashes['codec']}:"
        f"runtime={hashes['runtime']}:layout={hashes['layout']}"
    )
    return {
        "fingerprint": fingerprint,
        "runner_contract": RUNNER_CONTRACT,
        "ocr_identity": ocr_identity,
        "tier": arguments.tier,
        "backend": arguments.backend,
        "device": arguments.device,
        "cpu_fallback": cpu_fallback,
        "assets": {
            name: {"path": str(path), "bytes": path.stat().st_size, "sha256": hashes[name]}
            for name, path in assets.items()
        },
    }


def request_for(
    row: dict[str, Any],
    arguments: argparse.Namespace,
    output: Path,
    runtime: dict[str, Any],
) -> dict[str, Any]:
    settings: dict[str, Any] = {
        "model": str(arguments.model.resolve()),
        "codec": str(arguments.codec.resolve()),
        "runtime": str(arguments.runtime.resolve()),
        "tesseract_library": str(arguments.layout.resolve()),
        "tier": arguments.tier,
        "backend": arguments.backend,
        "expected_identity": runtime["ocr_identity"],
    }
    if arguments.backend != "cpu":
        settings["device"] = arguments.device
        settings["cpu_fallback"] = True
    return {
        "schema_version": REQUEST_SCHEMA,
        "operation": "prepare",
        "source_pdf": str((arguments.corpus_root / row["relative_path"]).resolve()),
        "cache_dir": str((output / "cache").resolve()),
        "ocr": {"provider": "kraken-lite", "settings": settings},
    }


def summary(output: Path, rows: list[dict[str, Any]], runtime: dict[str, Any], started: float) -> dict[str, Any]:
    receipts = []
    receipt_errors = []
    expected = {str(row["candidate_id"]): row for row in rows}
    seen = set()
    for path in (output / "receipts").glob("*.json"):
        try:
            receipt = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            receipt_errors.append(f"{path.name}: unreadable receipt: {error}")
            continue
        candidate = str(receipt.get("candidate_id", ""))
        if candidate != path.stem or candidate not in expected:
            receipt_errors.append(f"{path.name}: unexpected candidate {candidate!r}")
            continue
        if candidate in seen:
            receipt_errors.append(f"{path.name}: duplicate candidate")
            continue
        seen.add(candidate)
        if receipt.get("runtime_fingerprint") != runtime["fingerprint"]:
            receipt_errors.append(f"{path.name}: runtime fingerprint mismatch")
            continue
        receipts.append(receipt)
    receipt_passed = [
        receipt for receipt in receipts if receipt.get("outcome") == "passed"
    ]
    complete = [
        receipt
        for receipt in receipt_passed
        if receipt.get("byte_identical_structure_replay") is True
    ]
    strict_replay_failures = [
        receipt
        for receipt in receipt_passed
        if receipt.get("byte_identical_structure_replay") is not True
    ]
    failed = [
        receipt for receipt in receipts if receipt.get("outcome") == "failed"
    ] + strict_replay_failures
    materialized = [
        receipt
        for receipt in receipts
        if all(
            key in receipt
            for key in (
                "source",
                "counts",
                "document_json_sha256",
                "ocr_routed_pages",
                "ocr_output_pages",
                "unresolved_pages_after_ocr",
            )
        )
    ]
    for receipt in materialized:
        row = expected[receipt["candidate_id"]]
        pages = int(row["page_count"])
        source = receipt.get("source")
        if (
            not isinstance(source, dict)
            or receipt.get("physical_pages") != pages
            or source.get("sha256") != row["sha256"]
            or source.get("page_count") != pages
            or receipt.get("ocr_provider_identity") != runtime["ocr_identity"]
        ):
            receipt_errors.append(f"{receipt['candidate_id']}: source/runtime identity mismatch")
            continue
        partitions = [
            receipt.get(key, [])
            for key in ("ocr_routed_pages", "ocr_output_pages", "unresolved_pages_after_ocr")
        ]
        if any(
            not isinstance(values, list)
            or any(type(page) is not int or page < 1 or page > pages for page in values)
            or values != sorted(set(values))
            for values in partitions
        ):
            receipt_errors.append(f"{receipt['candidate_id']}: invalid page partition")
            continue
        routed, emitted, unresolved = map(set, partitions)
        if emitted & unresolved or emitted | unresolved != routed:
            receipt_errors.append(f"{receipt['candidate_id']}: OCR partition is not exact")
    timed = [
        receipt
        for receipt in materialized
        if receipt.get("timing_exact") is not False
        and isinstance(receipt.get("ocr_plus_structure_seconds"), (int, float))
        and isinstance(receipt.get("structure_replay_seconds"), (int, float))
    ]
    physical_pages = sum(int(row["physical_pages"]) for row in materialized)
    routed_pages = sum(len(row["ocr_routed_pages"]) for row in materialized)
    output_pages = sum(len(row.get("ocr_output_pages", [])) for row in materialized)
    unresolved_pages = sum(
        len(row.get("unresolved_pages_after_ocr", [])) for row in materialized
    )
    first_seconds = sum(float(row["ocr_plus_structure_seconds"]) for row in timed)
    replay_seconds = sum(float(row["structure_replay_seconds"]) for row in timed)
    estimated_ocr_seconds = sum(float(row["estimated_ocr_seconds"]) for row in timed)
    accounted = len(complete) + len(failed)
    resume_path = output / "resume.json"
    resume = (
        json.loads(resume_path.read_text(encoding="utf-8"))
        if resume_path.is_file()
        else {}
    )
    wall = time.monotonic() - started
    prior_wall = float(resume.get("prior_active_wall_seconds", 0.0))
    unknown_wall = float(resume.get("unknown_interval_seconds", 0.0))
    return {
        "schema_version": RUN_SCHEMA,
        "runtime": runtime,
        "corpus": {
            "documents": len(rows),
            "pages": sum(int(row["page_count"]) for row in rows),
            "bytes": sum(int(row["bytes"]) for row in rows),
        },
        "progress": {
            "receipts": len(receipts),
            "passed": len(complete),
            "failed": len(failed),
            "documents_accounted": accounted,
            "corpus_accounted": accounted == len(rows) and not receipt_errors,
            "corpus_complete": len(complete) == len(rows) and not failed,
            "documents_materialized": len(materialized),
            "corpus_materialized": len(materialized) == len(rows) and not receipt_errors,
            "physical_pages_materialized": physical_pages,
            "physical_pages_passed": sum(
                int(row["physical_pages"]) for row in complete
            ),
            "ocr_pages_routed": routed_pages,
            "ocr_output_pages": output_pages,
            "unresolved_pages_after_ocr": unresolved_pages,
            "pages_needing_ocr": sum(
                len(row["pages_needing_ocr"]) for row in materialized
            ),
            "timing_exact_documents": len(timed),
            "timing_excluded_documents": len(materialized) - len(timed),
            "ocr_plus_structure_seconds": round(first_seconds, 6),
            "routing_inspection_seconds": round(
                sum(float(row["routing_inspection_seconds"]) for row in timed), 6
            ),
            "structure_replay_seconds": round(replay_seconds, 6),
            "estimated_ocr_seconds": round(estimated_ocr_seconds, 6),
            "product_pages_per_second": round(physical_pages / first_seconds, 6) if first_seconds else None,
            "estimated_ocr_output_pages_per_second": (
                round(output_pages / estimated_ocr_seconds, 6)
                if estimated_ocr_seconds
                else None
            ),
            "structure_replay_pages_per_second": (
                round(physical_pages / replay_seconds, 6) if replay_seconds else None
            ),
            "raw_replay_drift_documents": sum(
                row.get("byte_identical_structure_replay") is False
                for row in receipts
            ),
            "raw_replay_drift_failures": sum(
                row.get("byte_identical_structure_replay") is False for row in failed
            ),
            "semantic_replay_drift_failures": sum(
                row.get("structure_replay_semantically_equivalent_within_tolerance")
                is False
                for row in failed
            ),
            "execution_provider_observed_documents": sum(
                bool(row.get("ocr_execution_provider")) for row in materialized
            ),
            "execution_provider_unproven_documents": sum(
                not row.get("ocr_execution_provider") for row in materialized
            ),
            "wall_seconds_this_invocation": round(wall, 6),
            "wall_seconds_prior_invocations": round(prior_wall, 6),
            "wall_seconds_unknown_intervals": round(unknown_wall, 6),
            "wall_seconds_known_active_total": round(prior_wall + wall, 6),
        },
        "failures": [
            {
                "candidate_id": row["candidate_id"],
                "error": row.get(
                    "error",
                    "receipt claimed passed without byte-identical structure replay",
                ),
            }
            for row in failed
        ],
        "receipt_verification": {
            "errors": len(receipt_errors),
            "first_errors": receipt_errors[:20],
        },
    }


def process_document(
    row: dict[str, Any], arguments: argparse.Namespace, output: Path, runtime: dict[str, Any]
) -> dict[str, Any]:
    token = str(row["candidate_id"])
    receipt_path = output / "receipts" / f"{token}.json"
    receipt = None
    if receipt_path.is_file():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if (
            receipt.get("runtime_fingerprint") == runtime["fingerprint"]
            and receipt.get("outcome") in {"passed", "failed"}
        ):
            return receipt

    request_path = output / "requests" / f"{token}.json"
    atomic_json(request_path, request_for(row, arguments, output, runtime))
    inspect_path = output / "requests" / f"{token}.inspect.json"
    atomic_json(
        inspect_path,
        {
            "schema_version": REQUEST_SCHEMA,
            "operation": "inspect",
            "source_pdf": str((arguments.corpus_root / row["relative_path"]).resolve()),
        },
    )
    first_cache_copy: Path | None = None
    document_cache: Path | None = None
    try:
        if not receipt or receipt.get("outcome") != "materialized":
            extraction_dir = output / "cache" / "parse-v1" / "extractions"
            extractions_before = {
                path.name for path in extraction_dir.glob("*.json.gz")
            }
            inspection, inspection_seconds = run_contract(
                arguments.binary.resolve(),
                inspect_path,
                arguments.timeout,
                arguments.cache_max_bytes,
            )
            first, first_seconds = run_contract(
                arguments.binary.resolve(),
                request_path,
                arguments.timeout,
                arguments.cache_max_bytes,
            )
            if first["source"]["sha256"] != row["sha256"]:
                raise RuntimeError("source SHA-256 differs from accepted ledger")
            if first["source"]["cache_hit"]:
                raise RuntimeError("first pass unexpectedly hit a document cache; use a fresh output directory")
            document_cache = output / "cache" / "parse-v1" / "documents" / f"{first['source']['cache_key']}.json.gz"
            first_document_bytes = gunzip_bytes(document_cache)
            first_document_hash = hashlib.sha256(first_document_bytes).hexdigest()
            document = json.loads(first_document_bytes)
            extractions_after = {
                path.name for path in extraction_dir.glob("*.json.gz")
            }
            new_extractions = sorted(extractions_after - extractions_before)
            if len(new_extractions) != 1:
                raise RuntimeError(
                    "first pass must create exactly one fresh extraction cache; "
                    f"created {len(new_extractions)}"
                )
            extraction_cache = extraction_dir / new_extractions[0]
            pdf_metadata = document.get("metadata", {}).get("pdf", {})
            routed_pages = [int(page) + 1 for page in pdf_metadata.get("ocr_routed_pages", [])]
            ocr_output_pages = [
                int(page["number"])
                for page in document.get("pages", [])
                if page.get("source") == "ocr"
            ]
            detector_pages = [int(page) for page in inspection["result"]["pages_needing_ocr"]]
            receipt = {
                "schema_version": RECEIPT_SCHEMA,
                "runtime_fingerprint": runtime["fingerprint"],
                "outcome": "materialized",
                "candidate_id": token,
                "relative_path": row["relative_path"],
                "physical_pages": int(row["page_count"]),
                "routing_inspection_seconds": round(inspection_seconds, 6),
                "ocr_plus_structure_seconds": round(first_seconds, 6),
                "pages_needing_ocr": detector_pages,
                "ocr_routed_pages": routed_pages,
                "ocr_output_pages": ocr_output_pages,
                "unresolved_pages_after_ocr": [
                    int(page) + 1 for page in pdf_metadata.get("pages_needing_ocr", [])
                ],
                "routing": {
                    "pdf_type": inspection["result"]["pdf_type"],
                    "confidence": inspection["result"]["confidence"],
                    "reason_rule": "pages_needing_ocr use classifier; other routed pages use native-text quality",
                },
                "source": first["source"],
                "counts": first["result"]["counts"],
                "document_json_sha256": first_document_hash,
                "ocr_provider": document.get("provenance", {}).get("ocr_provider"),
                "ocr_provider_identity": document.get("provenance", {}).get("ocr_provider_identity"),
                "timing_exact": True,
                "extraction_cache": {
                    "filename": extraction_cache.name,
                    "bytes": extraction_cache.stat().st_size,
                    "sha256": sha256(extraction_cache),
                    "preexisting_cache_files": len(extractions_before),
                },
            }
            atomic_json(receipt_path, receipt)
        else:
            document_cache = output / "cache" / "parse-v1" / "documents" / f"{receipt['source']['cache_key']}.json.gz"
            first_document_hash = receipt["document_json_sha256"]

        first_cache_copy = document_cache.with_name(document_cache.stem + ".first.json.gz")
        if not first_cache_copy.is_file():
            shutil.copyfile(document_cache, first_cache_copy)
        document_cache.unlink(missing_ok=True)
        replay, replay_seconds = run_contract(
            arguments.binary.resolve(),
            request_path,
            arguments.timeout,
            arguments.cache_max_bytes,
        )
        replay_document_bytes = gunzip_bytes(document_cache)
        replay_document_hash = hashlib.sha256(replay_document_bytes).hexdigest()
        if replay["source"]["cache_hit"]:
            raise RuntimeError("structure replay unexpectedly hit a document cache")
        byte_identical = first_document_hash == replay_document_hash
        detail = None
        semantic_detail = None
        receipt.update(
            {
                "structure_replay_seconds": round(replay_seconds, 6),
                "estimated_ocr_seconds": round(
                    max(
                        0.0,
                        float(receipt["ocr_plus_structure_seconds"]) - replay_seconds,
                    ),
                    6,
                ),
                "document_json_sha256": first_document_hash,
                "byte_identical_structure_replay": byte_identical,
                "structure_replay_first_difference": detail,
            }
        )
        if not byte_identical:
            first_value = json.loads(gunzip_bytes(first_cache_copy))
            replay_value = json.loads(replay_document_bytes)
            detail = first_difference(first_value, replay_value)
            semantic_detail = first_difference_outside_float_tolerance(
                first_value, replay_value
            )
            receipt.update(
                {
                    "structure_replay_first_difference": detail,
                    "structure_replay_float_abs_tolerance": FLOAT_DIAGNOSTIC_ABS_TOLERANCE,
                    "structure_replay_semantically_equivalent_within_tolerance": semantic_detail
                    is None,
                    "structure_replay_semantic_first_difference": semantic_detail,
                }
            )
            replay_cache_copy = document_cache.with_name(
                document_cache.stem + ".replay.json.gz"
            )
            shutil.copyfile(document_cache, replay_cache_copy)
            os.replace(first_cache_copy, document_cache)
            classification = (
                "raw numeric drift within diagnostic tolerance"
                if semantic_detail is None
                else f"semantic drift at {semantic_detail}"
            )
            raise RuntimeError(
                "cached-extraction structure replay was not byte-identical: "
                f"{classification}; first raw difference at {detail}; "
                f"replay preserved as {replay_cache_copy.name}"
            )
        os.replace(first_cache_copy, document_cache)
        receipt.update(
            {
                "outcome": "passed",
            }
        )
    except Exception as error:  # Preserve a durable failure and continue the corpus.
        if first_cache_copy is not None and first_cache_copy.is_file() and document_cache is not None:
            os.replace(first_cache_copy, document_cache)
        if not isinstance(receipt, dict):
            receipt = {
                "schema_version": RECEIPT_SCHEMA,
                "runtime_fingerprint": runtime["fingerprint"],
                "candidate_id": token,
                "relative_path": row["relative_path"],
                "physical_pages": int(row["page_count"]),
            }
        receipt.update({"outcome": "failed", "error": str(error)[-20_000:]})
    atomic_json(receipt_path, receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    here = Path(__file__).resolve().parent
    repo = here.parents[1]
    parser.add_argument("--corpus-root", type=Path, default=here)
    parser.add_argument("--binary", type=Path, default=repo / ".tmp/release-live/bin/legalpdf.exe")
    parser.add_argument("--model", type=Path, default=repo / "legal-pdf-parser/runtime/kraken/model.onnx")
    parser.add_argument("--codec", type=Path, default=repo / "legal-pdf-parser/runtime/kraken/codec.json")
    parser.add_argument("--runtime", type=Path, default=repo / "legal-pdf-parser/runtime/onnxruntime.dll")
    parser.add_argument("--layout", type=Path, default=repo / "legal-pdf-parser/runtime/legalpdf_tesseract_layout.dll")
    parser.add_argument("--output", type=Path, default=repo / ".tmp/non-digital-kraken-quality")
    parser.add_argument("--tier", choices=("quality", "balanced", "turbo", "extreme"), default="quality")
    parser.add_argument("--backend", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--device", default="0")
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--cache-max-bytes", type=int, default=100_000_000_000)
    parser.add_argument("--max-documents", type=int, default=0)
    parser.add_argument("--candidate-id", action="append", default=[])
    parser.add_argument("--summarize-only", action="store_true")
    arguments = parser.parse_args()

    arguments.corpus_root = arguments.corpus_root.resolve()
    output = arguments.output.resolve()
    rows = accepted_non_digital(arguments.corpus_root)
    runtime = runtime_manifest(arguments)
    atomic_json(
        output / "manifest.json",
        {
            "schema_version": RUN_SCHEMA,
            "runtime": runtime,
            "selection": "latest accepted ledger rows where generation == non_digital",
            "documents": [
                {key: row.get(key) for key in ("candidate_id", "relative_path", "sha256", "bytes", "page_count", "jurisdiction", "kind", "source")}
                for row in rows
            ],
        },
    )
    selected = (
        [row for row in rows if row["candidate_id"] in set(arguments.candidate_id)]
        if arguments.candidate_id
        else rows[: arguments.max_documents or None]
    )
    if arguments.candidate_id and len(selected) != len(set(arguments.candidate_id)):
        raise RuntimeError("one or more --candidate-id values are not accepted non_digital PDFs")
    started = time.monotonic()
    if arguments.summarize_only:
        state = summary(output, rows, runtime, started)
        atomic_json(output / "summary.json", state)
        print(json.dumps(state, ensure_ascii=False, indent=2), flush=True)
        return 0 if state["progress"]["corpus_materialized"] else 1
    for index, row in enumerate(selected, 1):
        print(f"DOCUMENT {index}/{len(selected)} {row['page_count']} pages {row['candidate_id']}", flush=True)
        receipt = process_document(row, arguments, output, runtime)
        state = summary(output, rows, runtime, started)
        atomic_json(output / "summary.partial.json", state)
        print(
            f"{receipt['outcome'].upper()} {index}/{len(selected)}; "
            f"{state['progress']['physical_pages_materialized']:,} physical pages, "
            f"{state['progress']['ocr_pages_routed']:,} OCR pages",
            flush=True,
        )
    state = summary(output, rows, runtime, started)
    atomic_json(output / "summary.json", state)
    print(json.dumps(state, ensure_ascii=False, indent=2), flush=True)
    return 0 if state["progress"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
