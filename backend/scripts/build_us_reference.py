"""Fetch a stratified US case-law reference sample from CAP static BULK.

Feeds the jurisdiction-matched US alienness index (H13 gate recorded in
the research plan: "no threshold generalizes ... until the
jurisdiction-matched, claim-segmented re-test passes" — the re-test
passed for claim-vs-source features; this closes the reference side).
Stratified across federal and regional/state reporters the way the
Canadian reference stratifies across courts; seeded volume choice makes
the sample reproducible and the manifest records exactly what went in.

BULK-FIRST (standing directive 2026-07-30): CAP static serves whole
volumes as single zips (<slug>/<volume>.zip containing json/*.json),
so this fetches ONE request per volume — never per-case JSON calls —
and keeps the zips on disk under zips/, making every re-run offline.

Output: %LOCALAPPDATA%/ALR Quote Verifier/alienness/us_reference/
    zips/<slug>-<volume>.zip   cached bulk volumes (offline re-runs)
    docs.jsonl    {"text", "reporter", "volume", "cap_id",
                   "decision_date", "court"}
    manifest.json per-reporter doc/char counts + config

    python -X utf8 scripts/build_us_reference.py --per-reporter-volumes 6
"""
from __future__ import annotations

import argparse
import io
import json
import os
import random
import sys
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CAP = "https://static.case.law"

# Stratification: SCOTUS + federal appellate/trial + the regional
# reporters (state appellate coverage) + a few high-volume state courts.
REPORTERS = [
    "us", "s-ct", "f2d", "f3d", "f-supp", "f-supp-2d",
    "p2d", "p3d", "ne2d", "nw2d", "a2d", "so-2d", "se2d", "sw2d",
    "cal-app-4th", "ny-s2d", "ill-app-3d", "ohio-st-3d",
]


def out_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / "ALR Quote Verifier" / "alienness" / "us_reference"


def get_bytes(url: str) -> bytes:
    req = urllib.request.Request(
        url, headers={"User-Agent": "beaver-research/1.0 (reference corpus)"}
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return resp.read()


def get_json(url: str):
    return json.loads(get_bytes(url).decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-reporter-volumes", type=int, default=6)
    parser.add_argument("--seed", type=int, default=47)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    directory = out_dir()
    directory.mkdir(parents=True, exist_ok=True)
    docs_path = directory / "docs.jsonl"
    manifest: dict[str, dict[str, int]] = {}

    zips_dir = directory / "zips"
    zips_dir.mkdir(exist_ok=True)

    def volume_rows(item: tuple[str, str]) -> list[dict]:
        """One bulk request per volume; cached zip makes re-runs offline."""
        slug, volume = item
        cache = zips_dir / f"{slug}-{volume}.zip"
        if not cache.exists():
            try:
                cache.write_bytes(get_bytes(f"{CAP}/{slug}/{volume}.zip"))
            except Exception as exc:  # noqa: BLE001
                print(f"[skip volume] {slug}/{volume}: {exc}", file=sys.stderr)
                return []
        rows: list[dict] = []
        with zipfile.ZipFile(cache) as archive:
            for name in archive.namelist():
                if not (name.startswith("json/") and name.endswith(".json")):
                    continue
                case = json.loads(archive.read(name).decode("utf-8"))
                text = "\n".join(
                    op.get("text") or ""
                    for op in (case.get("casebody") or {}).get("opinions") or []
                ).strip()
                if not text:
                    continue
                rows.append(
                    {
                        "text": text,
                        "reporter": slug,
                        "volume": volume,
                        "cap_id": case.get("id"),
                        "decision_date": case.get("decision_date"),
                        "court": (case.get("court") or {}).get("name"),
                    }
                )
        return rows

    with open(docs_path, "w", encoding="utf-8") as out:
        for slug in REPORTERS:
            try:
                volumes = get_json(f"{CAP}/{slug}/VolumesMetadata.json")
            except Exception as exc:  # noqa: BLE001
                print(f"[skip reporter] {slug}: {exc}", file=sys.stderr)
                continue
            numbers = [v["volume_number"] for v in volumes if v.get("volume_number")]
            chosen = rng.sample(numbers, min(args.per_reporter_volumes, len(numbers)))
            docs = 0
            chars = 0
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                for rows in pool.map(
                    volume_rows, [(slug, str(v)) for v in chosen]
                ):
                    for row in rows:
                        out.write(json.dumps(row, ensure_ascii=False) + "\n")
                        docs += 1
                        chars += len(row["text"])
            manifest[slug] = {"volumes": len(chosen), "docs": docs, "chars": chars}
            print(f"[{slug}] volumes={len(chosen)} docs={docs} chars={chars}", flush=True)

    total_docs = sum(m["docs"] for m in manifest.values())
    total_chars = sum(m["chars"] for m in manifest.values())
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "seed": args.seed,
                "per_reporter_volumes": args.per_reporter_volumes,
                "reporters": manifest,
                "total_docs": total_docs,
                "total_chars": total_chars,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"us_reference: {total_docs} docs, {total_chars / 1e6:.0f}M chars -> {docs_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
