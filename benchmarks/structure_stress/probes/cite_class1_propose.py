#!/usr/bin/env python
"""CLASS 1 candidates + false-positive measurement.

Takes the mined court-code inventory (cite_class1_mine.py) and measures three
candidate widenings of the neutral-citation court code against real text:

  A. generic-2token-cap   two tokens, first Capitalized
  B. generic-2token-any   two tokens, either may be all-lowercase
  C. enum-observed        closed alternation over the MINED surfaces only
                          (the shape cite.statute.splitter already uses)

Corpora: the 1,860-footnote docx corpus (footnote lineage, where the existing
grammar was tuned) and A2AJ judgment paragraphs (cite_sample_texts.py).
"New match" = a span the candidate produces that neither cite.neutral nor
cite.canlii already produces. Each new match is triaged against the corpus
code inventory (A2AJ surface codes + the 348 CanLII slug codes): a new match
whose normalized code is unknown to both providers is a false positive.

Run:
  python -X utf8 benchmarks/structure_stress/probes/cite_class1_propose.py \
      --mined <scratch>/class1.json --samples <scratch>/cite_samples.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENGINE = REPO / "universal-legal-pdf-engine"
sys.path.insert(0, str(ENGINE / "src"))
import legalpdf.grammar_tables as gt  # noqa: E402

YEAR = r"(?:17|18|19|20)\d{2}"  # verbatim from cite.neutral

CANDIDATES = {
    # first token Capitalized (as "Comp Trib" / "Trib conc" / "CIRB LD" are)
    "A.generic-2token-cap":
        rf"\b(?<year>{YEAR})\s+(?<court>[A-Z][A-Za-z]{{1,7}}\s+[A-Za-z]{{2,7}}\.?)"
        r"\s+(?<num>\d+)\b",
    # either token may be all-lowercase
    "B.generic-2token-any":
        rf"\b(?<year>{YEAR})\s+(?<court>[A-Za-z]{{2,8}}\s+[A-Za-z]{{2,8}}\.?)"
        r"\s+(?<num>\d+)\b",
    # C is built from the mined inventory at runtime (see build_enum)
    # D: dotted single token. Surfaces observed in judgment prose:
    # S.C.C. C.S.C. F.C.A. C.A.F. F.C. C.F. F.C.T. D.T.C.
    "D.dotted-single":
        rf"\b(?<year>{YEAR})\s+(?<court>[A-Z](?:\.[A-Z0-9]){{1,7}}\.?)"
        r"\s+(?<num>\d+)\b",
    # E: mixed-case single token, closed to the surfaces the corpus attests
    # (CanLII + the Carswell regional series).
    "E.mixedcase-enum":
        rf"\b(?<year>{YEAR})\s+(?<court>CanLII|Carswell[A-Z][A-Za-z]{{1,3}})"
        r"\s+(?<num>\d+)\b",
    # F: open mixed-case single token -- the naive widening, for contrast.
    "F.generic-mixedcase":
        rf"\b(?<year>{YEAR})\s+(?<court>[A-Za-z][A-Za-z0-9-]{{1,15}})"
        r"\s+(?<num>\d+)\b",
}


def strip_accents(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFD", s)
                   if unicodedata.category(ch) != "Mn")


def norm(code: str) -> str:
    return strip_accents(code).lower().replace(" ", "").replace(".", "")


def known_codes(mined: dict, slug_floor: int) -> set[str]:
    """Clean court-code oracle -- see cite_class1_surfaces.known_codes."""
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


def build_enum(surfaces: list[str]) -> str:
    """Closed alternation over the mined multi-token surfaces.

    Shape provenance: cite.statute.splitter enumerates its series codes
    (RSC|RSO|...) rather than generalizing them; same discipline here.
    Members are ONLY what the providers attest. Longest-first so
    "Comp Trib." wins over "Comp Trib".
    """
    parts = []
    for surface in sorted(set(surfaces), key=lambda s: (-len(s), s)):
        parts.append(r"\s+".join(re.escape(t) for t in surface.split()))
    return (rf"\b(?<year>{YEAR})\s+(?<court>" + "|".join(parts)
            + r")\s+(?<num>\d+)\b")


# Verbatim from backend/src/lib/legalTextAnchors.ts CITE_NEUTRAL_RE (the
# judgment-side neutral-cite grammar) -- an enumerated court-code list that
# already ships in production.
ANCHORS_COURTS = (
    "CSC CAF CFPI CF SCC FCA FC TCC CCI ONCA ONSC ONCJ BCCA BCSC ABCA ABQB "
    "ABKB SKCA SKQB SKKB MBCA MBQB MBKB NSCA NSSC NBCA NBQB NBKB QCCA QCCS "
    "QCCQ PECA PESC NLCA NLSC YKCA YKSC NWTCA NWTSC NUCA NUCJ"
).split()


def build_dotted_enum() -> str:
    """Dotted court codes: the anchors court list x the dotting mechanism.

    Dotting is verbatim legalTextAnchors.ts CA_SERIES_PATTERN --
    `series.split("").join("\\\\.?") + "\\\\.?"` -- which is how the shipped
    statute grammar already accepts "R.S.C." and "RSC" from one member list.
    """
    alts = "|".join(sorted((r"\.?".join(c) + r"\.?" for c in ANCHORS_COURTS),
                           key=len, reverse=True))
    return (rf"\b(?<year>{YEAR})\s+(?<court>{alts})\s+(?<num>\d+)\b")


def compile_candidate(pattern: str, flags: str = "") -> re.Pattern[str]:
    entry = {"id": "probe", "pattern": pattern, "flags": flags}
    violations = gt.validate_pattern(gt.expand_pattern(pattern, {}))
    if violations:
        raise SystemExit(f"candidate violates table rules: {violations}")
    return gt.compile_entry(entry)


# The recall survey's coverage set (grammar_recall.py CITE_ENTRY_IDS): a form
# is only a GAP if none of these four sees it.
BASELINE_IDS = ("cite.neutral", "cite.canlii", "cite.reporter.splitter",
                "cite.reporter.toa")


def load_table_patterns(tables: Path, ids: tuple[str, ...]) -> dict[str, re.Pattern[str]]:
    table = json.loads((tables / "citations.json").read_text(encoding="utf-8"))
    defs = table.get("defs") or {}
    return {e["id"]: gt.compile_entry(e, defs)
            for e in table["entries"] if e["id"] in ids}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mined", type=Path, required=True)
    ap.add_argument("--samples", type=Path, required=True)
    ap.add_argument("--tables", type=Path, default=REPO / "shared" / "grammar-tables")
    ap.add_argument("--surfaces", type=Path, default=None,
                    help="cite_class1_surfaces.py --out JSON (prose surfaces)")
    ap.add_argument("--slug-floor", type=int, default=10)
    ap.add_argument("--paras", type=int, default=500)
    args = ap.parse_args()

    mined = json.loads(args.mined.read_text(encoding="utf-8"))
    multi = [i["code"] for i in mined["buckets"].get("multi-token", [])]
    if args.surfaces and args.surfaces.is_file():
        # fold in the multi-token surfaces the judgment-text census found
        # ("Comp. Trib.", "Trib Conc", "Trib. conc.") -- same providers,
        # prose rather than the citation column.
        census = json.loads(args.surfaces.read_text(encoding="utf-8"))
        multi += [c["code"] for c in census["codes"]
                  if c["known"] and c["family"].startswith("multi-token")
                  and c["code"] not in multi]
    known = known_codes(mined, args.slug_floor)
    print(f"mined multi-token surfaces ({len(multi)}): {multi}")
    print(f"known-code oracle: {len(known)} codes")

    base = load_table_patterns(args.tables, BASELINE_IDS)
    print(f"baseline entries: {sorted(base)}")
    cands = dict(CANDIDATES)
    cands["C.enum-observed"] = build_enum(
        [m for m in multi if m != "ON CA"])  # "2011 ON CA 526" is a 1-off typo
    cands["G.dotted-enum"] = build_dotted_enum()
    compiled = {k: compile_candidate(v) for k, v in cands.items()}

    samples = json.loads(args.samples.read_text(encoding="utf-8"))
    corpora = {
        "footnotes(1860)": samples["footnotes"],
        f"judgment-paras({min(args.paras, len(samples['paragraphs']))})":
            [p["text"] for p in samples["paragraphs"][:args.paras]],
    }

    print()
    hdr = f"{'candidate':22s} {'corpus':26s} {'total':>6s} {'new':>5s} {'fp':>4s} {'tp':>4s}"
    print(hdr)
    print("-" * len(hdr))
    detail: dict = {}
    for cname, cre in compiled.items():
        for corpus_name, docs in corpora.items():
            new_spans: Counter = Counter()
            total = 0
            for doc in docs:
                covered = set()
                for bre in base.values():
                    for m in bre.finditer(doc):
                        covered.add(m.span())
                for m in cre.finditer(doc):
                    total += 1
                    if m.span() in covered:
                        continue
                    # also treat as covered if the baseline matched inside it
                    if any(s >= m.start() and e <= m.end() for s, e in covered):
                        continue
                    new_spans[m.group(0)] += 1
            fp = sum(n for t, n in new_spans.items()
                     if norm(_court_of(t)) not in known)
            tp = sum(new_spans.values()) - fp
            print(f"{cname:22s} {corpus_name:26s} {total:6d} "
                  f"{sum(new_spans.values()):5d} {fp:4d} {tp:4d}")
            detail[f"{cname}|{corpus_name}"] = new_spans.most_common(40)
    print()
    for key, items in detail.items():
        if items:
            print(f"### new matches — {key}")
            for text, n in items:
                tag = "FP" if norm(_court_of(text)) not in known else "TP"
                print(f"   {n:4d} {tag} {text!r}")
    print()
    print("### positive check: does each candidate match the mined surfaces?")
    for surface in multi:
        probe = f"Voir 2000 {surface} 8 au para 3."
        row = [("Y" if compiled[c].search(probe) else "n") for c in compiled]
        base_hit = "Y" if any(b.search(probe) for b in base.values()) else "n"
        print(f"   {surface:12s} baseline={base_hit} "
              + " ".join(f"{c.split('.')[0]}={r}" for c, r in zip(compiled, row)))
    return 0


_COURT = re.compile(rf"{YEAR}\s+(.*?)\s+\d+$")


def _court_of(text: str) -> str:
    m = _COURT.match(text.strip())
    return m.group(1) if m else text


if __name__ == "__main__":
    raise SystemExit(main())
