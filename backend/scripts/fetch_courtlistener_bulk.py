#!/usr/bin/env python3
"""Fetch a bounded, keyless slice of CourtListener's official bulk CSVs.

CourtListener publishes monthly CSV dumps that need no account or API key.
The citations (~127 MB) and opinion-clusters (~2.5 GB) files are downloaded
in full; the opinions file (~55 GB, no per-court slices exist) is bounded by
an HTTP Range request and cut at the last complete CSV record, so the slice
is deterministic for a given snapshot date and byte budget. Feed the results
to import_courtlistener_bulk.py, which streams .csv and .csv.bz2 directly.
"""

from __future__ import annotations

import argparse
import bz2
import re
import time
import urllib.request
from pathlib import Path

from open_legal_data_bridge import data_root


BASE = "https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/"
CHUNK = 1 << 20


def default_cache() -> Path:
    return (data_root() / "cache" / "courtlistener").resolve()


def remote_size(url: str) -> int:
    request = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(request, timeout=60) as response:
        return int(response.headers["Content-Length"])


def report(name: str, received: int, started: float) -> None:
    elapsed = time.monotonic() - started
    speed = received / elapsed / 1_048_576 if elapsed else 0.0
    print(f"  {name}: {received:,} bytes in {elapsed:,.1f}s ({speed:,.1f} MB/s)")


def download_full(name: str, target: Path) -> None:
    url = BASE + name
    expected = remote_size(url)
    if target.is_file() and target.stat().st_size == expected:
        print(f"  {name}: already downloaded ({expected:,} bytes)")
        return
    started = time.monotonic()
    temporary = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(url, timeout=300) as response:
        with temporary.open("wb") as out:
            while chunk := response.read(CHUNK):
                out.write(chunk)
    if temporary.stat().st_size != expected:
        raise OSError(f"{name}: got {temporary.stat().st_size}, want {expected}")
    temporary.replace(target)
    report(name, expected, started)


class RecordCutter:
    """Track the last byte offset that ends a complete CSV record.

    The bulk CSVs quote every field and escape embedded quotes with a
    backslash (never doubled quotes), so a newline outside quotes always
    terminates a record.
    """

    def __init__(self) -> None:
        self.position = 0
        self.safe_end = 0
        self.records = 0
        self.quoted = False
        self.escaped_at = -1

    def feed(self, data: bytes) -> None:
        for match in re.finditer(rb'["\\\n]', data):
            offset = self.position + match.start()
            if offset == self.escaped_at:
                continue
            byte = match.group()
            if byte == b"\\":
                if self.quoted:
                    self.escaped_at = offset + 1
            elif byte == b'"':
                self.quoted = not self.quoted
            elif not self.quoted:
                self.safe_end = offset + 1
                self.records += 1
        self.position += len(data)


def download_opinions_head(url: str, target: Path, byte_budget: int) -> None:
    if target.is_file():
        print(f"  {target.name}: already sliced ({target.stat().st_size:,} bytes)")
        return
    started = time.monotonic()
    request = urllib.request.Request(
        url, headers={"Range": f"bytes=0-{byte_budget - 1}"}
    )
    cutter = RecordCutter()
    decompressor = bz2.BZ2Decompressor()
    temporary = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(request, timeout=300) as response:
        with temporary.open("wb") as out:
            while chunk := response.read(CHUNK):
                while chunk:
                    raw = decompressor.decompress(chunk)
                    cutter.feed(raw)
                    out.write(raw)
                    chunk = decompressor.unused_data
                    if chunk:
                        decompressor = bz2.BZ2Decompressor()
                    else:
                        break
            out.truncate(cutter.safe_end)
    temporary.replace(target)
    rows = max(0, cutter.records - 1)  # first record is the header
    report(f"{target.name} ({rows:,} opinion rows)", cutter.safe_end, started)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, help="Dump date, e.g. 2026-06-30")
    parser.add_argument("--cache-dir", default=str(default_cache()))
    parser.add_argument(
        "--opinions-bytes",
        type=int,
        default=128 * 1024 * 1024,
        help="Compressed byte budget for the opinions prefix (default 128 MiB)",
    )
    args = parser.parse_args()
    cache = Path(args.cache_dir).expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)

    citations = cache / f"citations-{args.snapshot}.csv.bz2"
    clusters = cache / f"opinion-clusters-{args.snapshot}.csv.bz2"
    opinions = cache / f"opinions-{args.snapshot}.head-{args.opinions_bytes}.csv"
    download_full(citations.name, citations)
    download_full(clusters.name, clusters)
    download_opinions_head(
        BASE + f"opinions-{args.snapshot}.csv.bz2", opinions, args.opinions_bytes
    )
    print("Import with:")
    print(
        "  python scripts/import_courtlistener_bulk.py"
        f' --citations "{citations}" --clusters "{clusters}"'
        f' --opinions "{opinions}" --opinion-fts'
    )


if __name__ == "__main__":
    main()
