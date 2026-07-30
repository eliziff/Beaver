#!/usr/bin/env python
"""CLASS 1 inventory: mine court-code token sequences from provider citations.

The grammar table's cite.neutral requires the court code to be ONE ALL-CAPS
token ([A-Z][A-Z0-9-]{1,15}).  The recall survey found a gap ("2000 Trib conc
8").  This probe does not guess the rest of the class -- it reads the
providers' OWN citation strings and reports every distinct token sequence that
actually appears between a year and a number:

  * A2AJ bulk parquets (cases/ and laws/): citation_en, citation2_en,
    citation_fr, citation2_fr  -- the provider's canonical citation for the
    document itself.
  * A2AJ cases_cited_en / cases_cited_fr -- the provider's citation strings
    for every decision each document cites (covers courts far beyond the 29
    mirrored dirs).
  * CanLII index (sqlite, 3.5M cases.caseId) -- the *normalized* slug form
    (2019scc65), which gives the code inventory but not its surface spelling.

Output: JSON to stdout (or --out), plus a human summary to stderr.

Run:  python -X utf8 benchmarks/structure_stress/probes/cite_class1_mine.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

CORPUS = Path.home() / "AppData" / "Local" / "ALR Quote Verifier" / "a2aj_corpus"
CANLII_DB = (
    Path.home() / "AppData" / "Local" / "ALR Quote Verifier" / "data"
    / "canlii-186d92f8c0a4.db"
)

# Deliberately permissive miner.  A "token" starts with a letter (ASCII or
# Latin-1/Latin-Extended-A accented) and may carry digits, periods, hyphens
# and apostrophes.  1..5 tokens between year and trailing number.  This is a
# MINER, not a proposal: its job is to over-collect so the inventory is
# complete, then we classify what came back.
_TOK = r"[A-Za-zÀ-ɏ][A-Za-z0-9À-ɏ.'’-]*"
MINER = re.compile(
    r"(?<![\w.\]\)])(?P<year>(?:1[6-9]|20)\d{2})[    ]+"
    rf"(?P<code>{_TOK}(?:[    ]+{_TOK}){{0,4}})"
    r"[    ]+(?P<num>\d{1,6})(?![\d])"
)


def classify(code: str) -> str:
    toks = code.split()
    accented = any(ord(ch) > 127 for ch in code)
    if len(toks) > 1:
        return "multi-token+accent" if accented else "multi-token"
    tok = toks[0]
    if accented:
        return "single-accented"
    # what cite.neutral already accepts: [A-Z][A-Z0-9-]{1,15}
    if re.fullmatch(r"[A-Z][A-Z0-9-]{1,15}", tok):
        return "single-allcaps-covered"
    if re.fullmatch(r"[A-Z][A-Z0-9-]{16,}", tok):
        return "single-allcaps-toolong"
    return "single-mixedcase"


def strip_accents(s: str) -> str:
    return "".join(
        ch for ch in unicodedata.normalize("NFD", s)
        if unicodedata.category(ch) != "Mn"
    )


def mine_parquets(corpus: Path, hits: Counter, examples: dict, sources: dict) -> dict:
    import duckdb

    con = duckdb.connect()
    stats = {"files": 0, "citation_cells": 0, "cited_cells": 0}
    files = sorted(corpus.glob("cases/*/train.parquet")) + sorted(
        corpus.glob("laws/*/train.parquet")
    )
    for parquet in files:
        stats["files"] += 1
        dataset = parquet.parent.name
        cols = [r[0] for r in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{parquet.as_posix()}')"
        ).fetchall()]
        cite_cols = [c for c in ("citation_en", "citation2_en", "citation_fr",
                                 "citation2_fr") if c in cols]
        for col in cite_cols:
            rows = con.execute(
                f"SELECT {col} FROM read_parquet('{parquet.as_posix()}') "
                f"WHERE {col} IS NOT NULL AND {col} <> ''"
            ).fetchall()
            for (cell,) in rows:
                stats["citation_cells"] += 1
                record(cell, f"{dataset}/{col}", hits, examples, sources)
        for col in ("cases_cited_en", "cases_cited_fr"):
            if col not in cols:
                continue
            rows = con.execute(
                f"SELECT {col} FROM read_parquet('{parquet.as_posix()}') "
                f"WHERE len({col}) > 0"
            ).fetchall()
            for (arr,) in rows:
                for cell in arr or ():
                    if not cell:
                        continue
                    stats["cited_cells"] += 1
                    record(cell, f"{dataset}/{col}", hits, examples, sources)
    return stats


def record(cell: str, source: str, hits: Counter, examples: dict, sources: dict) -> None:
    for m in MINER.finditer(cell):
        code = re.sub(r"[    ]+", " ", m.group("code"))
        hits[code] += 1
        sources[code][source] += 1
        if len(examples[code]) < 6 and cell not in examples[code]:
            examples[code].append(cell)


def mine_canlii(db: Path) -> dict:
    import sqlite3

    con = sqlite3.connect(str(db))
    slug = re.compile(r"^(?P<year>\d{4})(?P<code>[a-z][a-z0-9]*?)(?P<num>\d+)$")
    codes: Counter = Counter()
    total = odd = 0
    for (case_id,) in con.execute("SELECT caseId FROM cases"):
        total += 1
        if not case_id:
            odd += 1
            continue
        m = slug.match(case_id)
        if not m:
            odd += 1
            continue
        codes[m.group("code")] += 1
    con.close()
    return {"total": total, "unparsed": odd, "codes": codes}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, default=CORPUS)
    ap.add_argument("--canlii", type=Path, default=CANLII_DB)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--skip-canlii", action="store_true")
    args = ap.parse_args()

    hits: Counter = Counter()
    examples: dict[str, list[str]] = defaultdict(list)
    sources: dict[str, Counter] = defaultdict(Counter)
    stats = mine_parquets(args.corpus, hits, examples, sources)
    print(f"parquets={stats['files']} citation_cells={stats['citation_cells']} "
          f"cited_cells={stats['cited_cells']} distinct_codes={len(hits)}",
          file=sys.stderr)

    buckets: dict[str, list] = defaultdict(list)
    for code, n in hits.most_common():
        buckets[classify(code)].append(
            {"code": code, "n": n, "examples": examples[code],
             "sources": sources[code].most_common(5)}
        )
    for name, items in sorted(buckets.items()):
        print(f"  {name}: {len(items)} codes, {sum(i['n'] for i in items)} hits",
              file=sys.stderr)

    out: dict = {"parquet_stats": stats, "buckets": {k: v for k, v in buckets.items()}}

    if not args.skip_canlii and args.canlii.is_file():
        cl = mine_canlii(args.canlii)
        print(f"canlii caseIds={cl['total']} unparsed={cl['unparsed']} "
              f"distinct_slug_codes={len(cl['codes'])}", file=sys.stderr)
        # Which parquet-surface codes reduce onto a canlii slug code?
        surface_norm = {
            code: strip_accents(code).lower().replace(" ", "").replace(".", "")
            for code in hits
        }
        matched = {c: cl["codes"].get(n, 0) for c, n in surface_norm.items()}
        out["canlii"] = {
            "total": cl["total"],
            "unparsed": cl["unparsed"],
            "codes": cl["codes"].most_common(),
            "surface_to_slug": {
                c: {"slug": surface_norm[c], "slug_n": matched[c], "surface_n": hits[c]}
                for c in sorted(hits, key=lambda x: -hits[x])
            },
        }

    text = json.dumps(out, ensure_ascii=False, indent=1)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
