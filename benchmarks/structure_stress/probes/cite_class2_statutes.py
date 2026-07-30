#!/usr/bin/env python
"""CLASS 2 inventory: the judgment-dialect statute citation.

The footnote-lineage entries (cite.statute.splitter / cite.statute.toa) scored
zero over 120 SCC judgments: footnotes write "RSC 1985, c C-46" and judgments
write "R.S.C. 1985, c. C-46". This probe measures the judgment dialect from
provider text rather than guessing it.

DISCOVERY, not enumeration: the miner anchors on the invariant core
(year + chapter marker + chapter id) and captures the *preceding* series field,
so series tokens nobody enumerated -- French ones, provincial ones, unexpected
spellings -- surface on their own.

Then four grammars are scored against every distinct mined string:
  cite.statute.splitter / cite.statute.toa   (footnote lineage, the tables)
  STATUTE_CANADIAN_RE / STATUTE_CANADIAN_FR_RE (backend/src/lib/
  legalTextAnchors.ts, ported here verbatim from that source)

Throttle contract: per-court `LIMIT n` queries, one court/lang at a time,
single-threaded.

Run:
  python -X utf8 benchmarks/structure_stress/probes/cite_class2_statutes.py \
      --docs 40 --out <scratch>/class2.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "universal-legal-pdf-engine" / "src"))
import legalpdf.grammar_tables as gt  # noqa: E402

CORPUS = Path.home() / "AppData" / "Local" / "ALR Quote Verifier" / "a2aj_corpus"
COURTS = ["SCC", "FCA", "FC", "TCC", "ONCA", "BCCA", "NSCA", "CMAC", "CHRT",
          "FPSLREB", "CITT", "SST"]

# ---------------------------------------------------------------- discovery
# The invariant of a Canadian statute citation: an optional bracketed year,
# then a chapter marker, then the chapter id. Everything about the DIALECT
# (dots, spacing, marker spelling) is captured, never presumed.
# The chapter marker as the courts spell it: observed surfaces are c, c., C,
# ch., CH, chap. -- so the token is [Cc] optionally extended to ch/chap, in any
# casing. A marker must be followed by a period or whitespace (otherwise "C"
# swallows the "C" of "2020 Comp Trib 6"), and the chapter id must begin with
# an uppercase letter or a digit.
CHAP_MARKER = r"[Cc](?:[Hh](?:[Aa][Pp])?)?"
CORE = re.compile(
    r"(?P<lead>[A-Za-z][A-Za-z.]*(?:[  ][A-Za-z][A-Za-z.]*){0,3}\.?)?"
    r"(?P<sep>[\s,]{0,3})"
    # The year is mandatory: it is the discriminator that separates a statute
    # citation from a dotted reporter abbreviation ("S.C.R.", "F.C.J." parse as
    # series+chapter without it). Year-less consolidations (CQLR/RLRQ/CCSM/CPLM)
    # are counted separately by YEARLESS below.
    r"(?P<year>\(?(?:1[6-9]|20)\d{2}\)?)(?P<sep2>[\s,]{0,3})"
    rf"(?P<marker>{CHAP_MARKER})(?P<dot>\.?)(?P<gap>[  ]*)"
    r"(?P<chapter>[A-Z0-9][A-Za-z0-9.\-]{0,12})"
    r"(?P<supp>\s*\([^)]{1,14}\))?"
)
# A series token is an all-caps run, dotted or not: RSC R.S.C. LRC L.R.C.
# S.R.C. C.A. -- matched on the ORIGINAL casing (upper-casing first would let
# any word through).
SERIES_TAIL = re.compile(r"(?P<series>[A-Z](?:\.?[  ]?[A-Z]){0,6}\.?)[\s,]*$")

# ------------------------------------------------------- legalTextAnchors.ts
# Ported VERBATIM from backend/src/lib/legalTextAnchors.ts (read-only source):
# CA_STATUTE_SERIES / FR_STATUTE_SERIES member lists and the
# `series.split("").join("\\.?") + "\\.?"` dotting, then the two RegExp bodies.
CA_STATUTE_SERIES = [
    "RSNWT", "SNWT", "RSPEI", "SPEI", "CCSM",
    "RSNB", "SNB", "RSNS", "SNS", "RSNL", "SNL",
    "RSBC", "SBC", "RSC", "RSO", "RSA", "RSS", "RSM", "RSY",
    "SC", "SO", "SA", "SS", "SM", "SY",
]
FR_STATUTE_SERIES = ["CPLM", "RLRQ", "CQLR", "LRC", "LRO", "LRM", "LC", "LO", "LM"]


def _dotted(series: list[str]) -> str:
    return "|".join("\\.?".join(s) + "\\.?" for s in series)


STATUTE_CANADIAN_RE = re.compile(
    rf"\b({_dotted(CA_STATUTE_SERIES)}),?\s+(?:\(?(\d{{4}})\)?,?\s+)?c\.\s?([A-Za-z0-9.\-]+)"
    r"(?:,\s*Sched(?:ule)?\.?\s*([A-Za-z0-9]+))?"
    r"(?:,\s*ss?\.\s*(\d[\w().]*))?"
)
STATUTE_CANADIAN_FR_RE = re.compile(
    rf"\b({_dotted(FR_STATUTE_SERIES)}),?\s+(?:\(?(\d{{4}})\)?,?\s+)?ch?\.\s?([A-Za-z0-9.\-]+)"
    r"(?:,\s*ann(?:exe)?\.?\s*([A-Za-z0-9]+))?"
    r"(?:,\s*(?:art|par)\.\s*(\d[\w().]*))?"
)

TABLE_IDS = ("cite.statute.splitter", "cite.statute.toa")


def load_table(tables: Path) -> dict[str, re.Pattern[str]]:
    table = json.loads((tables / "citations.json").read_text(encoding="utf-8"))
    defs = table.get("defs") or {}
    return {e["id"]: gt.compile_entry(e, defs)
            for e in table["entries"] if e["id"] in TABLE_IDS}


def signature(m: re.Match[str]) -> dict | None:
    if not (m.group("dot") or m.group("gap")):
        return None                       # "Comp" is not "c" + chapter "omp"
    series = (m.group("lead") or "").strip()
    tail = SERIES_TAIL.search(series) if series else None
    series_tok = tail.group("series").strip() if tail else ""
    year = m.group("year")
    sep2 = m.group("sep2")
    return {
        "series": series_tok,
        "series_norm": re.sub(r"[.\s]", "", series_tok).upper(),
        "series_dotted": "." in series_tok,
        "year_parens": year.startswith("("),
        "marker": m.group("marker") + m.group("dot"),
        "marker_gap": "space" if m.group("gap") else "none",
        "year_sep": ("comma" if "," in sep2 else
                     ("space" if sep2 else "none")),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, default=CORPUS)
    ap.add_argument("--tables", type=Path, default=REPO / "shared" / "grammar-tables")
    ap.add_argument("--docs", type=int, default=40)
    ap.add_argument("--paras", type=int, default=2000)
    ap.add_argument("--samples", type=Path, default=None,
                    help="cite_sample_texts.py JSON; use its paragraphs instead")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    units: list[tuple[str, str, str]] = []  # (court, lang, text)
    if args.samples and args.samples.is_file():
        data = json.loads(args.samples.read_text(encoding="utf-8"))
        for p in data["paragraphs"][:args.paras]:
            units.append((p["court"], p["lang"], p["text"]))
        print(f"source: {len(units)} sampled paragraphs "
              f"({len({(c, l) for c, l, _ in units})} court/lang cells)")
    else:
        import duckdb
        con = duckdb.connect()
        for court in COURTS:
            parquet = args.corpus / "cases" / court / "train.parquet"
            if not parquet.is_file():
                continue
            for lang in ("en", "fr"):
                col = f"unofficial_text_{lang}"
                for (t,) in con.execute(
                    f"SELECT {col} FROM read_parquet('{parquet.as_posix()}') "
                    f"WHERE {col} IS NOT NULL LIMIT {int(args.docs)}"
                ).fetchall():
                    units.append((court, lang, t))
        con.close()
        print(f"source: {len(units)} full documents, "
              f"{sum(len(t) for _, _, t in units):,} chars")

    strings: Counter = Counter()
    sigs: dict[str, dict] = {}
    axes: dict[str, Counter] = defaultdict(Counter)
    series_by_lang: dict[str, Counter] = defaultdict(Counter)
    examples: dict[str, list[str]] = defaultdict(list)
    for court, lang, text in units:
        for m in CORE.finditer(text):
            sig = signature(m)
            if sig is None or not sig["series"]:
                continue          # bare "1985, c. C-46" with no series token
            full = re.sub(r"\s+", " ", m.group(0)).strip()
            # trim the leading prose the lead group may have swept in
            cut = full.rfind(sig["series"])
            full = full[cut:] if cut > 0 else full
            strings[full] += 1
            sigs[full] = sig
            for axis in ("series_dotted", "year_parens", "marker",
                         "marker_gap", "year_sep"):
                axes[axis][sig[axis]] += 1
            axes["series_norm"][sig["series_norm"]] += 1
            axes["series_surface"][sig["series"]] += 1
            series_by_lang[lang][sig["series"]] += 1
            if len(examples[sig["series"]]) < 4:
                examples[sig["series"]].append(full)

    print(f"distinct statute strings: {len(strings)}  occurrences: {sum(strings.values())}")
    print()
    for axis in ("series_dotted", "year_parens", "marker", "marker_gap", "year_sep"):
        total = sum(axes[axis].values()) or 1
        print(f"### {axis}")
        for k, n in axes[axis].most_common():
            print(f"   {n:6d} ({100*n/total:5.1f}%) {k!r}")
    print()
    print("### series surface forms (top 40)")
    for k, n in axes["series_surface"].most_common(40):
        print(f"   {n:6d} {k!r:14s} en={series_by_lang['en'][k]:5d} "
              f"fr={series_by_lang['fr'][k]:5d}  e.g. {examples[k][0]!r}")

    # ------------------------------------------------------------- coverage
    grammars = load_table(args.tables)
    grammars["anchors.STATUTE_CANADIAN_RE"] = STATUTE_CANADIAN_RE
    grammars["anchors.STATUTE_CANADIAN_FR_RE"] = STATUTE_CANADIAN_FR_RE
    print()
    hdr = f"{'grammar':34s} {'distinct hit':>12s} {'occ hit':>8s} {'occ%':>7s}"
    print(hdr)
    print("-" * len(hdr))
    occ_total = sum(strings.values()) or 1
    per_grammar_miss: dict[str, Counter] = {}
    for name, pat in grammars.items():
        d = o = 0
        miss: Counter = Counter()
        for s, n in strings.items():
            if pat.search(s):
                d += 1
                o += n
            else:
                miss[s] += n
        per_grammar_miss[name] = miss
        print(f"{name:34s} {d:12d} {o:8d} {100*o/occ_total:6.1f}%")

    # form x grammar matrix: the axis that actually decides coverage
    print()
    cols = list(grammars)
    print(f"{'form (series dots / chapter marker)':38s} {'occ':>5s} "
          + " ".join(f"{c.split('.')[-1][:9]:>9s}" for c in cols))
    print("-" * (45 + 10 * len(cols)))
    forms: dict[tuple, Counter] = defaultdict(Counter)
    for s, n in strings.items():
        sig = sigs[s]
        forms[("dotted" if sig["series_dotted"] else "plain",
               sig["marker"])][s] += n
    for form, members in sorted(forms.items(),
                                key=lambda kv: -sum(kv[1].values())):
        occ = sum(members.values())
        cells = []
        for c in cols:
            hit = sum(n for s, n in members.items() if grammars[c].search(s))
            cells.append(f"{100*hit/occ:8.0f}%")
        print(f"{form[0] + ' / ' + repr(form[1]):38s} {occ:5d} " + " ".join(cells))

    union = Counter()
    for s, n in strings.items():
        if not any(p.search(s) for p in grammars.values()):
            union[s] += n
    print(f"{'UNION of all four':34s} "
          f"{len(strings)-len(union):12d} {occ_total-sum(union.values()):8d} "
          f"{100*(occ_total-sum(union.values()))/occ_total:6.1f}%")
    print()
    print(f"### uncovered by ALL four ({len(union)} distinct, "
          f"{sum(union.values())} occurrences) — top 30")
    for s, n in union.most_common(30):
        print(f"   {n:5d} {s!r}")
    print()
    print("### missed by the footnote-lineage table entries but caught by anchors")
    tbl = [g for g in TABLE_IDS if g in grammars]
    anc = ["anchors.STATUTE_CANADIAN_RE", "anchors.STATUTE_CANADIAN_FR_RE"]
    rescued = Counter()
    for s, n in strings.items():
        if not any(grammars[g].search(s) for g in tbl) and \
                any(grammars[g].search(s) for g in anc):
            rescued[s] += n
    print(f"   {len(rescued)} distinct / {sum(rescued.values())} occurrences")
    for s, n in rescued.most_common(20):
        print(f"   {n:5d} {s!r}")

    if args.out:
        args.out.write_text(json.dumps({
            "units": len(units),
            "strings": strings.most_common(),
            "axes": {k: v.most_common() for k, v in axes.items()},
            "series_by_lang": {k: v.most_common() for k, v in series_by_lang.items()},
            "uncovered_all": union.most_common(),
            "rescued_by_anchors": rescued.most_common(),
            "missed_per_grammar": {k: v.most_common(60)
                                   for k, v in per_grammar_miss.items()},
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
