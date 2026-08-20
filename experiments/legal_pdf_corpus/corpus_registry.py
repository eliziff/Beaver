#!/usr/bin/env python3
"""Freeze and verify the local legal-structure corpus inventory.

This is a registry gate, not a parser-quality result.  It reads compact source
manifests where they exist and otherwise inventories names and sizes; it never
copies source text or private paths into its receipt.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
SCHEMA = "beaver.legal-structure-corpus-registry.v1"
SOURCE_SUFFIXES = {
    ".csv", ".docx", ".eml", ".htm", ".html", ".json", ".jsonl",
    ".lst", ".md", ".pdf", ".png", ".tsv", ".txt", ".xlsx", ".xml",
}
EXCLUDED_PARTS = {
    ".git", ".pytest_cache", ".venv", "__pycache__", "dist", "node_modules",
    "out", "output", "outputs", "private_results", "results", "site-packages", "target", "venv",
}
ALL_GATES = [
    "headings", "numbered_units", "pages", "paragraphs", "notes",
    "reading_order", "exclusions",
]


def spec(
    corpus_id: str,
    path: str,
    owner: str,
    inputs: str,
    oracle: str,
    gates: list[str] | None = None,
    *,
    kind: str = "files",
    applicable: bool = True,
    reason: str | None = None,
) -> dict[str, Any]:
    return {
        "id": corpus_id,
        "path": path,
        "owner": owner,
        "input_type": inputs,
        "oracle": oracle,
        "gates": gates or ALL_GATES,
        "kind": kind,
        "applicable": applicable,
        "reason": reason,
    }


# Exact source roots, not result directories. Add a row when a new local source
# surface is created; discovery below makes silently omitting it an error.
SPECS = [
    spec("legal-pdf-1500", "experiments/legal_pdf_corpus", "legal-pdf", "pdf", "source ledger", kind="ledger"),
    spec("legal-pdf-digital-native-750", "experiments/legal_pdf_corpus", "legal-pdf", "pdf", "source ledger", kind="ledger:digitalborn"),
    spec("legal-pdf-non-digital-750", "experiments/legal_pdf_corpus", "legal-pdf", "pdf", "source ledger", kind="ledger:non_digital"),
    spec("digital-native-materialized", ".tmp/digital-native-structure-audit", "legal-pdf", "cached extraction", "frozen baseline cache", kind="cache"),
    spec("sourcedoc-a2aj-fixtures", "backend/src/lib/__tests__/fixtures/sourcedoc", "sourcedoc", "provider json", "captured provider bytes", ["numbered_units", "notes", "paragraphs", "exclusions"]),
    spec("sourcedoc-native-markup-fixtures", "backend/src/lib/__tests__/fixtures/nativemarkup", "sourcedoc", "provider json", "captured native claims"),
    spec("sourcedoc-hansard-fixture", "backend/src/lib/__tests__/fixtures/hansard", "sourcedoc", "provider json", "captured provider bytes", ["headings", "numbered_units", "paragraphs", "exclusions"]),
    spec("sourcedoc-legalbench-fixtures", "backend/src/lib/__tests__/fixtures/legalbench", "sourcedoc", "legal text json", "captured fixture", ["headings", "numbered_units", "paragraphs"]),
    spec("retrieval-citation-oracle", "backend/src/lib/__tests__/fixtures/retrieval_gate", "sourcedoc", "oracle json", "manual oracle", ["numbered_units", "notes", "exclusions"]),
    spec("legal-generalization-31", "benchmarks/legal-generalization-corpus", "benchmarks", "legal source/text pairs", "source manifest"),
    spec("canadian-structure-gold", "benchmarks/legal-generalization-corpus/canadian/structure-gold", "benchmarks", "text plus structure json", "manual structure gold"),
    spec("us-public-laws-uslm", "benchmarks/legal-generalization-corpus/gold/us-public-laws-uslm", "benchmarks", "USLM xml", "native XML plus manifest"),
    spec("bilingual-amending-acts", "benchmarks/legal-generalization-corpus/amending-acts", "benchmarks", "bilingual text", "paired source text", ["headings", "numbered_units", "paragraphs", "exclusions"]),
    spec("docx-private-corpus", "benchmarks/docx_corpus", "docx", "docx", "private manifest", ["headings", "numbered_units", "paragraphs", "notes"]),
    spec("docx-edit-real-fixtures", "benchmarks/docx_edit/fixtures", "docx", "docx/text", "tracked fixture manifest", ["headings", "numbered_units", "paragraphs", "notes"]),
    spec("authored-legal-grammar", "packages/legal-grammar-tables", "grammar", "grammar json", "authored vectors", ["headings", "numbered_units", "notes", "exclusions"], kind="grammar"),
    spec("harvested-grammar-vectors", "benchmarks/grammar_vectors", "grammar", "jsonl", "harvested vectors", ["headings", "numbered_units", "notes", "exclusions"]),
    spec("structure-stress-probes", "benchmarks/structure_stress/probes", "sourcedoc", "text/jsonl", "probe truth", ["headings", "numbered_units", "notes", "paragraphs", "exclusions"]),
    spec("kraken-ocr-benchmark-splits", "legal-pdf-parser/experiments/kraken-lite/kraken-lite-native/benchmark-splits", "ocr", "page lists", "manual gold and reviewed silver", kind="references"),
    spec("kraken-layout-validation", "legal-pdf-parser/experiments/kraken-lite/kraken-lite-validation", "ocr", "page images", "frozen validation manifest", ["pages", "paragraphs", "reading_order", "exclusions"], kind="references"),
    spec("kraken-court-scan-corpus", "legal-pdf-parser/experiments/kraken-lite/kraken-lite-native/court-scan-corpus", "ocr", "scan pages", "local scan corpus", ["pages", "paragraphs", "reading_order", "exclusions"]),
    spec("kraken-courtlistener-silver", "legal-pdf-parser/experiments/kraken-lite/kraken-lite-native/courtlistener-scan-silver", "ocr", "scan silver", "machine silver", ["pages", "paragraphs", "reading_order", "exclusions"]),
    spec("kraken-scan-silver", "legal-pdf-parser/experiments/kraken-lite/kraken-lite-native/scan-silver", "ocr", "scan silver", "machine silver", ["pages", "paragraphs", "reading_order", "exclusions"]),
    spec("kraken-training-data", "legal-pdf-parser/experiments/kraken-lite/kraken-lite-training-data", "ocr", "page images and truth", "frozen training data", ["pages", "paragraphs", "reading_order", "exclusions"]),
    spec("digitalborn-external-sources", "legal-pdf-parser/experiments/digitalborn-core", "legal-pdf", "pdf manifest", "source manifest"),
    spec("ppdoc-product-smoke", "legal-pdf-parser/experiments/ppdoc-lite/product-smoke", "layout", "layout images", "product fixture", ["pages", "paragraphs", "reading_order", "exclusions"]),
    spec("cache-contract-fixture", "legal-pdf-parser/experiments/cache-contract-fidelity", "legal-pdf", "cache manifest", "cache-contract manifest", ["exclusions"]),
    spec("structure-engine-parity-baseline", "legal-pdf-parser/experiments/structure-engine-parity", "legal-pdf", "baseline hash manifest", "frozen parser baseline"),
    spec("python-reference-code", "legal-pdf-parser/experiments/python-reference", "legal-pdf", "reference implementation", "none", ["exclusions"], applicable=False, reason="contains reference code and documentation but no corpus input bytes"),
    spec("beaver-can", "benchmarks/beaver_can/tasks", "benchmarks", "legal task sources", "task gold", ["headings", "numbered_units", "paragraphs", "notes", "exclusions"]),
    spec("harvey-office-task-documents", "benchmarks/harvey-labs/tasks", "benchmarks", "legal office documents", "none", ["exclusions"], applicable=False, reason="office-task documents route through DOCX, spreadsheet, email, and presentation ingestion rather than the PDF/SourceDoc structure engine"),
    spec("legalbench", "benchmarks/legalbench/data", "benchmarks", "legal text json", "benchmark labels", ["headings", "numbered_units", "paragraphs", "notes", "exclusions"]),
    spec("legalbench-rag", "benchmarks/legalbench_rag/data", "benchmarks", "legal retrieval corpus", "benchmark manifests", ["headings", "numbered_units", "paragraphs", "notes", "exclusions"]),
    spec("gold-contract", "benchmarks/gold_contract", "benchmarks", "metric contract", "authored gold", ["exclusions"]),
    spec("lab-corpus-split", "benchmarks/lab", "benchmarks", "corpus split", "frozen split", ["exclusions"]),
    spec("retrieval-gate", "benchmarks/retrieval_gate", "benchmarks", "legal retrieval fixture", "frozen fixture", ["numbered_units", "notes", "exclusions"]),
    spec("prompt-live", "benchmarks/prompt_live", "benchmarks", "prompt fixture", "frozen fixture", ["exclusions"]),
    spec("deeplink-receipts", "benchmarks/deeplink_gate", "benchmarks", "navigation receipts", "none", ["exclusions"], applicable=False, reason="contains navigation receipts, not document source bytes"),
    spec("sourcedoc-performance-receipts", "benchmarks/sourcedoc", "sourcedoc", "timing receipts", "none", ["exclusions"], applicable=False, reason="contains timing receipts and URLs, not provider document bytes"),
    spec("trace-receipts", "benchmarks/traces", "benchmarks", "execution traces", "none", ["exclusions"], applicable=False, reason="contains execution traces, not document source bytes"),
    spec("a2aj-decision-roster", "experiments/a2aj_decision_roster_qwen", "sourcedoc", "captured A2AJ decisions", "frozen case roster", ["headings", "numbered_units", "paragraphs", "notes", "exclusions"]),
    spec("legal-compaction-cases", "experiments/legal_compaction_qwen", "sourcedoc", "captured legal decisions", "frozen case records", ["headings", "numbered_units", "paragraphs", "notes", "exclusions"]),
    spec("legal-grounding-cases", "experiments/legal_grounding_framing", "sourcedoc", "captured legal decisions", "frozen case records", ["headings", "numbered_units", "paragraphs", "notes", "exclusions"]),
    spec("context-compaction-track-a", "experiments/context_compaction_track_a", "experiments", "experiment plan", "none", ["exclusions"], applicable=False, reason="contains an experiment plan but no document source bytes"),
    spec("context-compaction-track-b", "experiments/context_compaction_track_b", "experiments", "experiment plan", "none", ["exclusions"], applicable=False, reason="contains an experiment plan but no document source bytes"),
    spec("grounded-drafting-receipts", "experiments/grounded_drafting_copy_gate", "experiments", "drafting receipts", "none", ["exclusions"], applicable=False, reason="contains drafting receipts but no structure-engine corpus inputs"),
]

HISTORICAL = [
    ("journal-pdf-qualification", 1024, 27391),
    ("external-digitalborn-legal-pdfs", 29, 1445),
    ("interpretation-replay", 7, 418),
    ("text-fidelity-journal-truth", 661, 661),
    ("historical-a2aj-cases-sweep", 330473, None),
    ("historical-a2aj-laws-sweep", 36927, None),
    ("historical-journal-sweep", 2494, None),
    ("installed-a2aj-fulltext", 248685, None),
    ("courtlistener-bodies", 55504, None),
    ("courtlistener-audit", 69393, None),
    ("journal-database", 18958, 404506),
    ("canlii-case-title-index", 3538714, None),
    ("canlii-legislation-title-index", 91669, None),
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def files_below(root: Path) -> list[Path]:
    if not root.exists():
        return []
    if root.is_file():
        return [root]
    found: list[Path] = []
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d.lower() not in EXCLUDED_PARTS)
        for name in sorted(names):
            path = Path(base, name)
            if path.suffix.lower() in SOURCE_SUFFIXES:
                found.append(path)
    return found


def identity_files(files: Iterable[Path]) -> list[Path]:
    return [
        path for path in files
        if path.name.lower() in {"gold.json", "index.json", "manifest.json", "manifest.jsonl", "corpus.json", "registry.jsonl"}
        or path.name.lower().startswith(("manifest.", "corpus.", "truth.", "gold.", "registry."))
        or path.name.lower().endswith(("_manifest.json", "_manifest.jsonl", "_manifest.tsv", "_truth.json", "_gold.json"))
        or path.name.lower().endswith(".structure.json")
        or path.suffix.lower() == ".lst"
    ]


_GIT_BLOBS: dict[str, str] | None = None


def path_key(path: Path) -> str:
    return os.path.normcase(os.path.abspath(path))


def git_blobs() -> dict[str, str]:
    global _GIT_BLOBS
    if _GIT_BLOBS is not None:
        return _GIT_BLOBS
    blobs: dict[str, str] = {}
    for git_root in (ROOT, ROOT / "legal-pdf-parser", ROOT / "legal-browser-ocr"):
        if not (git_root / ".git").exists():
            continue
        result = subprocess.run(
            ["git", "-C", str(git_root), "ls-files", "-s", "-z"],
            check=True, capture_output=True,
        )
        for entry in result.stdout.split(b"\0"):
            if not entry:
                continue
            metadata, raw_path = entry.split(b"\t", 1)
            blob = metadata.split()[1].decode("ascii")
            blobs[path_key(git_root / os.fsdecode(raw_path))] = "git:" + blob
    _GIT_BLOBS = blobs
    return blobs


def duplicate_summary(files: list[Path]) -> dict[str, int]:
    by_size: dict[int, list[Path]] = defaultdict(list)
    for path in files:
        by_size[path.stat().st_size].append(path)
    groups: Counter[str] = Counter()
    tracked = git_blobs()
    for same_size in by_size.values():
        if len(same_size) > 1:
            candidates: dict[str, list[Path]] = defaultdict(list)
            for path in same_size:
                with path.open("rb") as source:
                    first = source.read(65536)
                    source.seek(max(path.stat().st_size - 65536, 0))
                    last = source.read(65536)
                candidates[sha256_bytes(first + last)].append(path)
            for sampled in candidates.values():
                if len(sampled) > 1:
                    known = [tracked.get(path_key(path)) for path in sampled]
                    if all(known):
                        groups.update(known)
                    else:
                        groups.update("sha256:" + sha256_file(path) for path in sampled)
    duplicate_groups = [count for count in groups.values() if count > 1]
    return {
        "groups": len(duplicate_groups),
        "aliases": sum(duplicate_groups),
        "extra_aliases": sum(count - 1 for count in duplicate_groups),
    }


def manifest_hash(files: list[Path], root: Path) -> str:
    rows = [f"{path.relative_to(root).as_posix()}\0{path.stat().st_size}" for path in files]
    return sha256_bytes("\n".join(sorted(rows)).encode())


def combined_file_hash(files: list[Path]) -> str | None:
    if not files:
        return None
    return sha256_bytes("\n".join(sorted(sha256_file(path) for path in files)).encode())


def generic_row(item: dict[str, Any], repo_root: Path) -> dict[str, Any]:
    root = repo_root / item["path"]
    files = files_below(root)
    if item["kind"] == "references":
        files = identity_files(path for path in files if path.parent == root)
    if not root.exists():
        raise ValueError(f"missing registered current corpus: {item['id']}")
    if not files:
        raise ValueError(f"zero denominator for current corpus: {item['id']}")
    suffixes = Counter(path.suffix.lower() or "none" for path in files)
    identities = identity_files(files)
    records = 0
    for path in files:
        if path.suffix.lower() in {".jsonl", ".lst"}:
            with path.open("rb") as source:
                records += sum(1 for line in source if line.strip())
    units = {"files": len(files), "bytes": sum(path.stat().st_size for path in files)}
    if records:
        units["records"] = records
    if item["kind"] == "references":
        for path in files:
            if path.suffix.lower() == ".json":
                value = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(value, list):
                    units["records"] = units.get("records", 0) + len(value)
    if item["kind"] == "grammar":
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        units.update(entries=int(manifest["entries"]), vectors=int(manifest["vectors"]))
    return {
        "id": item["id"],
        "owner": item["owner"],
        "path_identity": f"repo:{item['path']}",
        "input_type": item["input_type"],
        "oracle": item["oracle"],
        "applicable": item["applicable"],
        "exclusion": item["reason"],
        "gates": item["gates"] if item["applicable"] else [],
        "availability": "current",
        "runnable_offline": item["applicable"],
        "denominator": units,
        "file_types": dict(sorted(suffixes.items())),
        "membership_manifest_sha256": manifest_hash(files, root),
        "identity_file_count": len(identities),
        "identity_files_sha256": combined_file_hash(identities),
        "duplicates": duplicate_summary(files) if item["applicable"] else {
            "groups": 0, "aliases": 0, "extra_aliases": 0, "measured": False,
        },
    }


def ledger_rows(items: list[dict[str, Any]], repo_root: Path) -> list[dict[str, Any]]:
    ledger = repo_root / "experiments/legal_pdf_corpus/ledger.jsonl"
    latest: dict[str, dict[str, Any]] = {}
    with ledger.open(encoding="utf-8") as source:
        for line in source:
            row = json.loads(line)
            latest[row["candidate_id"]] = row
    accepted = [row for row in latest.values() if row.get("status") == "accepted"]
    results = []
    for item in items:
        generation = item["kind"].partition(":")[2]
        rows = [row for row in accepted if not generation or row.get("generation") == generation]
        ids = [row["candidate_id"] for row in rows]
        if not rows or len(ids) != len(set(ids)):
            raise ValueError(f"zero or duplicate ledger denominator: {item['id']}")
        missing = 0
        wrong_size = 0
        for row in rows:
            source_path = ledger.parent / row["relative_path"]
            if not source_path.is_file():
                missing += 1
            elif source_path.stat().st_size != row["bytes"]:
                wrong_size += 1
        if missing or wrong_size:
            raise ValueError(f"{item['id']}: missing={missing}, wrong_size={wrong_size}")
        members = [
            f"{row['candidate_id']}\0{row['sha256']}\0{row['bytes']}\0{row['page_count']}"
            for row in rows
        ]
        hashes = Counter(row["sha256"] for row in rows)
        duplicate_counts = [count for count in hashes.values() if count > 1]
        results.append({
            "id": item["id"], "owner": item["owner"],
            "path_identity": "repo:experiments/legal_pdf_corpus/ledger.jsonl",
            "input_type": "pdf", "oracle": "source ledger", "applicable": True,
            "exclusion": None, "gates": item["gates"], "availability": "current",
            "runnable_offline": True,
            "denominator": {
                "documents": len(rows),
                "pages": sum(int(row["page_count"]) for row in rows),
                "bytes": sum(int(row["bytes"]) for row in rows),
            },
            "membership_manifest_sha256": sha256_bytes("\n".join(sorted(members)).encode()),
            "identity_file_count": 1,
            "identity_files_sha256": sha256_file(ledger),
            "duplicates": {
                "groups": len(duplicate_counts), "aliases": sum(duplicate_counts),
                "extra_aliases": sum(count - 1 for count in duplicate_counts),
            },
        })
    return results


def historical_rows() -> list[dict[str, Any]]:
    rows = []
    for corpus_id, documents, pages in HISTORICAL:
        denominator = {"documents_or_records": documents}
        if pages:
            denominator["pages_or_rows"] = pages
        rows.append({
            "id": corpus_id, "owner": "historical", "path_identity": None,
            "input_type": "historical summary", "oracle": "historical receipt only",
            "applicable": True, "exclusion": "source bytes are not present under a registered local root",
            "gates": ALL_GATES, "availability": "historical-only", "runnable_offline": False,
            "denominator": denominator, "membership_manifest_sha256": None,
            "identity_file_count": 0, "identity_files_sha256": None,
            "duplicates": {"groups": 0, "aliases": 0, "extra_aliases": 0},
        })
    return rows


def discover_unregistered(repo_root: Path, registered_paths: set[str]) -> list[str]:
    """Find new top-level corpus roots; never infer that a new root is irrelevant."""
    parents = [
        "benchmarks",
        "experiments",
        "backend/src/lib/__tests__/fixtures",
        "legal-pdf-parser/experiments",
    ]
    unregistered = []
    for parent_text in parents:
        parent = repo_root / parent_text
        if not parent.is_dir():
            continue
        for child in parent.iterdir():
            logical = child.relative_to(repo_root).as_posix()
            covered = any(logical == path or logical.startswith(path + "/") or path.startswith(logical + "/") for path in registered_paths)
            if child.is_dir() and not covered and files_below(child):
                unregistered.append(logical)
    return sorted(unregistered)


def validate_rows(rows: list[dict[str, Any]]) -> None:
    ids = [row.get("id") for row in rows]
    duplicates = sorted(item for item, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise ValueError(f"duplicate corpus IDs: {duplicates}")
    for row in rows:
        denominator = row.get("denominator")
        if not denominator or any(not isinstance(value, int) or value <= 0 for value in denominator.values()):
            raise ValueError(f"missing or zero denominator: {row.get('id')}")
        if row["availability"] == "current" and row["applicable"] and not row["runnable_offline"]:
            raise ValueError(f"current applicable corpus is not runnable: {row['id']}")


def make_receipt(repo_root: Path, extra_roots: list[tuple[str, Path]] = []) -> dict[str, Any]:
    ledger_specs = [item for item in SPECS if item["kind"].startswith("ledger")]
    rows = ledger_rows(ledger_specs, repo_root)
    for item in SPECS:
        if item not in ledger_specs:
            path = repo_root / item["path"]
            if path.exists():
                rows.append(generic_row(item, repo_root))
    for corpus_id, path in extra_roots:
        dynamic = spec(corpus_id, ".", "configured-local", "legal documents", "configured local corpus")
        fake_root = path.parent
        dynamic["path"] = path.name
        row = generic_row(dynamic, fake_root)
        row["path_identity"] = f"configured:{corpus_id}"
        rows.append(row)
    rows.extend(historical_rows())
    registered_paths = {item["path"] for item in SPECS}
    unregistered = discover_unregistered(repo_root, registered_paths)
    if unregistered:
        raise ValueError("unregistered applicable discoveries: " + ", ".join(unregistered))
    rows.sort(key=lambda row: row["id"])
    validate_rows(rows)
    payload = {
        "schema_version": SCHEMA,
        "scope": "registry-only",
        "proof_claim": "freezes local corpus identity and denominators; does not claim parser parity or quality",
        "rows": rows,
        "summary": {
            "registered": len(rows),
            "current": sum(row["availability"] == "current" for row in rows),
            "historical_only": sum(row["availability"] == "historical-only" for row in rows),
            "runnable": sum(row["runnable_offline"] for row in rows),
            "unregistered": 0,
        },
    }
    payload["registry_sha256"] = sha256_bytes(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    return payload


def compare_receipts(baseline: dict[str, Any], current: dict[str, Any]) -> None:
    if baseline.get("scope") != "registry-only" or current.get("scope") != "registry-only":
        raise ValueError("a smoke or proof receipt cannot substitute for the corpus registry")
    validate_rows(baseline["rows"])
    validate_rows(current["rows"])
    old = {row["id"]: row for row in baseline["rows"]}
    new = {row["id"]: row for row in current["rows"]}
    missing = sorted(old.keys() - new.keys())
    added = sorted(new.keys() - old.keys())
    changed = sorted(
        corpus_id for corpus_id in old.keys() & new.keys()
        if old[corpus_id] != new[corpus_id]
    )
    if missing or added or changed:
        raise ValueError(f"corpus registry drift: missing={missing}, added={added}, changed={changed}")


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as target:
        target.write(encoded)
        temporary = Path(target.name)
    os.replace(temporary, path)


def self_test() -> None:
    row = {
        "id": "a", "availability": "current", "applicable": True,
        "runnable_offline": True, "denominator": {"documents": 1},
        "membership_manifest_sha256": "old",
    }
    baseline = {"scope": "registry-only", "rows": [row]}

    def must_fail(candidate: dict[str, Any], message: str) -> None:
        try:
            compare_receipts(baseline, candidate)
        except ValueError:
            return
        raise AssertionError(message)

    must_fail({"scope": "registry-only", "rows": []}, "missing row passed")
    changed = dict(row, membership_manifest_sha256="new")
    must_fail({"scope": "registry-only", "rows": [changed]}, "changed manifest passed")
    must_fail({"scope": "registry-only", "rows": [row, row]}, "duplicate ID passed")
    must_fail({"scope": "smoke", "rows": [row]}, "smoke mislabeled full passed")
    print("corpus registry negative controls: PASS")


def parse_extra_roots(values: list[str]) -> list[tuple[str, Path]]:
    roots = []
    for value in values:
        corpus_id, separator, raw_path = value.partition("=")
        if not separator or not corpus_id or not raw_path:
            raise ValueError("--local-root must be ID=PATH")
        roots.append((corpus_id, Path(raw_path).resolve()))
    return roots


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("freeze", "verify", "self-test"))
    parser.add_argument("--output", type=Path, default=ROOT / ".tmp/release-gates/corpus-registry.json")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--local-root", action="append", default=[], metavar="ID=PATH")
    args = parser.parse_args()
    if args.command == "self-test":
        self_test()
        return 0
    if args.command == "verify" and not args.baseline:
        parser.error("verify requires --baseline; a fresh scan cannot prove frozen membership")
    started = time.perf_counter()
    receipt = make_receipt(ROOT, parse_extra_roots(args.local_root))
    if args.command == "verify":
        compare_receipts(json.loads(args.baseline.read_text(encoding="utf-8")), receipt)
    atomic_json(args.output, receipt)
    elapsed = time.perf_counter() - started
    print(f"{args.command}: {receipt['summary']['registered']} corpora, {elapsed:.3f}s, {args.output.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"corpus registry: FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
