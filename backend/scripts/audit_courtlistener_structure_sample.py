#!/usr/bin/env python3
"""Audit a stratified CourtListener sample through Beaver's real compiler."""

from __future__ import annotations

import argparse
import bz2
import csv
import json
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

from open_legal_data_bridge import data_root


MARKUP_FIELDS = (
    "xml_harvard",
    "html_with_citations",
    "html",
    "html_lawbox",
    "html_columbia",
    "html_anon_2020",
)
DISPLAY_FIELDS = (
    "html_with_citations",
    "html",
    "html_lawbox",
    "html_columbia",
    "html_anon_2020",
    "xml_harvard",
)


def default_cache() -> Path:
    return (data_root() / "cache" / "courtlistener").resolve()


def opinion_rows(path: Path):
    with bz2.open(path, "rt", encoding="utf-8", newline="") as handle:
        yield from csv.DictReader(handle, escapechar="\\", doublequote=False)


def source(row: dict[str, str]) -> dict[str, object]:
    field = next((name for name in MARKUP_FIELDS if row.get(name, "").strip()), None)
    markup = row.get(field, "") if field else ""
    display = next((row.get(name, "") for name in DISPLAY_FIELDS if row.get(name, "").strip()), "")
    return {
        "id": row["id"],
        "clusterId": row["cluster_id"],
        "field": field,
        "text": row.get("plain_text", "") or display,
        "markup": markup,
    }


def bridge(backend: Path):
    executable = backend / "node_modules" / ".bin" / "tsx.cmd"
    if not executable.is_file():
        raise FileNotFoundError(f"Run npm install first: {executable}")
    return subprocess.Popen(
        [str(executable), "scripts/courtlistener-structure-jsonl.ts"],
        cwd=backend,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )


def audit_part(process: subprocess.Popen[str], source_path: Path, target: Path) -> int:
    if process.stdin is None or process.stdout is None:
        raise RuntimeError("Compiler bridge pipes are unavailable")
    temporary = target.with_suffix(target.suffix + ".tmp")
    count = 0
    with bz2.open(temporary, "wt", encoding="utf-8", newline="") as output:
        for row in opinion_rows(source_path):
            request = source(row)
            process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            process.stdin.flush()
            response = process.stdout.readline()
            if not response:
                raise RuntimeError(f"Compiler bridge exited while auditing {source_path.name}")
            parsed = json.loads(response)
            if "error" in parsed:
                raise RuntimeError(f"Opinion {parsed.get('id')}: {parsed['error']}")
            output.write(json.dumps(parsed, ensure_ascii=False) + "\n")
            count += 1
    temporary.replace(target)
    return count


def audit_rows(path: Path):
    with bz2.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def summarize(paths: list[Path]) -> dict[str, object]:
    result: Counter[str] = Counter()
    fields: Counter[str] = Counter()
    styles: Counter[str] = Counter()
    native_blocks = heuristic_blocks = 0
    for path in paths:
        for row in audit_rows(path):
            result["opinions"] += 1
            fields[row.get("field") or "plain_text"] += 1
            native = row["native"]["count"]
            heuristic = row["heuristic"]["count"]
            native_blocks += native
            heuristic_blocks += heuristic
            if native:
                result["with_native_paragraphs"] += 1
            if heuristic:
                result["with_heuristic_paragraphs"] += 1
            if heuristic and not native:
                result["with_heuristic_only_paragraphs"] += 1
                for style, count in row["heuristic"]["styles"].items():
                    styles[style] += count
            if row["markup"]["notes_headings"]:
                result["with_notes_heading"] += 1
                if heuristic and not native:
                    result["heuristic_only_with_notes_heading"] += 1
            if row["markup"]["footnote_containers"]:
                result["with_provider_footnotes"] += 1
            if row["markup"]["numbered_headings"]:
                result["with_numbered_headings"] += 1
                if heuristic and not native:
                    result["heuristic_only_with_numbered_headings"] += 1
    return {
        **dict(result),
        "native_paragraphs": native_blocks,
        "heuristic_paragraphs": heuristic_blocks,
        "source_fields": dict(fields),
        "heuristic_only_styles": dict(styles),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--cache-dir", default=str(default_cache()))
    parser.add_argument("--ranges", type=int, default=256)
    parser.add_argument("--range-bytes", type=int, default=5 * 1024 * 1024)
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()

    field_limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(field_limit)
            break
        except OverflowError:
            field_limit //= 10

    backend = Path(__file__).resolve().parent.parent
    cache = Path(args.cache_dir).expanduser().resolve()
    sample = cache / f"opinions-{args.snapshot}.stratified-{args.ranges}x{args.range_bytes}"
    if not args.allow_incomplete and not (sample / "manifest.json").is_file():
        raise FileNotFoundError(f"Incomplete opinion sample: {sample}")
    parts = sorted((sample / "parts").glob("part-*.csv.bz2"))
    if not parts:
        raise FileNotFoundError(f"No sampled opinion parts in {sample}")
    output = sample / "audit-v2"
    output.mkdir(parents=True, exist_ok=True)

    process = bridge(backend)
    try:
        for index, part in enumerate(parts):
            target = output / f"{part.stem.removesuffix('.csv')}.audit.jsonl.bz2"
            receipt = target.with_suffix(target.suffix + ".json")
            if target.is_file() and receipt.is_file():
                print(f"[{index + 1}/{len(parts)}] {part.name}: already audited", flush=True)
                continue
            started = time.monotonic()
            count = audit_part(process, part, target)
            elapsed = max(time.monotonic() - started, 0.001)
            temporary = receipt.with_suffix(receipt.suffix + ".tmp")
            temporary.write_text(
                json.dumps(
                    {
                        "source": part.name,
                        "source_bytes": part.stat().st_size,
                        "rows": count,
                        "output_bytes": target.stat().st_size,
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            temporary.replace(receipt)
            print(
                f"[{index + 1}/{len(parts)}] {part.name}: {count:,} opinions "
                f"({count / elapsed:,.1f}/s)",
                flush=True,
            )
    finally:
        if process.stdin:
            process.stdin.close()
        process.wait(timeout=30)

    audited = sorted(output.glob("part-*.audit.jsonl.bz2"))
    result = summarize(audited)
    temporary = output / "summary.json.tmp"
    temporary.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output / "summary.json")
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()
