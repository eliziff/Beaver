#!/usr/bin/env python
"""Does the proposed CLASS 1 sibling close the recall gap it was mined for?

Same instrument as legal-pdf-parser/tools/grammar_recall.py (same
reservoir seed 42, same gold definition: `cases_cited_<lang>` entries located
in the decision text), but the coverage set is configurable so the four
shipped citation entries can be scored with and without a candidate sibling.

Reports recall before/after per court/lang and lists any residual miss.

Throttle contract: one small court parquet at a time (CT=637 rows,
CIRB=1,182), single-threaded.

Run:
  python -X utf8 benchmarks/structure_stress/probes/cite_class1_recall.py \
      --courts CT,CIRB
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "legal-pdf-parser" / "src"))
import legalpdf.grammar_tables as gt  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cite_class1_propose import (  # noqa: E402
    BASELINE_IDS, build_dotted_enum, build_enum, compile_candidate, known_codes,
)

CORPUS = Path.home() / "AppData" / "Local" / "ALR Quote Verifier" / "a2aj_corpus"


def occurrence_re(citation: str) -> re.Pattern[str] | None:
    tokens = citation.split()
    if not tokens:
        return None
    return re.compile(r"\s+".join(re.escape(t) for t in tokens))


def sample_rows(parquet: Path, lang: str, n: int):
    import duckdb

    text_col, cited_col = f"unofficial_text_{lang}", f"cases_cited_{lang}"
    query = (
        f"SELECT {text_col}, {cited_col} FROM ("
        f"  SELECT {text_col}, {cited_col} FROM read_parquet(?)"
        f"  WHERE {text_col} IS NOT NULL AND len({cited_col}) > 0"
        f") USING SAMPLE {int(n)} ROWS (reservoir, 42)"
    )
    rows = duckdb.connect().execute(query, [str(parquet)]).fetchall()
    return [(t, list(c)) for t, c in rows if isinstance(t, str)]


def score(rows, patterns) -> tuple[int, int, int, list[str]]:
    gold = absent = found = 0
    missed: list[str] = []
    for text, cited in rows:
        spans = None
        for citation in dict.fromkeys(cited):
            finder = occurrence_re(citation)
            if finder is None:
                continue
            occurrences = [m.span() for m in finder.finditer(text)]
            gold += 1
            if not occurrences:
                absent += 1
                continue
            if spans is None:
                spans = [m.span() for p in patterns.values() for m in p.finditer(text)]
            hit = any(s <= os and oe <= e for os, oe in occurrences for s, e in spans)
            if hit:
                found += 1
            else:
                missed.append(citation)
    return gold, absent, found, missed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, default=CORPUS)
    ap.add_argument("--tables", type=Path, default=REPO / "shared" / "grammar-tables")
    ap.add_argument("--mined", type=Path, required=True)
    ap.add_argument("--surfaces", type=Path, default=None)
    ap.add_argument("--courts", default="CT,CIRB")
    ap.add_argument("--sample", type=int, default=60)
    args = ap.parse_args()

    table = json.loads((args.tables / "citations.json").read_text(encoding="utf-8"))
    defs = table.get("defs") or {}
    base = {e["id"]: gt.compile_entry(e, defs)
            for e in table["entries"] if e["id"] in BASELINE_IDS}

    mined = json.loads(args.mined.read_text(encoding="utf-8"))
    multi = [i["code"] for i in mined["buckets"].get("multi-token", [])]
    if args.surfaces and args.surfaces.is_file():
        census = json.loads(args.surfaces.read_text(encoding="utf-8"))
        multi += [c["code"] for c in census["codes"]
                  if c["known"] and c["family"].startswith("multi-token")
                  and c["code"] not in multi]
    multi = [m for m in multi if m != "ON CA"]
    proposed = {
        "cite.neutral.tribunal": compile_candidate(build_enum(multi)),
        "cite.neutral.dotted": compile_candidate(build_dotted_enum()),
    }
    print(f"baseline: {sorted(base)}")
    print(f"proposed siblings: {sorted(proposed)}  (multi-token members: {multi})")
    print()

    hdr = (f"{'court':6s} {'lang':4s} {'docs':>4s} {'gold':>5s} {'absent':>6s} "
           f"{'base':>5s} {'base%':>6s} {'+sib':>5s} {'+sib%':>6s}")
    print(hdr)
    print("-" * len(hdr))
    residual: list[str] = []
    for court in [c.strip().upper() for c in args.courts.split(",") if c.strip()]:
        parquet = args.corpus / "cases" / court / "train.parquet"
        if not parquet.is_file():
            print(f"{court}: no parquet")
            continue
        for lang in ("en", "fr"):
            rows = sample_rows(parquet, lang, args.sample)
            if not rows:
                continue
            gold, absent, found_b, miss_b = score(rows, base)
            _, _, found_a, miss_a = score(rows, {**base, **proposed})
            denom = gold - absent
            rb = 100.0 * found_b / denom if denom else 0.0
            ra = 100.0 * found_a / denom if denom else 0.0
            print(f"{court:6s} {lang:4s} {len(rows):4d} {gold:5d} {absent:6d} "
                  f"{found_b:5d} {rb:5.1f}% {found_a:5d} {ra:5.1f}%")
            residual += [f"{court}/{lang} {m}" for m in miss_a]
    print()
    print(f"residual misses after siblings: {len(residual)}")
    for m in residual[:20]:
        print(f"   {m}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
