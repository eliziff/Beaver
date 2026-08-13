# Backend experiments

This directory is Beaver's backend laboratory. Experiments may import
`backend/src`; production and production tests may never import this directory.
The normal backend build and test suite exclude it.

Each experiment keeps its implementation, focused tests, and a short README in
one folder. Put raw run output in `results/` or `receipts/` (both ignored), then
record durable findings in `RESULTS.md`: date, commit, corpus/input, command,
metric, conclusion, and whether the idea was rejected, retained, or promoted.
Files under an explicit `scratch/` directory are preserved but excluded from
import-integrity checks; anything relied upon belongs outside `scratch/`.

Run every deterministic TypeScript experiment check from `backend`:

```powershell
npm run test:experiments
```

Promotion is a move, not an import: move the proven primitive and its durable
behaviour test into `src`, then update the result note. Do not leave a shim.
