#!/usr/bin/env python3
"""Stage a private, content-addressed DOCX benchmark corpus.

The copied documents and manifest are intentionally git-ignored.  This script
records structural OOXML features without extracting document text into the
manifest, making it useful for selecting a diverse local test corpus while
keeping the source material private.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree


WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"w": WORD_NS, "r": REL_NS}

PRIVATE_NAME_PATTERNS = (
    "password",
    "credential",
    "door code",
    "publishing agreement",
    "candidate use",
    "cra information",
    "pre-negotiation",
    "negotiation ",
    "interview ",
    "ecrm ",
    "memo to students - exam",
    "evidence can",
)

DERIVATIVE_NAME_PATTERNS = (
    "chief",
    "galley",
    "camera",
    "returned",
    "annotated",
    "table-of-authorities",
    "book-of-authorities",
    "supras fixed",
    "[revised]",
    "pre-final",
    "final draft",
    "edits clean",
    "clean copy",
)

CORE_PROFILE_PARTS = (
    "word/document.xml",
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/comments.xml",
    "word/styles.xml",
    "word/numbering.xml",
    "word/settings.xml",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def count_xml_features(xml_bytes: bytes) -> Counter[str]:
    counts: Counter[str] = Counter()
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError:
        counts["malformed_xml_parts"] += 1
        return counts

    tags = {
        "paragraphs": "p",
        "tables": "tbl",
        "hyperlinks": "hyperlink",
        "content_controls": "sdt",
        "bookmarks": "bookmarkStart",
        "field_instructions": "instrText",
        "simple_fields": "fldSimple",
        "tracked_insertions": "ins",
        "tracked_deletions": "del",
        "drawings": "drawing",
        "section_properties": "sectPr",
        "footnote_references": "footnoteReference",
        "endnote_references": "endnoteReference",
        "comments_references": "commentReference",
        "footnotes": "footnote",
        "endnotes": "endnote",
        "comments": "comment",
        "styles": "style",
        "numbering_instances": "num",
        "abstract_numbering_definitions": "abstractNum",
        "alt_chunks": "altChunk",
        "document_protection": "documentProtection",
    }
    for label, local_name in tags.items():
        counts[label] += len(root.findall(f".//w:{local_name}", NS))

    counts["visible_text_chars"] += sum(
        len(node.text or "") for node in root.findall(".//w:t", NS)
    )
    counts["deleted_text_chars"] += sum(
        len(node.text or "") for node in root.findall(".//w:delText", NS)
    )
    revision_tags = (
        "ins",
        "del",
        "moveFrom",
        "moveTo",
        "pPrChange",
        "rPrChange",
        "tblPrChange",
        "tblGridChange",
        "trPrChange",
        "tcPrChange",
        "sectPrChange",
        "numberingChange",
    )
    counts["revision_elements"] += sum(
        len(root.findall(f".//w:{local_name}", NS))
        for local_name in revision_tags
    )
    counts["equations"] += sum(
        1
        for node in root.iter()
        if node.tag.rsplit("}", 1)[-1] in {"oMath", "oMathPara"}
    )
    return counts


def profile_docx(path: Path) -> dict[str, object]:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        if "[Content_Types].xml" not in names or "word/document.xml" not in names:
            raise ValueError("missing required DOCX package parts")

        counts: Counter[str] = Counter()
        profile_parts = [
            *CORE_PROFILE_PARTS,
            *sorted(
                name
                for name in names
                if (
                    name.startswith("word/header")
                    or name.startswith("word/footer")
                )
                and name.endswith(".xml")
            ),
        ]
        for name in profile_parts:
            if name in names:
                counts.update(count_xml_features(archive.read(name)))

        counts["package_parts"] = len(names)
        counts["media_parts"] = sum(name.startswith("word/media/") for name in names)
        counts["embedded_objects"] = sum(
            name.startswith("word/embeddings/") for name in names
        )
        counts["macro_parts"] = sum(name.endswith("vbaProject.bin") for name in names)
        counts["chart_parts"] = sum(name.startswith("word/charts/") for name in names)
        counts["active_x_parts"] = sum(name.startswith("word/activeX/") for name in names)
        counts["custom_xml_parts"] = sum(name.startswith("customXml/") for name in names)
        counts["header_parts"] = sum(
            name.startswith("word/header") and name.endswith(".xml") for name in names
        )
        counts["footer_parts"] = sum(
            name.startswith("word/footer") and name.endswith(".xml") for name in names
        )
        counts["has_footnotes"] = int("word/footnotes.xml" in names)
        counts["has_endnotes"] = int("word/endnotes.xml" in names)
        counts["has_comments"] = int("word/comments.xml" in names)
        counts["has_numbering"] = int("word/numbering.xml" in names)
        counts["has_styles"] = int("word/styles.xml" in names)
        counts["has_settings"] = int("word/settings.xml" in names)
        counts["has_custom_properties"] = int("docProps/custom.xml" in names)

        rel_count = 0
        external_rel_count = 0
        for name in names:
            if not name.endswith(".rels"):
                continue
            try:
                root = ElementTree.fromstring(archive.read(name))
            except ElementTree.ParseError:
                counts["malformed_xml_parts"] += 1
                continue
            relationships = root.findall(f".//{{{REL_NS}}}Relationship")
            rel_count += len(relationships)
            external_rel_count += sum(
                relationship.attrib.get("TargetMode") == "External"
                for relationship in relationships
            )
        counts["relationships"] = rel_count
        counts["external_relationships"] = external_rel_count

    return dict(sorted(counts.items()))


def collect_sources(inputs: list[Path]) -> list[Path]:
    files: set[Path] = set()
    for source in inputs:
        source = source.resolve()
        if source.is_dir():
            files.update(source.rglob("*.docx"))
        elif source.is_file() and source.suffix.lower() == ".docx":
            files.add(source)
        else:
            raise FileNotFoundError(f"not a DOCX file or directory: {source}")
    return sorted(files, key=lambda item: str(item).casefold())


def blocked_name(
    path: Path,
    *,
    allow_sensitive_names: bool,
    allow_derivative_names: bool,
) -> str | None:
    name = str(path).casefold()
    if path.name.startswith("~$"):
        return "temporary Word lock file"
    if not allow_sensitive_names:
        for pattern in PRIVATE_NAME_PATTERNS:
            if pattern in name:
                return f"privacy exclusion: {pattern}"
    if not allow_derivative_names:
        for pattern in DERIVATIVE_NAME_PATTERNS:
            if pattern in name:
                return f"downstream derivative exclusion: {pattern}"
    return None


def relative_source(path: Path, source_root: Path | None) -> str:
    if source_root is not None:
        try:
            return path.relative_to(source_root.resolve()).as_posix()
        except ValueError:
            pass
    return str(path)


def manifest_copy_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return str(resolved)


def stage(
    inputs: list[Path],
    output_dir: Path,
    manifest_path: Path,
    manifest_jsonl_path: Path,
    source_root: Path | None,
    allow_sensitive_names: bool,
    allow_derivative_names: bool = False,
    prune: bool = False,
) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    source_files = collect_sources(inputs)
    records_by_hash: dict[str, dict[str, object]] = {}
    skipped: list[dict[str, str]] = []

    for source in source_files:
        blocked = blocked_name(
            source,
            allow_sensitive_names=allow_sensitive_names,
            allow_derivative_names=allow_derivative_names,
        )
        source_label = relative_source(source, source_root)
        if blocked:
            skipped.append({"source": source_label, "reason": blocked})
            continue

        try:
            digest = sha256(source)
            features = profile_docx(source)
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            skipped.append({"source": source_label, "reason": str(error)})
            continue

        existing = records_by_hash.get(digest)
        if existing is not None:
            aliases = existing.setdefault("source_aliases", [])
            assert isinstance(aliases, list)
            aliases.append(source_label)
            continue

        corpus_id = f"docx-{digest[:16]}"
        destination = output_dir / f"{corpus_id}.docx"
        if not destination.exists() or sha256(destination) != digest:
            shutil.copy2(source, destination)

        records_by_hash[digest] = {
            "id": corpus_id,
            "corpus_id": corpus_id,
            "sha256": digest,
            "bytes": source.stat().st_size,
            "copy_path": manifest_copy_path(destination),
            "external_model_allowed": False,
            "source": source_label,
            "source_aliases": [],
            "features": features,
        }

    records = sorted(records_by_hash.values(), key=lambda item: str(item["corpus_id"]))
    expected_copies = {
        (output_dir / f"{record['corpus_id']}.docx").resolve() for record in records
    }
    pruned_count = 0
    if prune:
        resolved_output = output_dir.resolve()
        resolved_workspace = Path.cwd().resolve()
        if (
            resolved_output == resolved_workspace
            or resolved_workspace not in resolved_output.parents
            or resolved_output.name != "private_sources"
        ):
            raise ValueError(
                "--prune is restricted to a private_sources directory "
                "inside the current workspace"
            )
        for candidate in resolved_output.glob("docx-*.docx"):
            if candidate.resolve() not in expected_copies:
                candidate.unlink()
                pruned_count += 1

    feature_coverage = sorted(
        {
            feature
            for record in records
            for feature, value in dict(record["features"]).items()
            if isinstance(value, int) and value > 0
        }
    )
    manifest: dict[str, object] = {
        "schema_version": 1,
        "privacy": "local-only; source documents and this manifest are git-ignored",
        "external_model_policy": (
            "deny by default; a separately frozen fixture and informed approval "
            "are required before transmitting document passages"
        ),
        "input_file_count": len(source_files),
        "unique_document_count": len(records),
        "duplicate_source_count": sum(
            len(record["source_aliases"]) for record in records
        ),
        "skipped_count": len(skipped),
        "pruned_count": pruned_count,
        "feature_coverage": feature_coverage,
        "documents": records,
        "skipped": skipped,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    manifest_jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_jsonl_path.write_text(
        "".join(
            json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
            for record in records
        ),
        encoding="utf-8",
    )
    return manifest


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument(
        "inputs",
        nargs="*",
        type=Path,
        help="DOCX files or directories to scan recursively",
    )
    command.add_argument(
        "--from-manifest",
        type=Path,
        help=(
            "re-stage the source paths recorded by an existing private manifest; "
            "requires --source-root when those paths are relative"
        ),
    )
    command.add_argument(
        "--output-dir",
        type=Path,
        default=Path("benchmarks/docx_corpus/private_sources"),
    )
    command.add_argument(
        "--manifest",
        type=Path,
        default=Path("benchmarks/docx_corpus/private_manifest.json"),
    )
    command.add_argument(
        "--manifest-jsonl",
        type=Path,
        default=Path("benchmarks/docx_corpus/private_manifest.jsonl"),
    )
    command.add_argument(
        "--source-root",
        type=Path,
        help="store source paths relative to this directory in the private manifest",
    )
    command.add_argument(
        "--allow-sensitive-names",
        action="store_true",
        help="disable the conservative filename privacy screen",
    )
    command.add_argument(
        "--allow-derivative-names",
        action="store_true",
        help="include filenames that look like chief/galley/camera/final derivatives",
    )
    command.add_argument(
        "--prune",
        action="store_true",
        help="remove stale content-addressed copies from the private output directory",
    )
    return command


def main() -> int:
    args = parser().parse_args()
    inputs = list(args.inputs)
    if args.from_manifest:
        previous = json.loads(args.from_manifest.read_text(encoding="utf-8"))
        previous_documents = previous.get("documents")
        if not isinstance(previous_documents, list):
            raise ValueError("--from-manifest must contain a documents array")
        for record in previous_documents:
            if not isinstance(record, dict) or not record.get("source"):
                raise ValueError("every manifest document must have a source")
            source = Path(str(record["source"]))
            if not source.is_absolute():
                if not args.source_root:
                    raise ValueError(
                        "--source-root is required for relative manifest sources"
                    )
                source = args.source_root / source
            inputs.append(source)
    if not inputs:
        raise ValueError("provide DOCX inputs or --from-manifest")
    manifest = stage(
        inputs=inputs,
        output_dir=args.output_dir,
        manifest_path=args.manifest,
        manifest_jsonl_path=args.manifest_jsonl,
        source_root=args.source_root,
        allow_sensitive_names=args.allow_sensitive_names,
        allow_derivative_names=args.allow_derivative_names,
        prune=args.prune,
    )
    print(
        json.dumps(
            {
                "input_file_count": manifest["input_file_count"],
                "unique_document_count": manifest["unique_document_count"],
                "duplicate_source_count": manifest["duplicate_source_count"],
                "skipped_count": manifest["skipped_count"],
                "pruned_count": manifest["pruned_count"],
                "feature_coverage_count": len(manifest["feature_coverage"]),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
