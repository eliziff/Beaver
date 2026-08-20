"""Cold Python reference-path guard for 37,000 US citation inputs."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "legal-pdf-parser" / "src"))

from legalpdf.deterministic_citations import split_footnote_recall_first


CASES = (
    ("Roe v Wade, 410 U.S. 113.", ("reporter",)),
    ("See 410 U.S. at 115.", ("reporter",)),
    ("Claim under 42 U.S.C. § 1983.", ("statute",)),
    ("Article at 123 Harv. L. Rev. 456.", ("journal",)),
)


def checkpoint(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=37_000)
    parser.add_argument("--max-seconds", type=float, default=15.0)
    args = parser.parse_args()
    output = Path(__file__).parent / "results" / "performance-latest.json"
    started = time.perf_counter()
    interval = max(1, args.count // 10)
    failures: list[dict] = []

    for index in range(args.count):
        text, expected = CASES[index % len(CASES)]
        result = split_footnote_recall_first(text)
        got = tuple(anchor for part in result.parts for anchor in part.anchors)
        if got != expected:
            failures.append({"index": index, "input": text, "expected": expected, "got": got})
        completed = index + 1
        if completed % interval == 0 or completed == args.count:
            elapsed = time.perf_counter() - started
            payload = {
                "format": "beaver.eyecite-us-performance.v1",
                "completed": completed,
                "count": args.count,
                "elapsed_seconds": round(elapsed, 3),
                "failures": failures[:20],
            }
            checkpoint(output, payload)
            print(f"{completed:,}/{args.count:,}; {elapsed:.3f}s", flush=True)

    elapsed = time.perf_counter() - started
    passed = not failures and elapsed <= args.max_seconds
    payload.update({"max_seconds": args.max_seconds, "passed": passed})
    checkpoint(output, payload)
    print(json.dumps(payload, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
