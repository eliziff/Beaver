"""Generate the three-tier LAB corpus split (dev / validation / sealed).

The tier unit is the TASK (tasks/<area>/<slug>): sibling scenarios share
documents and rubric style, so they never straddle tiers. Exposed tasks
(already run or read during development) are forced into dev. The rest
are assigned by seeded stratified draw over (practice area, genre) cells,
genre being the task slug's leading verb. Every file of every task is
hashed so a restored sealed tier can be verified byte-for-byte.

Usage:
  python split-corpus.py --lab-root ../harvey-labs --out corpus-split.json
"""

import argparse
import hashlib
import json
import random
from datetime import datetime, timezone
from pathlib import Path

SEED = 20260729
DEV_TARGET = 60
VALIDATION_TARGET = 150

EXPOSED = {
    # graded or attempted runs (results/<run>/config.json)
    "antitrust-competition/prepare-antitrust-risk-assessment": "run",
    "arbitration-international-dispute-resolution/identify-arbitration-agreement-markup": "run",
    "banking-finance/extract-credit-agreement-covenants": "run",
    "bankruptcy-restructuring/extract-critical-vendor-terms-from-supply-contracts": "run",
    "real-estate/extract-psa-key-terms": "run",
    "trusts-estates-private-client/extract-client-intake-facts": "run",
    # read during the 2026-07-29 held-out false-positive sweep
    "antitrust-competition/compare-expert-market-share-estimates-against-agency-data": "fp-sweep",
    "banking-finance/compare-compliance-certificate-against-financial-covenants": "fp-sweep",
    "bankruptcy-restructuring/compare-distribution-amounts-against-plan-requirements": "fp-sweep",
    "capital-markets/draft-indenture-for-senior-secured-notes-offering": "fp-sweep",
    "corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts": "fp-sweep",
    "corporate-ma/draft-acquisition-due-diligence": "fp-sweep",
    "energy-natural-resources/analyze-counterparty-markup-of-intercreditor-agreement": "fp-sweep",
    "tax/draft-transfer-pricing-documentation": "fp-sweep",
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def task_hash(task_dir: Path) -> tuple[str, int, int]:
    lines = []
    files = 0
    size = 0
    for path in sorted(task_dir.rglob("*")):
        if path.is_file():
            files += 1
            size += path.stat().st_size
            rel = path.relative_to(task_dir).as_posix()
            lines.append(f"{rel}:{file_sha256(path)}")
    combined = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
    return combined, files, size


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab-root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--hash-cache",
        help="Prior manifest whose per-task sha256/files/bytes are reused",
    )
    args = parser.parse_args()

    cache: dict[str, dict] = {}
    if args.hash_cache and Path(args.hash_cache).exists():
        prior = json.loads(Path(args.hash_cache).read_text(encoding="utf-8"))
        cache = {entry["task"]: entry for entry in prior.get("tasks", [])}

    tasks_root = Path(args.lab_root) / "tasks"
    units = []
    for area_dir in sorted(tasks_root.iterdir()):
        if not area_dir.is_dir():
            continue
        for task_dir in sorted(area_dir.iterdir()):
            if not task_dir.is_dir():
                continue
            rel = f"{area_dir.name}/{task_dir.name}"
            genre = task_dir.name.split("-", 1)[0]
            scenarios = sorted(
                child.name
                for child in task_dir.iterdir()
                if child.is_dir() and child.name.startswith("scenario-")
            )
            units.append(
                {
                    "task": rel,
                    "area": area_dir.name,
                    "genre": genre,
                    "scenarios": scenarios,
                    "dir": task_dir,
                }
            )

    rng = random.Random(SEED)
    by_tier: dict[str, str] = {}
    for unit in units:
        if unit["task"] in EXPOSED:
            by_tier[unit["task"]] = "dev"

    area_total: dict[str, int] = {}
    for unit in units:
        area_total[unit["area"]] = area_total.get(unit["area"], 0) + 1

    def area_visible(area: str) -> int:
        return sum(
            1
            for unit in units
            if unit["area"] == area and by_tier.get(unit["task"]) in ("dev", "validation")
        )

    # Every area keeps a sealed majority: dev+validation together may take
    # at most 40% of an area (exposure forced into dev counts against it).
    MAX_VISIBLE_SHARE = 0.4

    def stratified_fill(tier: str, target: int) -> None:
        by_area: dict[str, list[dict]] = {}
        for unit in units:
            if unit["task"] in by_tier:
                continue
            by_area.setdefault(unit["area"], []).append(unit)
        for members in by_area.values():
            rng.shuffle(members)
            # Draw across genres before repeating one: stable genre order,
            # then interleave.
            members.sort(key=lambda unit: unit["genre"])
        order = sorted(by_area.keys())
        assigned = sum(1 for tier_name in by_tier.values() if tier_name == tier)
        cursor = {area: 0 for area in order}
        while assigned < target:
            progressed = False
            for area in order:
                if assigned >= target:
                    break
                members = by_area[area]
                while cursor[area] < len(members):
                    candidate = members[cursor[area]]
                    cursor[area] += 1
                    if candidate["task"] in by_tier:
                        continue
                    if (
                        area_visible(area) + 1
                        > MAX_VISIBLE_SHARE * area_total[area]
                    ):
                        break
                    by_tier[candidate["task"]] = tier
                    assigned += 1
                    progressed = True
                    break
            if not progressed:
                break

    stratified_fill("dev", DEV_TARGET)
    stratified_fill("validation", VALIDATION_TARGET)
    for unit in units:
        by_tier.setdefault(unit["task"], "sealed")

    entries = []
    for unit in units:
        cached = cache.get(unit["task"])
        if cached:
            combined, files, size = cached["sha256"], cached["files"], cached["bytes"]
        else:
            combined, files, size = task_hash(unit["dir"])
        entries.append(
            {
                "task": unit["task"],
                "tier": by_tier[unit["task"]],
                "area": unit["area"],
                "genre": unit["genre"],
                "scenarios": unit["scenarios"],
                "files": files,
                "bytes": size,
                "sha256": combined,
                **(
                    {"exposed": EXPOSED[unit["task"]]}
                    if unit["task"] in EXPOSED
                    else {}
                ),
            }
        )

    counts: dict[str, int] = {}
    for entry in entries:
        counts[entry["tier"]] = counts.get(entry["tier"], 0) + 1

    manifest = {
        "seed": SEED,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "unit": "task",
        "counts": counts,
        "exposed": dict(EXPOSED),
        "tasks": entries,
    }
    Path(args.out).write_text(
        json.dumps(manifest, indent=1, sort_keys=False) + "\n", encoding="utf-8"
    )
    print(f"units={len(entries)} counts={counts}")
    per_area: dict[str, dict[str, int]] = {}
    for entry in entries:
        per_area.setdefault(entry["area"], {"dev": 0, "validation": 0, "sealed": 0})
        per_area[entry["area"]][entry["tier"]] += 1
    for area, tally in sorted(per_area.items()):
        print(f"  {area:<45} dev={tally['dev']:>2} val={tally['validation']:>3} sealed={tally['sealed']:>3}")


if __name__ == "__main__":
    main()
