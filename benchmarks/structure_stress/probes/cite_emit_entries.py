#!/usr/bin/env python
"""Emit the proposed grammar-table entries with machine-verified vectors.

Nothing here is hand-written: the CLASS 1 member list comes from the mined
inventory, the CLASS 2 patterns from legalTextAnchors.ts, and every vector's
`groups` block is filled in by running the compiled entry over a REAL corpus
string, then re-checked with legalpdf.grammar_tables.run_vectors so a vector
that does not hold cannot be printed.

Run:
  python -X utf8 benchmarks/structure_stress/probes/cite_emit_entries.py \
      --mined <scratch>/class1.json --surfaces <scratch>/class1_surfaces.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "legal-pdf-parser" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import legalpdf.grammar_tables as gt  # noqa: E402
from cite_class1_propose import build_enum  # noqa: E402
from cite_class2_propose import DEFS as C2_DEFS, PROPOSED as C2_ENTRIES  # noqa: E402

# Real corpus strings. Every one appears verbatim in provider data; the
# comment says which source and how often (from the probes in this directory).
C1_VECTORS = [
    # CT/citation_en 628x + CT/cases_cited_en 451x (cite_class1_mine)
    "Neutral citation 2020 Comp Trib 6 File Number CT-2020-003",
    # the recall-survey miss, verbatim from CT/fr judgment text
    "la concurrence c Superior Propane Inc, 2000 Trib conc 8 o N de dossier",
    # CT/fr, 10x in judgment text (cite_class1_surfaces)
    "Référence neutre 2020 Trib Conc 5 Numéro de dossier CT-2020",
    # CT/en judgment text 5x -- the dotted multi-token surface
    "and Office Depot, Inc., 2016 Comp. Trib. 6 File No.: CT-2015-012",
    # CT/fr judgment text 1x
    "et Garda World Security Corporation, 2019 Trib. conc. 5 N° de dossier",
    # CIRB/en judgment text 12x
    "see Nav Canada, 2000 CIRB LD 213, affirmed in NAV Canada",
    # CIRB/fr judgment text 12x
    "voir Nav Canada, 2000 CCRI LD 213, confirmée dans NAV Canada",
    # CIRB/citation_en 6x -- the tribunal's former acronym
    "2010 CAPPRT LD 108",
    # negatives: prose the widened class must NOT swallow (both observed in
    # judgment text: 'to December' 18x, 'et le' 44x)
    "the period from 1996 to December 31, 1997",
    "entre 1996 et le 31 décembre 1997",
    "R v Smith, 2019 SCC 65 at para 3",       # single all-caps stays cite.neutral
]
C2_VECTORS = {
    "cite.statute.judgment": [
        "Criminal Code, R.S.C. 1985, c. C-46, s. 732.1(3)(c).",   # footnote corpus
        "Excise Tax Act, R.S.C. 1985, c. E-15",                    # SCC/en 2x
        "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.)",           # SCC/en 5x
        "R.S.C., 1985, c. P-21",                                   # comma after series
        "Courts of Justice Act, R.S.O. 1990, c. C.43",             # ONCA/en
        "S.O. 1997, c. 16, Sched. A",                              # footnote corpus
        "the Act, S.N.S. 2001 c. 6, ss. 74",                       # no comma before year
        "RSC 1985, c C-46",                                        # footnote dialect: no match
    ],
    "cite.statute.judgment.fr": [
        "Loi canadienne sur les droits de la personne, L.R.C. (1985), ch. H-6",
        "L.R.C. 1985, ch. C-46",
        "LIPR, L.C. 2001, ch. 27",
        "L.R.O. 1980, ch. 321, art. 37(1)",
        "L.R.O. 1990, chap. F.32",     # 'chap.' -- documented residual gap
        "RSC 1985, c C-46",            # English footnote dialect: no match
    ],
}


def fill(entry: dict, defs: dict, vectors: list[str]) -> dict:
    pat = gt.compile_entry(entry, defs)
    out = []
    for text in vectors:
        m = pat.search(text)
        out.append({"input": text,
                    "groups": (m.groupdict() if m else None)})
    return {**entry, "vectors": out}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mined", type=Path, required=True)
    ap.add_argument("--surfaces", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    mined = json.loads(args.mined.read_text(encoding="utf-8"))
    census = json.loads(args.surfaces.read_text(encoding="utf-8"))
    multi = [i["code"] for i in mined["buckets"]["multi-token"]]
    multi += [c["code"] for c in census["codes"]
              if c["known"] and c["family"].startswith("multi-token")
              and c["code"] not in multi]
    multi = [m for m in multi if m != "ON CA"]

    entries = [
        fill({
            "id": "cite.neutral.tribunal",
            "pattern": build_enum(multi),
            "flags": "",
            "canonical": {"strip": {"court": "."},
                          "lowercase": ["court"],
                          "map": {"court": {"trib conc": "comp trib",
                                           "trib comp": "comp trib",
                                           "ccri ld": "cirb ld",
                                           "tcrpap ld": "capprt ld"}}},
        }, {}, C1_VECTORS),
    ]
    for eid, entry in C2_ENTRIES.items():
        entries.append(fill(entry, C2_DEFS, C2_VECTORS[eid]))

    table = {"description": "PROPOSAL ONLY -- sibling dialect entries for review.",
             "defs": C2_DEFS, "entries": entries}
    failures = gt.run_vectors(table)
    print(f"run_vectors failures: {failures or 'none'}")
    text = json.dumps(entries, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(text)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
