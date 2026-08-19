#!/usr/bin/env python
"""CLASS 2 proposal check: the anchors statute patterns as grammar-table entries.

Takes STATUTE_CANADIAN_RE / STATUTE_CANADIAN_FR_RE (backend/src/lib/
legalTextAnchors.ts) rewritten in grammar-table authoring form -- JS-style
named groups, no inline flags, {{defs}} for the series lists -- and:

  1. validates + compiles them through legalpdf.grammar_tables (the real loader,
     so "it would load" is proven, not asserted);
  2. proves table-entry == TS-source parity by running both over corpus text and
     comparing full-match spans (the grammar_differential discipline);
  3. counts matches and hand-listable false positives on the 1,860-footnote
     corpus and judgment paragraphs;
  4. breaks the residual gap down by cause, from the mined census.

Run:
  python -X utf8 benchmarks/structure_stress/probes/cite_class2_propose.py \
      --samples <scratch>/cite_samples.json --census <scratch>/class2_docs.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "legal-pdf-parser" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import legalpdf.grammar_tables as gt  # noqa: E402
import cite_class2_statutes as c2  # noqa: E402

# ---- the proposed table entries, authored in grammar-table form -------------
DEFS = {
    "ca_statute_series": "|".join(
        "\\.?".join(s) + "\\.?" for s in c2.CA_STATUTE_SERIES),
    "fr_statute_series": "|".join(
        "\\.?".join(s) + "\\.?" for s in c2.FR_STATUTE_SERIES),
}
PROPOSED = {
    "cite.statute.judgment": {
        "id": "cite.statute.judgment",
        "pattern": (
            r"\b(?<series>{{ca_statute_series}}),?\s+(?:\(?(?<year>\d{4})\)?,?\s+)?"
            r"c\.\s?(?<chapter>[A-Za-z0-9.\-]+)"
            r"(?:,\s*Sched(?:ule)?\.?\s*(?<schedule>[A-Za-z0-9]+))?"
            r"(?:,\s*ss?\.\s*(?<section>\d[\w().]*))?"
        ),
        "flags": "",
    },
    "cite.statute.judgment.fr": {
        "id": "cite.statute.judgment.fr",
        "pattern": (
            r"\b(?<series>{{fr_statute_series}}),?\s+(?:\(?(?<year>\d{4})\)?,?\s+)?"
            r"ch?\.\s?(?<chapter>[A-Za-z0-9.\-]+)"
            r"(?:,\s*ann(?:exe)?\.?\s*(?<schedule>[A-Za-z0-9]+))?"
            r"(?:,\s*(?:art|par)\.\s*(?<section>\d[\w().]*))?"
        ),
        "flags": "",
    },
}
SOURCES = {
    "cite.statute.judgment": c2.STATUTE_CANADIAN_RE,
    "cite.statute.judgment.fr": c2.STATUTE_CANADIAN_FR_RE,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=Path, required=True)
    ap.add_argument("--census", type=Path, required=True)
    ap.add_argument("--paras", type=int, default=500)
    args = ap.parse_args()

    print("### 1. does each proposed entry validate and compile?")
    compiled: dict[str, re.Pattern[str]] = {}
    for eid, entry in PROPOSED.items():
        expanded = gt.expand_pattern(entry["pattern"], DEFS)
        violations = gt.validate_pattern(expanded)
        compiled[eid] = gt.compile_entry(entry, DEFS)
        print(f"   {eid:28s} violations={violations or 'none'} "
              f"expanded={len(expanded)} chars  groups={compiled[eid].groupindex}")

    samples = json.loads(args.samples.read_text(encoding="utf-8"))
    paragraphs = [p["text"] for p in samples["paragraphs"]]
    corpora = {
        "footnotes(1860)": samples["footnotes"],
        f"judgment-paras({min(args.paras, len(paragraphs))})": paragraphs[:args.paras],
        f"judgment-paras(all {len(paragraphs)})": paragraphs,
    }

    print()
    print("### 2. table entry vs TS source: span parity (grammar_differential rule)")
    for eid, pat in compiled.items():
        src = SOURCES[eid]
        mismatches = 0
        checked = 0
        for docs in corpora.values():
            for doc in docs:
                checked += 1
                if [m.span() for m in pat.finditer(doc)] != \
                        [m.span() for m in src.finditer(doc)]:
                    mismatches += 1
        print(f"   {eid:28s} docs={checked} span-mismatches={mismatches}")

    print()
    print("### 3. matches and false positives")
    hdr = f"{'entry':28s} {'corpus':26s} {'matches':>8s} {'distinct':>9s}"
    print(hdr)
    print("-" * len(hdr))
    listings: dict[str, Counter] = {}
    for eid, pat in compiled.items():
        for cname, docs in corpora.items():
            found: Counter = Counter()
            for doc in docs:
                for m in pat.finditer(doc):
                    found[re.sub(r"\s+", " ", m.group(0))] += 1
            print(f"{eid:28s} {cname:26s} {sum(found.values()):8d} {len(found):9d}")
            listings[f"{eid}|{cname}"] = found
    for key, found in listings.items():
        if key.endswith("footnotes(1860)") or "all " in key:
            print(f"\n   -- {key}: every distinct match (eyeball for non-statutes)")
            for text, n in found.most_common(28):
                print(f"      {n:4d} {text!r}")

    print()
    print("### 4. residual gap by cause (from the judgment-text census)")
    census = json.loads(args.census.read_text(encoding="utf-8"))
    strings = census["strings"]
    total = sum(n for _, n in strings)
    covered = sum(n for s, n in strings
                  if any(p.search(s) for p in compiled.values()))
    print(f"   census: {len(strings)} distinct / {total} occurrences "
          f"over {census['units']} documents")
    print(f"   covered by the two proposed entries: {covered} "
          f"({100*covered/total:.1f}%)")
    causes: Counter = Counter()
    examples: dict[str, str] = {}
    for s, n in strings:
        if any(p.search(s) for p in compiled.values()):
            continue
        # the marker is the one AFTER the year -- searching from the start
        # would pick up the "C." inside the series token ("S.C. 1984, ch. 21")
        after_year = re.search(r"\(?(?:1[6-9]|20)\d{2}\)?[\s,]*(.*)$", s)
        rest = after_year.group(1) if after_year else s
        marker = re.match(r"(chap|ch|c|C|CH)\.?", rest)
        mk = marker.group(0).strip() if marker else "?"
        series = re.match(r"[A-Z][A-Z.\- ]*", s)
        sr = re.sub(r"[.\s\-]", "", series.group(0)) if series else "?"
        in_ca = sr in {re.sub(r"[.]", "", x) for x in c2.CA_STATUTE_SERIES}
        in_fr = sr in {re.sub(r"[.]", "", x) for x in c2.FR_STATUTE_SERIES}
        if not (in_ca or in_fr):
            cause = f"series not in either member list ({sr})"
        elif mk.startswith("chap"):
            cause = "marker 'chap.' (neither pattern accepts it)"
        elif mk.lower().startswith("ch") and in_ca and not in_fr:
            cause = "EN series + FR marker 'ch.' (falls between the two patterns)"
        elif mk in ("C", "C."):
            cause = "uppercase marker 'C.' (patterns are case-sensitive)"
        elif mk == "c":
            cause = "marker 'c' with no period (patterns require 'c.')"
        else:
            cause = f"other (marker={mk!r}, series={sr})"
        causes[cause] += n
        examples.setdefault(cause, s)
    print(f"   uncovered: {sum(causes.values())} occurrences")
    for cause, n in causes.most_common():
        print(f"      {n:5d} ({100*n/total:4.1f}%) {cause}")
        print(f"            e.g. {examples[cause]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
