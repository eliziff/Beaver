# DOCX edit benchmark

This is Beaver's small, engine-neutral corpus for checking document edits. It
contains 28 semantic edit/refusal tasks over 12 DOCX fixtures. The harness
builds the fixtures, validates every task, synthesises the frozen reference and
near-miss outcomes, and scores their accepted body-text projection.

It is deliberately **not a model runner or a second Beaver runtime**. Historical
model/surface experiments remain recorded under `docs/harvey-labs/results/`;
the executable benchmark now depends only on Beaver's current DOCX compiler and
canonical `DocxSession` through
`backend/scripts/docx-edit-bench-bridge.ts`.

## Run it

Run from `backend/`, which owns the TypeScript and DOCX dependencies:

```powershell
npx tsx ../benchmarks/docx_edit/src/cli.ts list
npx tsx ../benchmarks/docx_edit/src/cli.ts self-test
npx tsx ../benchmarks/docx_edit/src/cli.ts dump --fixture sunrise-spa
npx tsx ../benchmarks/docx_edit/src/cli.ts manifest
npx tsx ../benchmarks/docx_edit/src/cli.ts manifest --write
```

`self-test` is the main gate. It proves that:

- every reference edit applies and passes its task checks;
- every hand-written and automatic near miss fails;
- every guard has demonstrated sensitivity; and
- opening and saving every fixture through `DocxSession` preserves every ZIP
  package part's payload exactly.

Current result:

```text
12/12 fixture packages preserved
28/28 tasks have a verified reference solution
28/28 tasks reject every wrong result
```

## Contents

| Path | Purpose |
| --- | --- |
| `tasks.jsonl` | Frozen v1 task set (27 tasks). |
| `tasks-v2.jsonl` | Additive v2 task set (1 real bilingual task). |
| `fixtures/prose/*.md` | Sources rendered through Beaver's DOCX compiler. |
| `fixtures/real/*` | The one sourced real-world fixture and malformed package samples. |
| `src/fixtures.ts` | Prose, real, and pathology fixture builders. |
| `src/tasks.ts` | Task loading and structural validation. |
| `src/checks.ts` | Engine-neutral result scoring. |
| `src/selftest.ts` | Reference, near-miss, guard, and package-preservation checks. |
| `manifest.jsonl` | Regenerable fixture and task fingerprints. |

The 12 fixtures cover long and short agreements, page markers, a table of
contents, unnumbered prose, a transcript page boundary, automatic numbering,
tables, headers and footers, tracked changes, comments, manual redlining,
bilingual text, OCR damage, and footnotes.

The manifest fingerprints stable extracted text and package features. It omits
whole-file DOCX hashes because the packager timestamps generated files, which
would create a meaningless diff on every regeneration.

## Scoring contract

Each task declares target sites that must change, guard sites that must not,
the expected edit/refusal outcome, literal reference edits, and at least one
near miss. `scoreTask` reports target hits/misses, guard violations, unexpected
line removals/additions, unchanged-document violations, answer checks, and the
overall pass.

The checker is intentionally independent of how an output was produced. A new
Word engine or Beaver operation should emit resulting document text and use the
same `scoreTask`; it does not need a new runner abstraction.

## Limits

- Semantic checks use the accepted body-text projection. Tracked and direct
  edits with the same accepted text therefore score alike.
- Refusal answers use regular expressions and cannot distinguish deep
  reasoning from a lucky phrase.
- Collateral line comparison is order-insensitive; no current task depends on
  pure line order.
- `factum-footnote-pinpoint` records the current body-plane limitation: the
  correct outcome is refusal until a tested operation can address notes.

Add a task only when it represents a concrete capability or failure mode. Put
it in the newest additive task file, provide a reference edit and a near miss,
run `self-test`, then regenerate `manifest.jsonl`.
