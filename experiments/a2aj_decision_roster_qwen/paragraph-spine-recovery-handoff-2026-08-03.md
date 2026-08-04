# A2AJ paragraph-spine recovery: problem + failed approaches (handoff)

Status: **BLOCKED — needs a more capable agent.** This note records the
problem, the constraints, what was measured, and two solver designs that were
built and rejected. No production code was changed for this work; the only
touched file (`backend/src/lib/sourceDocA2AJ.ts`) is reverted byte-identical
to its pre-session baseline commit `01d8c62b^`.

## Problem

The A2AJ paragraph spine (`compileA2AJSourceDoc` →
`paragraphBlocks` in `backend/src/lib/sourceDocA2AJ.ts`) is rejected for a
large class of real decisions:

1. **Short modern SCC rulings** (`[1]`..`[4]` complete ladders, e.g. `2021
   SCC 21`, `2014 SCC 2`, `2009 SCC 13`) fail the short-complete gate because
   the citation-year `[2021]`/`[2014]` is parsed as a bracket marker, making
   `scope.length !== styleMarkers.length` (sourceDocA2AJ.ts:1113).
2. **Heading-joined paragraphs** (a heading line followed by `[N]` on the same
   line, e.g. `2011 SCC 9`: `I. Facts [3]`, `II. Judicial History [6]`,
   `III. Positions [11]`) are dropped because the strict +1 scoping
   (`monotoneScopes(..., maxGap = mode === "a2aj" ? 1 : 8)`, line 1101) splits
   the spine at each hole, and the recovery grammar rejects roman-numeral /
   nested headings.
3. **OCR-era SCC** (`[1936] SCR 4`, `[1935] SCR 133`) have a prose decision
   spine `[1]`..`[N]` in the body AND a separate endnote/citation list at the
   end that reuses the same numbers `[1]`..`[M]`.

## Measured ground truth (whole corpus, ~200k docs audited)

- **Digital A2AJ text has no missing glyphs**: in 3609/3609 docs with a
  line-start bracket run, every number in the run has a `[N]` marker
  somewhere (line-start or mid-line). Any "missing" paragraph is present but
  heading-joined.
- Current committed code emits a spine on 1054/5000 seed docs. The reference
  implementation (`Martys Qote Verifier\ALR-Quote-Verifier\verifier_core\
  a2aj_structure.py`, `paragraph_index`, max_gap=8) recovers 108 additional
  TS-no-spine SCC docs, but 103 of those are bare/dot-number ladders or tail
  citation lists — i.e. the reference's gap tolerance admits false positives.
- Findings doc (committed in the ALR repo):
  `Martys Qote Verifier\ALR-Quote-Verifier\dev\
  a2aj_paragraph_spine_false_positives_2026-08-03.md`

## Rejected approach A — loosen the heading grammar

Added `looksLikeStandaloneHeadingLine` (accepts roman numerals, nested
enumerators) and OR'd it into the recovery `formal` check. Full-corpus A/B
(19,915 docs) showed **25 whole-spine regressions** (e.g. `2014 CHRT 29`
29→0, `2014 ONCA 605` 31→0, `2024 SCTC 5` 69→0) because the looser grammar
creates duplicate `[N]` candidates that break the uniqueness filter and
fracture the strict +1 scope. **Rejected and reverted.**

## Rejected approach B — "v2": number-space spine + citation-shape body filter

Design: collect every `[N]` marker 1..999, classify each body via the mature
`hasCitationInText` (citationKey.ts), build the spine as the contiguous +1 run
of *prose* markers from 1, and treat a trailing citation-shaped run as an
endnote list.

Full-corpus audit (resumable script
`C:\Users\elias\AppData\Local\Temp\opencode\auditWholeCorpus.mjs`, checkpoint
at `...\opencode\audit\checkpoint.jsonl`, ~200k rows done):
- **3557 regressions** (docs that currently have a spine, v2 emits none)
- **13132 gains** (docs currently spine-less, v2 emits one)
- Regression datasets dominated by SCC (1179), CITT (830), FPSLREB (380),
  NSSM (358), NSSC (226), NSSC (226), NSCA (118), FC (154), NSPC (56).

**Root cause of the regressions:** `hasCitationInText` is too broad for this
use. It flags real prose paragraphs as citations because they contain a
date/year/reporter-shaped substring. Verified on `2005 BCSC 97`:
`[1] On 24 June 1999, following a trial before a jury...` and
`[6] On 21 August 2001, Justice Clancy published his rea...` both return
`hasCitationInText === true`. So v2's "drop citation-shaped bodies from the
prose set" deletes real spine paragraphs.

## What the fix must NOT do (learned constraints)

1. **Do not gate the spine on `hasCitationInText` body classification.**
   The mature primitive is for locating citations inside prose, not for
   deciding whether a paragraph belongs to the decision spine. A date or a
   case reference inside an ordinary paragraph is common.
2. **Do not loosen the heading grammar.** It regresses via duplicate
   candidates. If heading-join recovery needs extending, it must be evidence-
   gated by the sequence (a unique `[N]` filling a gap), not by accepting more
   heading word-shapes.
3. **Do not use gap tolerance (max_gap=8) on the decision spine.** It admits
   bare/dot ladders and tail citation lists (the reference's false positives).
4. **Zero regression is the contract**: the solver must reproduce every spine
   the current code emits (3557 counterexamples on approach B show why this is
   hard), and only add spines that are provably real.

## Candidate directions for the next agent (not yet validated)

- **Distinguish the year marker** (`[2021]` at doc top, number >= 1000) as
  front-matter so the short-complete equality check works for short ladders.
  This part alone fixed `2021 SCC 21` etc. and was low-risk in isolation.
- **Fill heading-joined holes by sequence evidence only**: a unique `[N]`
  whose number fills a gap between two line-start markers, preceded on its
  line by a short non-prose heading, is the real paragraph — without needing
  the heading to match a title-case word grammar. Test on `2011 SCC 9`
  (122 paragraphs, all 20 holes are heading-joined).
- **Detect the endnote/citation tail by its OWN signature**, not by filtering
  the spine: a trailing contiguous +1 run whose bodies are *overwhelmingly*
  short and citation-like (not any single citation substring) should become
  footnote blocks and be excluded from the paragraph spine. This needs a
  precise tail detector, not a per-block prose/citation filter.
- The genuine recovery targets (measured, verified): `2021 SCC 21`, `2021 SCC
  38`, `2009 SCC 13`, `2014 SCC 2` (short `[1]`..`[4]`), and `2011 SCC 9`
  (122, heading-joined holes). The citation-tail cases are `[1936] SCR 4`,
  `[1936] SCR 351`, `[1933] SCR 201`, `[1935] SCR 133`.

## Repro commands

```powershell
# oracle = committed code; run whole-corpus A/B (resumable)
node --import file:///C:/Users/elias/Desktop/MikeOSS%20Fork/backend/node_modules/tsx/dist/loader.mjs `
  C:/Users/elias/AppData/Local/Temp/opencode/auditWholeCorpus.mjs

# focused checks on representative cases
node --import file:///C:/Users/elias/Desktop/MikeOSS%20Fork/backend/node_modules/tsx/dist/loader.mjs `
  C:/Users/elias/AppData/Local/Temp/opencode/testSolver.mjs   # 8 known cases
```

## Files

- `backend/src/lib/sourceDocA2AJ.ts` — reverted to baseline `01d8c62b^`,
  no changes.
- `C:\Users\elias\AppData\Local\Temp\opencode\auditWholeCorpus.mjs` — the
  resumable whole-corpus A/B audit script (per-row checkpoint, appended
  heartbeat log, resume from checkpoint).
- `C:\Users\elias\AppData\Local\Temp\opencode\audit\checkpoint.jsonl` — 200k
  rows with `regression`/`gain` markers; `heartbeat.log` for progress.
- `Martys Qote Verifier\ALR-Quote-Verifier\dev\
  a2aj_paragraph_spine_false_positives_2026-08-03.md` — reference false
  positives (committed 50e03c2).
