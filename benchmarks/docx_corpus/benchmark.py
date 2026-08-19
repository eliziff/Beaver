#!/usr/bin/env python3
"""Local DOCX corpus benchmark built on Beaver's universal legal engine."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import tempfile
import time
from typing import Any, Iterable
import zipfile


ROOT = Path(__file__).resolve().parents[2]
ENGINE_SRC = ROOT / "legal-pdf-parser" / "src"
sys.path.insert(0, str(ENGINE_SRC))

from legalpdf.benchmark import extract_docx_gold  # noqa: E402
from legalpdf.deterministic_citations import (  # noqa: E402
    split_footnote,
    split_footnote_recall_first,
)
from legalpdf.docx_linking import deterministic_intents  # noqa: E402


ACCEPTED_STATUSES = {"accepted"}
GOLD_ADJUDICATION_SCHEMA = "mike.docx-corpus.gold-adjudication.v1"
LEAST_EDITED_ROLE = "least_edited_upstream"
PRIVATE_SCHEMA = "mike.docx-corpus.cases.v1"
PREDICTION_SCHEMA = "mike.docx-corpus.predictions.v1"


def _jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{number}: expected a JSON object")
        rows.append(value)
    return rows


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _text_sha(value: str) -> str:
    return hashlib.sha256(_normalized(value).casefold().encode("utf-8")).hexdigest()


def _normalized(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().rstrip(";").strip()


def _core(value: Any) -> str:
    return re.sub(r"[\s;]+", "", _normalized(value))


def _validated_accepted_gold(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    accepted = [row for row in rows if row.get("status") in ACCEPTED_STATUSES]
    if not accepted:
        raise ValueError("gold contains no accepted rows")

    ids: set[str] = set()
    fingerprints: set[str] = set()
    family_pstreams: dict[str, str] = {}
    for row in accepted:
        case_id = str(row.get("id") or "")
        if not case_id or case_id in ids:
            raise ValueError("accepted gold ids must be non-empty and unique")
        ids.add(case_id)

        adjudication = row.get("adjudication")
        if not isinstance(adjudication, dict):
            raise ValueError(f"{case_id}: accepted gold requires adjudication provenance")
        if adjudication.get("provenance") != "human":
            raise ValueError(f"{case_id}: accepted gold provenance must be human")
        required = ("reviewer_id", "guideline_version", "schema_version", "adjudicated_at")
        missing = [field for field in required if not str(adjudication.get(field) or "").strip()]
        if missing:
            raise ValueError(
                f"{case_id}: accepted gold adjudication missing {', '.join(missing)}"
            )
        if adjudication["schema_version"] != GOLD_ADJUDICATION_SCHEMA:
            raise ValueError(f"{case_id}: unsupported adjudication schema_version")
        try:
            adjudicated_at = datetime.fromisoformat(
                str(adjudication["adjudicated_at"]).replace("Z", "+00:00")
            )
        except ValueError as exc:
            raise ValueError(f"{case_id}: invalid adjudicated_at") from exc
        if adjudicated_at.tzinfo is None or adjudicated_at.utcoffset() is None:
            raise ValueError(f"{case_id}: adjudicated_at must include a timezone")

        fingerprint = str(row.get("text_sha256") or "")
        expected_fingerprint = _text_sha(str(row.get("footnote_text") or ""))
        if fingerprint != expected_fingerprint:
            raise ValueError(f"{case_id}: normalized-content fingerprint mismatch")
        if fingerprint in fingerprints:
            raise ValueError("accepted gold normalized-content fingerprints must be unique")
        fingerprints.add(fingerprint)

        work_family_id = str(row.get("work_family_id") or "").strip()
        pstream_id = str(row.get("pstream_id") or "").strip()
        if not work_family_id or not pstream_id:
            raise ValueError(f"{case_id}: work_family_id and pstream_id are required")
        if row.get("edition_role") != LEAST_EDITED_ROLE:
            raise ValueError(
                f"{case_id}: edition_role must be {LEAST_EDITED_ROLE}"
            )
        prior_pstream = family_pstreams.setdefault(work_family_id, pstream_id)
        if prior_pstream != pstream_id:
            raise ValueError(
                f"{case_id}: work family {work_family_id} has multiple pstreams"
            )

        if not _accepted_partitions(row):
            raise ValueError(f"accepted gold row has no expected parts: {case_id}")
    return accepted


def _tags(text: str, features: dict[str, Any]) -> list[str]:
    tags: list[str] = []
    if re.search(r"\bsupra\b", text, re.IGNORECASE):
        tags.append("supra")
    if re.search(r"\bibid\b", text, re.IGNORECASE):
        tags.append("ibid")
    if ";" in text:
        tags.append("semicolon")
    if int(features.get("tracked_insertions") or 0) or int(
        features.get("tracked_deletions") or 0
    ):
        tags.append("source_has_tracked_changes")
    if int(features.get("content_controls") or 0):
        tags.append("source_has_content_controls")
    return tags


def _parts(result: Any) -> list[str]:
    return [str(part.text) for part in result.parts]


def _prediction(
    case_id: str,
    document_id: str,
    footnote_id: str,
    arm: str,
    source_text: str,
    result: Any,
    *,
    complete: bool,
    elapsed_ms: float,
) -> dict[str, Any]:
    actual = _parts(result) if complete else []
    return {
        "schema_version": PREDICTION_SCHEMA,
        "id": case_id,
        "document_id": document_id,
        "footnote_id": footnote_id,
        "arm": arm,
        "status": "complete" if complete else "abstain",
        "actual_parts": actual,
        "character_neutral": bool(actual) and _core(source_text) == _core(" ".join(actual)),
        "reasons": list(result.reasons),
        "elapsed_ms": round(elapsed_ms, 3),
    }


def _manifest_documents(manifest: Path) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    seen: set[Path] = set()
    for row in _jsonl(manifest):
        raw_path = row.get("copy_path") or row.get("path")
        if not raw_path:
            raise ValueError("manifest row is missing copy_path/path")
        path = Path(str(raw_path))
        path = (ROOT / path).resolve() if not path.is_absolute() else path.resolve()
        try:
            path.relative_to(ROOT)
        except ValueError as exc:
            raise ValueError(f"manifest path is outside the workspace: {path}") from exc
        if path in seen:
            continue
        seen.add(path)
        documents.append(
            {
                "id": str(row.get("corpus_id") or row.get("id") or row.get("sha256") or ""),
                "path": path,
                "sha256": str(row.get("sha256") or ""),
                "bytes": int(row.get("bytes") or 0),
                "features": row.get("features") if isinstance(row.get("features"), dict) else {},
                "work_family_id": str(row.get("work_family_id") or ""),
                "pstream_id": str(row.get("pstream_id") or ""),
                "edition_role": str(row.get("edition_role") or ""),
            }
        )
    return sorted(documents, key=lambda item: item["id"])


def _benchmark_document(document: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    document_id = document["id"]
    path: Path = document["path"]
    expected_sha = document["sha256"]
    result: dict[str, Any] = {
        "document_id": document_id,
        "sha256": expected_sha,
        "bytes": document["bytes"],
        "features": document["features"],
        "work_family_id": str(document.get("work_family_id") or ""),
        "pstream_id": str(document.get("pstream_id") or ""),
        "edition_role": str(document.get("edition_role") or ""),
        "cases": [],
        "conservative": [],
        "recall_first": [],
        "error": "",
    }
    try:
        if not path.is_file():
            raise FileNotFoundError(path)
        actual_sha = _sha256(path)
        if expected_sha and actual_sha != expected_sha:
            raise ValueError(f"SHA-256 mismatch: expected {expected_sha}, got {actual_sha}")
        extracted = extract_docx_gold(path)
        result["sha256"] = actual_sha
        cases: list[dict[str, Any]] = []
        conservative_predictions: list[dict[str, Any]] = []
        recall_predictions: list[dict[str, Any]] = []
        for note in extracted["footnotes"]:
            note_started = time.perf_counter()
            footnote_id = str(note["ooxml_id"])
            text = str(note["body"])
            case_id = f"{document_id}:fn:{footnote_id}"
            conservative_result = split_footnote(text)
            conservative_complete = bool(
                deterministic_intents(footnote_id, text)
            )
            conservative_elapsed = (time.perf_counter() - note_started) * 1000
            recall_started = time.perf_counter()
            recall_result = split_footnote_recall_first(text)
            recall_elapsed = (time.perf_counter() - recall_started) * 1000
            features = document["features"]
            cases.append(
                {
                    "schema_version": PRIVATE_SCHEMA,
                    "id": case_id,
                    "document_id": document_id,
                    "document_sha256": actual_sha,
                    "work_family_id": str(document.get("work_family_id") or ""),
                    "pstream_id": str(document.get("pstream_id") or ""),
                    "edition_role": str(document.get("edition_role") or ""),
                    "footnote_id": footnote_id,
                    "label": str(note["label"]),
                    "footnote_text": text,
                    "proposition": str(note["passage_since_prior_note"] or ""),
                    "text_sha256": _text_sha(text),
                    "tags": _tags(text, features),
                    "conservative_eligible": conservative_complete,
                    "conservative_status": str(conservative_result.status),
                    "conservative_reasons": list(conservative_result.reasons),
                    "recall_first_reasons": list(recall_result.reasons),
                }
            )
            conservative_predictions.append(
                _prediction(
                    case_id,
                    document_id,
                    footnote_id,
                    "deterministic_conservative",
                    text,
                    conservative_result,
                    complete=conservative_complete,
                    elapsed_ms=conservative_elapsed,
                )
            )
            recall_predictions.append(
                _prediction(
                    case_id,
                    document_id,
                    footnote_id,
                    "deterministic_recall_first",
                    text,
                    recall_result,
                    complete=bool(recall_result.parts),
                    elapsed_ms=recall_elapsed,
                )
            )
        result["citation_count"] = len(extracted["citations"])
        result["cases"] = cases
        result["conservative"] = conservative_predictions
        result["recall_first"] = recall_predictions
    except Exception as exc:
        result["cases"] = []
        result["conservative"] = []
        result["recall_first"] = []
        result["error"] = f"{type(exc).__name__}: {exc}"
    result["elapsed_seconds"] = round(time.perf_counter() - started, 4)
    return result


def scan(
    manifest: Path,
    output_dir: Path,
    workers: int,
    *,
    allow_errors: bool = False,
) -> dict[str, Any]:
    started = time.perf_counter()
    documents = _manifest_documents(manifest)
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = list(pool.map(_benchmark_document, documents))
    cases = sorted(
        (case for result in results for case in result["cases"]),
        key=lambda row: row["id"],
    )
    conservative = sorted(
        (row for result in results for row in result["conservative"]),
        key=lambda row: row["id"],
    )
    recall = sorted(
        (row for result in results for row in result["recall_first"]),
        key=lambda row: row["id"],
    )
    feature_counts: Counter[str] = Counter()
    for document in documents:
        feature_counts.update(
            key for key, value in document["features"].items() if isinstance(value, int) and value > 0
        )
    reason_counts = Counter(
        reason for row in conservative for reason in row.get("reasons", [])
    )
    summary = {
        "schema_version": "mike.docx-corpus.summary.v1",
        "manifest_sha256": _sha256(manifest),
        "documents": len(documents),
        "documents_parsed": sum(not result["error"] for result in results),
        "document_errors": sum(bool(result["error"]) for result in results),
        "document_feature_counts": dict(sorted(feature_counts.items())),
        "footnotes": len(cases),
        "unique_footnote_texts": len({case["text_sha256"] for case in cases}),
        "citations_detected": sum(int(result.get("citation_count") or 0) for result in results),
        "conservative_complete": sum(row["status"] == "complete" for row in conservative),
        "conservative_coverage": round(
            sum(row["status"] == "complete" for row in conservative) / max(1, len(cases)), 4
        ),
        "conservative_character_failures": sum(
            row["status"] == "complete" and not row["character_neutral"]
            for row in conservative
        ),
        "recall_first_complete": sum(row["status"] == "complete" for row in recall),
        "recall_first_character_failures": sum(
            row["status"] == "complete" and not row["character_neutral"] for row in recall
        ),
        "conservative_reason_counts": dict(sorted(reason_counts.items())),
        "elapsed_seconds": round(time.perf_counter() - started, 4),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_jsonl(output_dir / "cases.private.jsonl", cases)
    _write_jsonl(
        output_dir / "predictions.deterministic_conservative.jsonl", conservative
    )
    _write_jsonl(
        output_dir / "predictions.deterministic_recall_first.jsonl", recall
    )
    _write_jsonl(
        output_dir / "documents.private.jsonl",
        (
            {
                "document_id": result["document_id"],
                "sha256": result["sha256"],
                "bytes": result["bytes"],
                "features": result["features"],
                "work_family_id": result["work_family_id"],
                "pstream_id": result["pstream_id"],
                "edition_role": result["edition_role"],
                "citation_count": int(result.get("citation_count") or 0),
                "footnotes": len(result["cases"]),
                "elapsed_seconds": result["elapsed_seconds"],
                "error": result["error"],
            }
            for result in results
        ),
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if summary["document_errors"] and not allow_errors:
        raise RuntimeError(
            f"{summary['document_errors']} document(s) failed; "
            "see documents.private.jsonl"
        )
    return summary


def _stable_diverse_sample(
    rows: list[dict[str, Any]], sample_size: int, seed: str
) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for row in rows:
        unique.setdefault(str(row["text_sha256"]), row)
    ranked: list[tuple[int, str, dict[str, Any]]] = []
    document_ranks: Counter[str] = Counter()
    ordered = sorted(
        unique.values(),
        key=lambda row: hashlib.sha256(
            f"{seed}|{row['id']}".encode("utf-8")
        ).hexdigest(),
    )
    for row in ordered:
        document_id = str(row["document_id"])
        ranked.append(
            (
                document_ranks[document_id],
                hashlib.sha256(f"{seed}|{row['id']}".encode("utf-8")).hexdigest(),
                row,
            )
        )
        document_ranks[document_id] += 1
    ranked.sort(key=lambda item: (item[0], item[1]))
    difficult = [item[2] for item in ranked if not item[2]["conservative_eligible"]]
    safe = [item[2] for item in ranked if item[2]["conservative_eligible"]]
    target_difficult = min(len(difficult), (sample_size + 1) // 2)
    selected = difficult[:target_difficult]
    selected.extend(safe[: sample_size - len(selected)])
    if len(selected) < sample_size:
        selected.extend(difficult[target_difficult : sample_size - len(selected) + target_difficult])
    return selected[:sample_size]


def sample_for_review(
    cases_path: Path,
    output: Path,
    sample_size: int,
    seed: str,
    *,
    force: bool = False,
) -> list[dict[str, Any]]:
    if output.exists() and not force:
        raise FileExistsError(
            f"refusing to overwrite review file without --force: {output}"
        )
    cases = _jsonl(cases_path)
    selected = _stable_diverse_sample(cases, max(1, sample_size), seed)
    rows = [
        {
            "id": row["id"],
            "document_id": row["document_id"],
            "work_family_id": str(row.get("work_family_id") or ""),
            "pstream_id": str(row.get("pstream_id") or ""),
            "edition_role": str(row.get("edition_role") or ""),
            "footnote_id": row["footnote_id"],
            "footnote_text": row["footnote_text"],
            "proposition": row["proposition"],
            "text_sha256": row["text_sha256"],
            "conservative_eligible": row["conservative_eligible"],
            "expected_verbatim_parts": [],
            "acceptable_partitions": [],
            "tags": [
                *row["tags"],
                (
                    "challenge_conservative_eligible"
                    if row["conservative_eligible"]
                    else "challenge_conservative_abstention"
                ),
            ],
            "sampling_design": "balanced_challenge",
            "sampling_stratum": (
                "conservative_eligible"
                if row["conservative_eligible"]
                else "conservative_abstention"
            ),
            "status": "provisional",
            "adjudication": {
                "provenance": "",
                "reviewer_id": "",
                "guideline_version": "",
                "schema_version": GOLD_ADJUDICATION_SCHEMA,
                "adjudicated_at": "",
            },
            "notes": (
                "Human review required. Add canonical expected_verbatim_parts; "
                "use acceptable_partitions only for genuinely equivalent boundaries; "
                "fill adjudication and upstream pstream provenance; then set "
                "status=accepted."
            ),
            "sample_seed": seed,
        }
        for row in selected
    ]
    _write_jsonl(output, rows)
    return rows


def freeze_fixture(
    gold_path: Path,
    output: Path,
    frozen_gold: Path,
    sample_size: int,
    seed: str,
) -> int:
    accepted = [dict(row) for row in _validated_accepted_gold(_jsonl(gold_path))]
    for row in accepted:
        row.setdefault("document_id", str(row.get("source_doc") or "gold"))
        row.setdefault("conservative_eligible", False)
    selected = _stable_diverse_sample(accepted, max(1, sample_size), seed)
    fixture = {
        "schema_version": "mike.docx-corpus.live-fixture.v1",
        "seed": seed,
        "cases": [
            {
                "id": row["id"],
                "label": str(row.get("footnote_id") or row["id"]),
                "document_id": str(row.get("document_id") or ""),
                "work_family_id": str(row["work_family_id"]),
                "pstream_id": str(row["pstream_id"]),
                "edition_role": str(row["edition_role"]),
                "text": str(row.get("footnote_text") or ""),
                "proposition": str(row.get("proposition") or ""),
                "expected_verbatim_parts": row.get("expected_verbatim_parts") or [],
                "acceptable_partitions": row.get("acceptable_partitions") or [],
                "tags": list(row.get("tags") or []),
                "sampling_design": str(row.get("sampling_design") or "unspecified"),
                "sampling_stratum": str(row.get("sampling_stratum") or ""),
                "text_sha256": str(row.get("text_sha256") or ""),
                "adjudication": dict(row["adjudication"]),
                "conservative_eligible": bool(row.get("conservative_eligible")),
            }
            for row in selected
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    _write_jsonl(frozen_gold, selected)
    return len(selected)


def _accepted_partitions(row: dict[str, Any]) -> list[list[str]]:
    canonical = row.get("expected_verbatim_parts") or row.get("verbatim_expected_parts") or []
    values = [canonical]
    values.extend(
        item for item in row.get("acceptable_partitions") or [] if isinstance(item, list)
    )
    partitions = [
        [_normalized(part) for part in partition if _normalized(part)]
        for partition in values
    ]
    return [partition for partition in partitions if partition]


def _wilson(successes: int, total: int) -> list[float]:
    if total <= 0:
        return [0.0, 0.0]
    z = 1.959963984540054
    rate = successes / total
    denominator = 1 + z * z / total
    centre = (rate + z * z / (2 * total)) / denominator
    margin = z * math.sqrt(
        (rate * (1 - rate) + z * z / (4 * total)) / total
    ) / denominator
    return [round(max(0.0, centre - margin), 4), round(min(1.0, centre + margin), 4)]


def _score_arm(
    gold: list[dict[str, Any]], predictions: dict[str, dict[str, Any]]
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    details: dict[str, dict[str, Any]] = {}
    outcomes: Counter[str] = Counter()
    by_tag: dict[str, Counter[str]] = defaultdict(Counter)
    attempted = 0
    for row in gold:
        case_id = str(row["id"])
        prediction = predictions.get(case_id)
        partitions = _accepted_partitions(row)
        if not partitions or not partitions[0]:
            raise ValueError(f"accepted gold row has no expected parts: {case_id}")
        actual = [
            _normalized(part)
            for part in (prediction or {}).get("actual_parts", [])
            if _normalized(part)
        ]
        complete = bool(prediction and prediction.get("status") == "complete" and actual)
        attempted += int(complete)
        character_neutral = complete and _core(row.get("footnote_text")) == _core(
            " ".join(actual)
        )
        canonical = actual == partitions[0]
        tolerant = character_neutral and actual in partitions
        expected_counts = {len(partition) for partition in partitions}
        if not complete:
            outcome = "abstain"
        elif not character_neutral:
            outcome = "character_drift"
        elif tolerant:
            outcome = "exact" if canonical else "acceptable_alternative"
        elif len(actual) < min(expected_counts):
            outcome = "under_split"
        elif len(actual) > max(expected_counts):
            outcome = "over_split"
        else:
            outcome = "boundary_mismatch"
        outcomes[outcome] += 1
        tags = [str(tag) for tag in row.get("tags") or []] or ["untagged"]
        for tag in tags:
            by_tag[tag]["cases"] += 1
            by_tag[tag]["attempted"] += int(complete)
            by_tag[tag]["tolerant_exact"] += int(tolerant)
            by_tag[tag][outcome] += 1
        details[case_id] = {
            "id": case_id,
            "outcome": outcome,
            "attempted": complete,
            "strict_exact": canonical and character_neutral,
            "tolerant_exact": tolerant,
            "character_neutral": character_neutral,
            "expected_counts": sorted(expected_counts),
            "actual_count": len(actual),
        }
    total = len(gold)
    exact = sum(detail["strict_exact"] for detail in details.values())
    tolerant = sum(detail["tolerant_exact"] for detail in details.values())
    summary = {
        "cases": total,
        "attempted": attempted,
        "coverage": round(attempted / max(1, total), 4),
        "strict_exact": exact,
        "strict_exact_accuracy": round(exact / max(1, total), 4),
        "strict_exact_95ci": _wilson(exact, total),
        "tolerant_exact": tolerant,
        "tolerant_exact_accuracy": round(tolerant / max(1, total), 4),
        "tolerant_exact_95ci": _wilson(tolerant, total),
        "tolerant_precision_when_attempted": round(tolerant / max(1, attempted), 4),
        "outcomes": dict(sorted(outcomes.items())),
        "by_tag": {
            tag: dict(sorted(counts.items())) for tag, counts in sorted(by_tag.items())
        },
    }
    return summary, details


def _sign_test(wins: int, losses: int) -> float:
    trials = wins + losses
    if not trials:
        return 1.0
    tail = sum(math.comb(trials, index) for index in range(0, min(wins, losses) + 1))
    return round(min(1.0, 2 * tail / (2**trials)), 6)


def score(
    gold_path: Path,
    prediction_specs: list[str],
    output: Path,
    baseline: str | None,
) -> dict[str, Any]:
    gold = _validated_accepted_gold(_jsonl(gold_path))
    gold_ids = [str(row.get("id") or "") for row in gold]
    gold_id_set = set(gold_ids)
    sampling_designs = sorted(
        {
            str(row.get("sampling_design") or "unspecified")
            for row in gold
        }
    )
    population_inference_valid = sampling_designs == ["representative"]
    arms: dict[str, dict[str, Any]] = {}
    details_by_arm: dict[str, dict[str, dict[str, Any]]] = {}
    for spec in prediction_specs:
        if "=" not in spec:
            raise ValueError("--prediction must be NAME=PATH")
        name, raw_path = spec.split("=", 1)
        prediction_rows = _jsonl(Path(raw_path))
        prediction_ids = [
            str(row.get("id") or "")
            for row in prediction_rows
        ]
        if not all(prediction_ids) or len(prediction_ids) != len(
            set(prediction_ids)
        ):
            raise ValueError(f"prediction ids must be non-empty and unique: {name}")
        prediction_id_set = set(prediction_ids)
        if prediction_id_set != gold_id_set:
            missing = sorted(gold_id_set - prediction_id_set)
            extra = sorted(prediction_id_set - gold_id_set)
            raise ValueError(
                f"prediction ids must exactly match accepted gold ids: {name}; "
                f"missing={missing}; extra={extra}"
            )
        predictions = dict(zip(prediction_ids, prediction_rows))
        arms[name], details_by_arm[name] = _score_arm(gold, predictions)
        arms[name]["prediction_sha256"] = _sha256(Path(raw_path))
        if not population_inference_valid:
            arms[name]["strict_exact_95ci"] = None
            arms[name]["tolerant_exact_95ci"] = None
    comparisons: dict[str, Any] = {}
    if baseline:
        if baseline not in arms:
            raise ValueError(f"unknown baseline arm: {baseline}")
        base = details_by_arm[baseline]
        for name, details in details_by_arm.items():
            if name == baseline:
                continue
            wins = sum(
                details[case_id]["tolerant_exact"] and not base[case_id]["tolerant_exact"]
                for case_id in base
            )
            losses = sum(
                base[case_id]["tolerant_exact"] and not details[case_id]["tolerant_exact"]
                for case_id in base
            )
            comparisons[name] = {
                "baseline": baseline,
                "tolerant_wins": wins,
                "tolerant_losses": losses,
                "paired_sign_test_p": (
                    _sign_test(wins, losses)
                    if population_inference_valid
                    else None
                ),
                "tolerant_accuracy_delta": round(
                    arms[name]["tolerant_exact_accuracy"]
                    - arms[baseline]["tolerant_exact_accuracy"],
                    4,
                ),
                "under_split_delta": (
                    arms[name]["outcomes"].get("under_split", 0)
                    - arms[baseline]["outcomes"].get("under_split", 0)
                ),
                "character_drift_delta": (
                    arms[name]["outcomes"].get("character_drift", 0)
                    - arms[baseline]["outcomes"].get("character_drift", 0)
                ),
            }
    result = {
        "schema_version": "mike.docx-corpus.score.v1",
        "gold_sha256": _sha256(gold_path),
        "scorer_sha256": _sha256(Path(__file__)),
        "accepted_cases": len(gold),
        "sampling_designs": sampling_designs,
        "population_inference_valid": population_inference_valid,
        "inference_note": (
            "Population confidence intervals and p-values require a frozen "
            "representative sampling design. Balanced challenge-set results "
            "are descriptive and must be read by stratum."
            if not population_inference_valid
            else ""
        ),
        "arms": arms,
        "paired_comparisons": comparisons,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return result


def _synthetic_docx(path: Path) -> None:
    document = """<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>First proposition.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
<w:p><w:r><w:t>Second proposition.</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>
</w:body></w:document>"""
    notes = """<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote w:id="-1" w:type="separator"><w:p/></w:footnote>
<w:footnote w:id="1"><w:p><w:r><w:t>R v Oakes, [1986] 1 SCR 103.</w:t></w:r></w:p></w:footnote>
<w:footnote w:id="2"><w:p><w:r><w:t>R v Sparrow, [1990] 1 SCR 1075; Ibid at 1110.</w:t></w:r></w:p></w:footnote>
</w:footnotes>"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", document)
        archive.writestr("word/footnotes.xml", notes)


def self_test() -> None:
    with tempfile.TemporaryDirectory() as raw:
        temp = Path(raw)
        docx = temp / "fixture.docx"
        _synthetic_docx(docx)
        digest = _sha256(docx)
        # The manifest path guard is intentionally workspace-bound, so place the
        # generated package under the benchmark directory for this one check.
        local_docx = ROOT / "benchmarks" / "docx_corpus" / ".self-test.docx"
        local_manifest = ROOT / "benchmarks" / "docx_corpus" / ".self-test.jsonl"
        output = temp / "out"
        try:
            local_docx.write_bytes(docx.read_bytes())
            local_manifest.write_text(
                json.dumps(
                    {
                        "corpus_id": "synthetic",
                        "copy_path": str(local_docx.relative_to(ROOT)).replace("\\", "/"),
                        "sha256": digest,
                        "bytes": local_docx.stat().st_size,
                        "features": {},
                        "work_family_id": "synthetic-work",
                        "pstream_id": "synthetic-upstream",
                        "edition_role": LEAST_EDITED_ROLE,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            summary = scan(local_manifest, output, workers=1)
            assert summary["documents_parsed"] == 1
            assert summary["footnotes"] == 2
            assert summary["recall_first_character_failures"] == 0
            review = temp / "review.jsonl"
            rows = sample_for_review(output / "cases.private.jsonl", review, 2, "test")
            predictions = {
                row["id"]: row
                for row in _jsonl(output / "predictions.deterministic_recall_first.jsonl")
            }
            for row in rows:
                row["expected_verbatim_parts"] = predictions[row["id"]]["actual_parts"]
                row["adjudication"] = {
                    "provenance": "human",
                    "reviewer_id": "synthetic-reviewer",
                    "guideline_version": "synthetic-v1",
                    "schema_version": GOLD_ADJUDICATION_SCHEMA,
                    "adjudicated_at": "2026-07-26T00:00:00Z",
                }
                row["status"] = "accepted"
            _write_jsonl(review, rows)
            result = score(
                review,
                [
                    "recall="
                    + str(output / "predictions.deterministic_recall_first.jsonl")
                ],
                temp / "score.json",
                None,
            )
            assert result["arms"]["recall"]["tolerant_exact"] == 2
            fixture = temp / "fixture.json"
            frozen_gold = temp / "frozen-gold.jsonl"
            assert freeze_fixture(review, fixture, frozen_gold, 2, "test") == 2
            assert len(json.loads(fixture.read_text(encoding="utf-8"))["cases"]) == 2
            assert len(_jsonl(frozen_gold)) == 2
        finally:
            local_docx.unlink(missing_ok=True)
            local_manifest.unlink(missing_ok=True)
    print("self-test passed")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    scan_parser = commands.add_parser("scan", help="Run both deterministic arms on a DOCX manifest.")
    scan_parser.add_argument("--manifest", type=Path, required=True)
    scan_parser.add_argument("--output-dir", type=Path, required=True)
    scan_parser.add_argument("--workers", type=int, default=8)
    scan_parser.add_argument(
        "--allow-errors",
        action="store_true",
        help="write partial diagnostics and exit successfully despite failed documents",
    )
    sample_parser = commands.add_parser("sample", help="Create provisional, human-review gold rows.")
    sample_parser.add_argument("--cases", type=Path, required=True)
    sample_parser.add_argument("--output", type=Path, required=True)
    sample_parser.add_argument("--sample-size", type=int, default=80)
    sample_parser.add_argument("--seed", default="mike-docx-corpus-v1")
    sample_parser.add_argument(
        "--force",
        action="store_true",
        help="overwrite an existing review file",
    )
    fixture_parser = commands.add_parser("fixture", help="Freeze accepted gold for the existing live arm runner.")
    fixture_parser.add_argument("--gold", type=Path, required=True)
    fixture_parser.add_argument("--output", type=Path, required=True)
    fixture_parser.add_argument("--frozen-gold", type=Path, required=True)
    fixture_parser.add_argument("--sample-size", type=int, default=12)
    fixture_parser.add_argument("--seed", default="mike-docx-live-v1")
    score_parser = commands.add_parser("score", help="Score one or more prediction JSONL arms.")
    score_parser.add_argument("--gold", type=Path, required=True)
    score_parser.add_argument("--prediction", action="append", required=True)
    score_parser.add_argument("--baseline")
    score_parser.add_argument("--output", type=Path, required=True)
    commands.add_parser("self-test", help="Run the dependency-free synthetic contract check.")
    args = parser.parse_args(argv)
    if args.command == "scan":
        print(
            json.dumps(
                scan(
                    args.manifest,
                    args.output_dir,
                    args.workers,
                    allow_errors=args.allow_errors,
                ),
                indent=2,
            )
        )
    elif args.command == "sample":
        rows = sample_for_review(
            args.cases,
            args.output,
            args.sample_size,
            args.seed,
            force=args.force,
        )
        print(f"wrote {len(rows)} provisional review rows to {args.output}")
    elif args.command == "fixture":
        count = freeze_fixture(
            args.gold,
            args.output,
            args.frozen_gold,
            args.sample_size,
            args.seed,
        )
        print(f"wrote {count} accepted cases to {args.output}")
    elif args.command == "score":
        print(
            json.dumps(
                score(args.gold, args.prediction, args.output, args.baseline),
                indent=2,
            )
        )
    else:
        self_test()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
