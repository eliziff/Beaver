# DOCX edit benchmark

The public v3 corpus retains sourced public material and generated package
pathologies. Six bespoke prose fixtures and their dependent tasks are withheld
pending independent provenance verification. Original data and historical
results remain in private recovery storage. Do not publish or replay those
inputs merely because an old manifest called them generated.

The smaller corpus still checks reference edits, deliberate wrong outcomes,
guard sensitivity and exact package preservation through Beaver's current
DOCX compiler and `DocxSession`. Its aggregate scores are not comparable with
the earlier corpus. The harness has no live-model runner.

## Run it

From `backend/`:

```powershell
npx tsx ../benchmarks/docx_edit/src/cli.ts list
npx tsx ../benchmarks/docx_edit/src/cli.ts self-test
npx tsx ../benchmarks/docx_edit/src/cli.ts dump --fixture crossbridge-bylaw
npx tsx ../benchmarks/docx_edit/src/cli.ts manifest
```

`self-test` verifies that reference results pass, wrong and partial outcomes
fail, guards have demonstrated sensitivity, and no-op saves preserve every
package part. `list` reports the current case and fixture counts.

## Contents

| Path | Purpose |
| --- | --- |
| `tasks.jsonl` | Remaining v1 cases. |
| `tasks-v2.jsonl` | Public bilingual case. |
| `fixtures/real/*` | Sourced public text and malformed package samples. |
| `src/fixtures.ts` | Public-source and package-pathology builders. |
| `src/tasks.ts` | Task loading and structural validation. |
| `src/checks.ts` | Engine-neutral result scoring. |
| `src/selftest.ts` | Reference, wrong-outcome and package checks. |
| `manifest.jsonl` | Extracted-text fingerprints and package features. |

Add independently invented or attributable public-source cases with reference
edits and meaningful wrong outcomes. Run the offline self-test and regenerate
the manifest. Submission origin and fixture provenance are separate facts.
