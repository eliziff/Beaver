# Jev structure-arbiter probe

Small best-case test of Jev as a bounded decision layer after OCR and geometry.
It does not detect lines, regions, or structure. Each case supplies the evidence
already available to the legal structure engine and asks Jev to choose among
valid engine actions.

The eight expectations are fixture-derived from
`legal-pdf-parser/legal-pdf-structure/src/structure/tests.rs`; they were written
before the live calls. Four cases cover reading-order arbitration and four cover
region-role discrimination. This is a mechanics probe, not corpus evidence.

```powershell
python experiments/jev-structure-arbiter/run.py
python experiments/jev-structure-arbiter/run_real_gold.py
python experiments/jev-structure-arbiter/run_journal.py
python experiments/jev-structure-arbiter/run_journal.py --arm geometry
python experiments/jev-structure-arbiter/run_headings.py --context local
python experiments/jev-structure-arbiter/run_headings.py --context outline
python experiments/jev-structure-arbiter/run_headings.py --context full
python experiments/jev-structure-arbiter/run_heading_grammar.py
python experiments/jev-structure-arbiter/run_heading_detection_v2.py
python experiments/jev-structure-arbiter/run_systemone_probe.py
```

Requires `TYPESAFE_API_KEY`. The runner pins `jev-1.13.0` and writes the latest
raw result to ignored `receipts/latest.json`.

`run_real_gold.py` adds a balanced 128-passage test over the repository's eight
real NSCA structure-gold decisions. Jev sees the marker and passage language but
not the gold role or the deterministic sequence rule, and chooses whether the
numbering belongs to the decision's primary spine or quoted/foreign material.
`--context neighbors` adds the immediately adjacent numbered passages; because
that sends larger excerpts to TypeSafe, run it only with explicit authorization.
`--context structural` adds a ±3-marker window and the last already-established
primary marker. It is a best-case ceiling, not an independently tuned holdout.

`run_journal.py` is a text-only semantic-role probe over open-access journal
material from the local OAJD final contracts. Jev receives only the preceding,
current, and following block—not coordinates, typography, indentation, margins,
or the OAJD production label. The expected roles were frozen before the call
after manual review. OAJD labels locate candidates; they are not human gold.
The geometry arm replaces the curated text with the exact OAJD region lines
and normalized source-page line boxes. It strips every upstream role/type/code.

The heading runners separate direct promotion/demotion fixtures from a real
19-candidate Alberta Law Review hierarchy. The latter can be run with adjacent
blocks only, the complete ordered candidate outline, or the full 79,634-
character article.
`run_heading_detection_v2.py` is the corrected text-only detection probe:
24 independent calls, explicit semantic demotion criteria, and no claims about
font, weight, or other evidence absent from the payload.
`run_systemone_probe.py` covers five additional bounded roles: numbering
family, wrapped-heading relationship, page-note/furniture role, candidate
reading order, and adjacent-region boundaries.
