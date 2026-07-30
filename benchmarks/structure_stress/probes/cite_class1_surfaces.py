#!/usr/bin/env python
"""CLASS 1 surface-form census over judgment text (bounded, single-threaded).

The citation-column census (cite_class1_mine.py) reads the providers' canonical
citation strings. This probe reads what the courts THEMSELVES write in prose,
which is where the dialect variation lives: "2005 S.C.C. 39" (dotted),
"Comp. Trib." (dotted multi-token), "Trib Conc" (case variant).

Every candidate the loose miner returns is triaged against the corpus code
universe (A2AJ surface codes + the 348 CanLII slug codes) so real court codes
are separated from prose noise ("1996 to December 31") by corpus membership,
not by taste.

Throttle contract: per-court `LIMIT n` queries, one court/lang at a time,
no multiprocessing, no whole-corpus scan.

Run:
  python -X utf8 benchmarks/structure_stress/probes/cite_class1_surfaces.py \
      --mined <scratch>/class1.json --docs 40
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

CORPUS = Path.home() / "AppData" / "Local" / "ALR Quote Verifier" / "a2aj_corpus"
COURTS = ["SCC", "FCA", "FC", "TCC", "ONCA", "BCCA", "NSCA", "CT", "CITT",
          "CHRT", "CIRB", "CMAC", "FPSLREB", "SST"]

_TOK = r"[A-Za-zÀ-ɏ][A-Za-z0-9À-ɏ.'’-]*"
MINER = re.compile(
    r"(?<![\w.\]\)])(?:1[6-9]|20)\d{2}[  \t]+"
    rf"(?P<code>{_TOK}(?:[  \t]+{_TOK}){{0,3}})"
    r"[  \t]+\d{1,6}(?![\d])"
)
ALLCAPS = re.compile(r"^[A-Z][A-Z0-9-]{1,15}$")


def strip_accents(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFD", s)
                   if unicodedata.category(ch) != "Mn")


def norm(code: str) -> str:
    return strip_accents(code).lower().replace(" ", "").replace(".", "").replace("’", "")


def family(code: str) -> str:
    toks = code.split()
    dotted = "." in code
    accented = any(ord(c) > 127 for c in code)
    if len(toks) > 1:
        base = "multi-token"
    elif ALLCAPS.match(code):
        return "allcaps-single (COVERED by cite.neutral)"
    else:
        base = "single"
    tags = []
    if dotted:
        tags.append("dotted")
    if accented:
        tags.append("accented")
    if len(toks) == 1 and not ALLCAPS.match(code.replace(".", "")):
        tags.append("mixedcase")
    return base + ("[" + "+".join(tags) + "]" if tags else "")


def known_codes(mined: dict, slug_floor: int) -> set[str]:
    """Clean court-code oracle.

    Two contaminated sources are deliberately excluded:
      * A2AJ `cases_cited_*` arrays carry junk rows (observed: 'REASONS',
        'YES', 'OUI', 'XXXXX', 'INDIQUE'), so only `citation*_en/fr` --
        the provider's canonical self-citation -- counts as attestation.
      * CanLII slug codes with tiny counts include scrape artifacts
        (observed: 'and' n=2, 'ljr' n=1), so a frequency floor applies.
    """
    known: set[str] = set()
    for bucket in mined["buckets"].values():
        for item in bucket:
            if any(src.split("/")[1].startswith("citation")
                   for src, _ in item["sources"]):
                known.add(norm(item["code"]))
    for code, n in mined.get("canlii", {}).get("codes", []):
        if n >= slug_floor:
            known.add(code)
    return known


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, default=CORPUS)
    ap.add_argument("--mined", type=Path, required=True)
    ap.add_argument("--docs", type=int, default=40)
    ap.add_argument("--slug-floor", type=int, default=10)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    known = known_codes(json.loads(args.mined.read_text(encoding="utf-8")),
                        args.slug_floor)
    print(f"known-code oracle: {len(known)} codes "
          f"(A2AJ citation_* surfaces + CanLII slugs with n>={args.slug_floor})")

    import duckdb
    con = duckdb.connect()
    hits: Counter = Counter()
    ctx: dict[str, list[str]] = defaultdict(list)
    where: dict[str, Counter] = defaultdict(Counter)
    docs = chars = 0
    for court in COURTS:
        parquet = args.corpus / "cases" / court / "train.parquet"
        if not parquet.is_file():
            continue
        for lang in ("en", "fr"):
            col = f"unofficial_text_{lang}"
            rows = con.execute(
                f"SELECT {col} FROM read_parquet('{parquet.as_posix()}') "
                f"WHERE {col} IS NOT NULL LIMIT {int(args.docs)}"
            ).fetchall()
            for (text,) in rows:
                docs += 1
                chars += len(text)
                for m in MINER.finditer(text):
                    code = re.sub(r"[  \t]+", " ", m.group("code"))
                    hits[code] += 1
                    where[code][f"{court}/{lang}"] += 1
                    if len(ctx[code]) < 3:
                        s = max(0, m.start() - 40)
                        ctx[code].append(
                            re.sub(r"\s+", " ", text[s:m.end() + 25]))
    con.close()

    print(f"docs={docs} chars={chars:,} distinct_codes={len(hits)}")
    fams: dict[str, list] = defaultdict(list)
    for code, n in hits.most_common():
        fams[family(code)].append(code)
    print()
    hdr = f"{'family':44s} {'codes':>5s} {'hits':>6s} {'known':>5s} {'unknown':>7s}"
    print(hdr)
    print("-" * len(hdr))
    for fam in sorted(fams):
        codes = fams[fam]
        kn = sum(hits[c] for c in codes if norm(c) in known)
        un = sum(hits[c] for c in codes) - kn
        print(f"{fam:44s} {len(codes):5d} {sum(hits[c] for c in codes):6d} "
              f"{kn:5d} {un:7d}")
    print()
    for fam in sorted(fams):
        if fam.startswith("allcaps-single"):
            continue
        print(f"### {fam}")
        for code in fams[fam]:
            tag = "KNOWN" if norm(code) in known else "noise"
            print(f"   {hits[code]:5d} {tag} {code!r}  {where[code].most_common(3)}")
            if tag == "KNOWN":
                for c in ctx[code][:2]:
                    print(f"          ...{c}...")
    if args.out:
        args.out.write_text(json.dumps(
            {"docs": docs, "chars": chars,
             "codes": [{"code": c, "n": n, "family": family(c),
                        "known": norm(c) in known,
                        "where": where[c].most_common(5), "ctx": ctx[c]}
                       for c, n in hits.most_common()]},
            ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
