# Blind gold audit contract

Reviewer packets contain only the citing-decision source, target identity, and
the deterministic v3 occurrence contract. They never contain prior gold,
model output, selection strata, challenge categories, or selection notes.
`prepare` recomputes production v3 occurrences and fails unless they exactly
match the frozen manifest; a detector/manifest split must be reconciled before
annotation, never silently accepted as gold.

Run from the repository root with
`backend/node_modules/.bin/tsx.cmd` on Windows (or the equivalent `tsx`
binary elsewhere):

```powershell
$tool = ".\backend\node_modules\.bin\tsx.cmd"
$audit = ".\experiments\a2aj_decision_roster_qwen\scratch\build_manual_gold_packets.ts"
$root = ".\experiments\a2aj_decision_roster_qwen\gold-audits\cohort-50-v1"

& $tool $audit prepare --manifests ".\experiments\a2aj_decision_roster_qwen\case-target-challenge-15.json,.\experiments\a2aj_decision_roster_qwen\case-target-challenge-extension-35.json" --root $root
& $tool $audit freeze --root $root --document 153903 --role author --identity author-a --version manual-v1 --date 2026-08-20 --annotation .\author-153903.json
& $tool $audit freeze --root $root --document 153903 --role reviewer --identity reviewer-b --version manual-v1 --date 2026-08-20 --annotation .\reviewer-153903.json
& $tool $audit adjudicate --root $root --document 153903 --identity adjudicator-c --version manual-v1 --date 2026-08-20 --summary "Resolved the mechanical field diff." --annotation .\final-153903.json
& $tool $audit verify --root $root
```

Give each annotator the same `packets/<document_id>.json` and the annotation
schema/instructions, but not `index.json`, either frozen annotation, or any
model/run artifact. `freeze` refuses to overwrite an artifact. `adjudicate`
binds both artifact hashes, their mechanical JSON-pointer diff, and the final
annotation into one immutable receipt. `verify` counts a case as `audited`
only when that receipt and every bound hash validate.

Generated packets contain corpus text and stay ignored in this directory.
