#!/usr/bin/env python3
"""Build a bounded, position-stratified sample of CourtListener opinions.

CourtListener's opinions export is one large bzip2 stream, so an HTTP range
cannot be decompressed directly.  The standard ``bzip2recover`` utility can
recover every complete bzip2 block inside a range.  This script downloads
evenly spaced ranges, recovers their complete CSV rows, and writes one atomic
compressed part per range.  It also downloads the dockets and courts exports
needed to measure court coverage exactly.
"""

from __future__ import annotations

import argparse
import bz2
import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from open_legal_data_bridge import data_root


BASE = "https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/"
CHUNK = 1 << 20
OPINION_FIELDS = (
    "id",
    "date_created",
    "date_modified",
    "author_str",
    "per_curiam",
    "joined_by_str",
    "type",
    "sha1",
    "page_count",
    "download_url",
    "local_path",
    "plain_text",
    "html",
    "html_lawbox",
    "html_columbia",
    "html_anon_2020",
    "xml_harvard",
    "xml_scan",
    "html_with_citations",
    "extracted_by_ocr",
    "author_id",
    "cluster_id",
)


def default_cache() -> Path:
    return (data_root() / "cache" / "courtlistener").resolve()


def remote_size(url: str) -> int:
    request = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(request, timeout=60) as response:
        return int(response.headers["Content-Length"])


def heartbeat(name: str, received: int, expected: int, started: float) -> None:
    elapsed = max(time.monotonic() - started, 0.001)
    speed = received / elapsed / 1_048_576
    print(
        f"  {name}: {received:,}/{expected:,} bytes ({speed:,.1f} MiB/s)",
        flush=True,
    )


def download(
    url: str,
    target: Path,
    *,
    start: int = 0,
    end: int | None = None,
) -> None:
    expected = (end - start + 1) if end is not None else remote_size(url)
    if target.is_file() and target.stat().st_size == expected:
        print(f"  {target.name}: already complete ({expected:,} bytes)", flush=True)
        return
    partial = target.with_suffix(target.suffix + ".part")
    received = partial.stat().st_size if partial.is_file() else 0
    if received > expected:
        raise OSError(f"{partial}: {received:,} bytes exceeds expected {expected:,}")
    if received == expected:
        partial.replace(target)
        return

    request_start = start + received
    headers = {}
    if end is not None or request_start:
        request_end = end if end is not None else start + expected - 1
        headers["Range"] = f"bytes={request_start}-{request_end}"
    request = urllib.request.Request(url, headers=headers)
    started = time.monotonic()
    last_report = received
    mode = "ab" if received else "wb"
    with urllib.request.urlopen(request, timeout=300) as response:
        if (end is not None or received) and response.status != 206:
            raise OSError(f"{url}: server did not honor range request")
        with partial.open(mode) as output:
            while chunk := response.read(CHUNK):
                output.write(chunk)
                received += len(chunk)
                if received - last_report >= 64 * CHUNK:
                    heartbeat(target.name, received, expected, started)
                    last_report = received
    if received != expected:
        raise OSError(f"{target.name}: got {received:,} bytes, want {expected:,}")
    partial.replace(target)
    heartbeat(target.name, received, expected, started)


def range_plan(size: int, count: int, width: int) -> list[tuple[int, int]]:
    if count < 2:
        raise ValueError("--ranges must be at least 2")
    if width <= 0 or width > size:
        raise ValueError("--range-bytes must be between 1 and the remote file size")
    span = size - width
    return [
        (round(index * span / (count - 1)), round(index * span / (count - 1)) + width - 1)
        for index in range(count)
    ]


def midpoint_plan(size: int, count: int, width: int) -> list[tuple[int, int]]:
    if count < 0:
        raise ValueError("--supplemental-ranges cannot be negative")
    if not count:
        return []
    span = size - width
    return [
        (
            round((index + 0.5) * span / count),
            round((index + 0.5) * span / count) + width - 1,
        )
        for index in range(count)
    ]


def bzip2recover_path(configured: str | None) -> Path:
    candidates = [
        Path(configured).expanduser() if configured else None,
        Path(found) if (found := shutil.which("bzip2recover")) else None,
        Path(r"C:\Program Files\Git\usr\bin\bzip2recover.exe"),
        Path(r"C:\Program Files\Git\mingw64\bin\bzip2recover.exe"),
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError("bzip2recover was not found; install bzip2 or Git for Windows")


def parsed_rows(raw: bytes, initially_quoted: bool) -> tuple[list[list[str]], int]:
    quoted = initially_quoted
    escaped_at = -1
    start = 0
    rows: list[list[str]] = []
    rejected = 0
    for match in re.finditer(rb'["\\\n]', raw):
        offset = match.start()
        byte = match.group()
        if offset == escaped_at:
            continue
        if byte == b"\\":
            if quoted:
                escaped_at = offset + 1
        elif byte == b'"':
            quoted = not quoted
        elif not quoted:
            record = raw[start : offset + 1]
            start = offset + 1
            try:
                row = next(
                    csv.reader(
                        io.StringIO(record.decode("utf-8")),
                        escapechar="\\",
                        doublequote=False,
                    )
                )
            except (csv.Error, UnicodeDecodeError, StopIteration):
                rejected += 1
                continue
            if (
                len(row) == len(OPINION_FIELDS)
                and row[0].isdigit()
                and row[-1].isdigit()
            ):
                rows.append(row)
            else:
                rejected += 1
    return rows, rejected


def recover_part(
    recover: Path,
    range_file: Path,
    output: Path,
    receipt: Path,
    start: int,
    end: int,
) -> None:
    work = range_file.parent
    for stale in work.glob("rec*.bz2"):
        stale.unlink()
    log = work / "bzip2recover.log"
    with log.open("w", encoding="utf-8") as handle:
        subprocess.run(
            [str(recover), range_file.name],
            cwd=work,
            stdout=handle,
            stderr=subprocess.STDOUT,
            check=True,
        )
    blocks = sorted(work.glob("rec*.bz2"))
    if not blocks:
        raise RuntimeError(f"No complete bzip2 blocks recovered from {range_file}")
    raw = b"".join(bz2.decompress(block.read_bytes()) for block in blocks)
    candidates = [parsed_rows(raw, False), parsed_rows(raw, True)]
    candidates.sort(key=lambda candidate: len(candidate[0]), reverse=True)
    rows, rejected = candidates[0]
    if not rows:
        raise RuntimeError(f"No complete opinion rows recovered from {range_file}")
    if len(candidates[1][0]) == len(rows) and candidates[1][0] != rows:
        raise RuntimeError(f"Ambiguous CSV quote state in {range_file}")

    temporary = output.with_suffix(output.suffix + ".tmp")
    with bz2.open(temporary, "wt", encoding="utf-8", newline="") as handle:
        writer = csv.writer(
            handle,
            escapechar="\\",
            doublequote=False,
            quoting=csv.QUOTE_MINIMAL,
        )
        writer.writerow(OPINION_FIELDS)
        writer.writerows(rows)
    temporary.replace(output)
    record = {
        "start": start,
        "end": end,
        "range_bytes": end - start + 1,
        "recovered_blocks": len(blocks),
        "recovered_bytes": len(raw),
        "rows": len(rows),
        "rejected_boundaries": rejected,
        "output_bytes": output.stat().st_size,
    }
    receipt_temp = receipt.with_suffix(receipt.suffix + ".tmp")
    receipt_temp.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    receipt_temp.replace(receipt)


def complete_part(output: Path, receipt: Path, start: int, end: int) -> bool:
    if not output.is_file() or not receipt.is_file():
        return False
    try:
        record = json.loads(receipt.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return record.get("start") == start and record.get("end") == end


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, help="Dump date, e.g. 2026-06-30")
    parser.add_argument("--cache-dir", default=str(default_cache()))
    parser.add_argument("--ranges", type=int, default=256)
    parser.add_argument("--supplemental-ranges", type=int, default=0)
    parser.add_argument("--range-bytes", type=int, default=5 * 1024 * 1024)
    parser.add_argument("--bzip2recover")
    args = parser.parse_args()

    field_limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(field_limit)
            break
        except OverflowError:
            field_limit //= 10

    cache = Path(args.cache_dir).expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    sample = cache / f"opinions-{args.snapshot}.stratified-{args.ranges}x{args.range_bytes}"
    parts = sample / "parts"
    work_root = sample / "work"
    parts.mkdir(parents=True, exist_ok=True)
    work_root.mkdir(parents=True, exist_ok=True)

    opinions_name = f"opinions-{args.snapshot}.csv.bz2"
    opinions_url = BASE + opinions_name
    opinions_size = remote_size(opinions_url)
    plan = range_plan(opinions_size, args.ranges, args.range_bytes) + midpoint_plan(
        opinions_size,
        args.supplemental_ranges,
        args.range_bytes,
    )
    recover = bzip2recover_path(args.bzip2recover)
    print(
        f"Sampling {len(plan)} x {args.range_bytes:,} bytes across "
        f"{opinions_size:,} bytes with {recover}",
        flush=True,
    )

    for index, (start, end) in enumerate(plan):
        output = parts / f"part-{index:04d}.csv.bz2"
        receipt = parts / f"part-{index:04d}.json"
        if complete_part(output, receipt, start, end):
            print(f"[{index + 1}/{len(plan)}] complete", flush=True)
            continue
        work = work_root / f"part-{index:04d}"
        work.mkdir(parents=True, exist_ok=True)
        range_file = work / "range.bin"
        print(
            f"[{index + 1}/{len(plan)}] bytes {start:,}-{end:,}",
            flush=True,
        )
        download(opinions_url, range_file, start=start, end=end)
        recover_part(recover, range_file, output, receipt, start, end)
        shutil.rmtree(work)
        record = json.loads(receipt.read_text(encoding="utf-8"))
        print(
            f"  retained {record['rows']:,} rows / "
            f"{record['recovered_bytes']:,} raw bytes",
            flush=True,
        )

    for name in (
        f"dockets-{args.snapshot}.csv.bz2",
        f"courts-{args.snapshot}.csv.bz2",
    ):
        download(BASE + name, cache / name)

    receipts = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(parts.glob("part-*.json"))
    ]
    manifest = {
        "snapshot": args.snapshot,
        "source": opinions_url,
        "source_bytes": opinions_size,
        "base_ranges": args.ranges,
        "supplemental_ranges": args.supplemental_ranges,
        "ranges": len(plan),
        "range_bytes": args.range_bytes,
        "sampled_compressed_bytes": sum(item["range_bytes"] for item in receipts),
        "recovered_bytes": sum(item["recovered_bytes"] for item in receipts),
        "rows": sum(item["rows"] for item in receipts),
        "parts": receipts,
    }
    temporary = sample / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(sample / "manifest.json")
    print(
        f"Complete: {manifest['rows']:,} opinions, "
        f"{manifest['recovered_bytes']:,} raw bytes in {sample}",
        flush=True,
    )


if __name__ == "__main__":
    main()
