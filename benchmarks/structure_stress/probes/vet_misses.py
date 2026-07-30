"""Vet every previously-flagged miss under the structure cascade.

Doctrine (Eli, 2026-07-29): no-paragraphs is never a verdict. This
probe joins prior failure records back to corpus text and asks, for
each, what structure the cascade actually finds — paragraphs / pages /
endnotes / heading hints / truly none. Output: an old-reason x
cascade-kind cross-table plus a per-doc jsonl for close inspection of
whatever remains 'none'. Single-threaded by design (throttle rules).

    python -X utf8 probes/vet_misses.py [--limit N] \
        [--failures results/smoke/a2aj_cases.failures.jsonl ...]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from structure_ref import structure_cascade  # noqa: E402

A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")


def load_failures(paths: list[Path]) -> dict[str, list[str]]:
    """doc id -> prior fail reasons (case records only)."""
    out: dict[str, list[str]] = {}
    for path in paths:
        if not path.exists():
            print(f"warning: missing {path}", file=sys.stderr)
            continue
        for line in open(path, encoding="utf-8"):
            row = json.loads(line)
            if row.get("kind") == "case" and row.get("fail"):
                out.setdefault(row["id"], row["fail"])
    return out


def fetch(con, court: str, lang: str, citations: list[str]):
    pq = (A2AJ / "cases" / court / "train.parquet").as_posix()
    placeholders = ",".join("?" for _ in citations)
    return con.execute(
        f"""
        select citation_{lang}, unofficial_text_{lang}
        from read_parquet('{pq}')
        where citation_{lang} in ({placeholders})
        """,
        citations,
    ).fetchall()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--failures", nargs="*", default=[
        "results/smoke/a2aj_cases.failures.jsonl",
        "results/full/a2aj_cases.failures.partial-v1.jsonl",
    ])
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--out", default="probes/snap/vet_misses.jsonl")
    args = parser.parse_args()

    import duckdb

    failures = load_failures([HERE.parent / f for f in args.failures])
    print(f"{len(failures)} unique previously-flagged case docs")

    by_court: dict[tuple[str, str], dict[str, list[str]]] = {}
    for doc_id, reasons in failures.items():
        court, rest = doc_id.split(":", 1)
        citation, lang = rest.rsplit(":", 1)
        by_court.setdefault((court, lang), {})[citation] = reasons

    con = duckdb.connect()
    cross: Counter = Counter()
    none_rows: list[dict] = []
    out_path = HERE.parent / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    checked = 0
    with open(out_path, "w", encoding="utf-8") as sink:
        for (court, lang), wanted in sorted(by_court.items()):
            citations = list(wanted)
            if args.limit and checked >= args.limit:
                break
            for citation, text in fetch(con, court, lang, citations):
                if args.limit and checked >= args.limit:
                    break
                checked += 1
                structure = structure_cascade(text or "", citation)
                for reason in wanted[citation]:
                    cross[(reason.split("_0")[0], structure["kind"])] += 1
                row = {
                    "id": f"{court}:{citation}:{lang}",
                    "prior_fail": wanted[citation],
                    "cascade": structure,
                    "chars": len(text or ""),
                }
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")
                if structure["kind"] == "none":
                    none_rows.append(row)

    print(f"\nvetted {checked} docs; cross-table (prior reason -> cascade kind):")
    kinds = sorted({k for _, k in cross})
    reasons = sorted({r for r, _ in cross})
    header = "prior_reason".ljust(34) + "".join(k.rjust(12) for k in kinds)
    print(header)
    for reason in reasons:
        cells = "".join(str(cross.get((reason, k), 0)).rjust(12) for k in kinds)
        print(reason.ljust(34) + cells)

    print(f"\nkind=none (close-inspection queue): {len(none_rows)}")
    for row in none_rows[:10]:
        cascade = row["cascade"]
        print(f"  {row['id'][:60]:60s} chars={row['chars']:>7} "
              f"heading_hints={cascade.get('heading_hint_lines', 0)}")
    print(f"\nper-doc detail: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
