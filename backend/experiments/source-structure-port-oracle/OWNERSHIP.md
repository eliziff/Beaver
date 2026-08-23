# Provider structure port oracle

This experiment freezes 24 real provider inputs and their accepted public
UTF-16 SourceDoc results at baseline commit
`16d4c5fecb83ba5552ca3840acaf0f5c95d82b9c`. It is a regression oracle, not an
implementation, runtime protocol, or architecture plan.

The active ownership and cutover plan is
[`docs/roadmap/document-structure.md`](../../../docs/roadmap/document-structure.md).
Names such as profiles or recovery that remain inside `vectors.json` describe
the immutable historical input/output contract only; they do not prescribe the
final Rust API.

## Contents

- `vectors.json` contains fixture hashes, expected-value hashes, coverage-row
  bindings, and the Unicode offset control.
- `inputs/` contains the three captured public provider inputs referenced by
  the vector manifest.
- `verify.ts` proves the manifest, fixtures, expected values, row bindings, and
  offset control are internally consistent and contain no local machine path.
- `sourceStructurePortOracle.test.ts` runs that self-verification.

The candidate adapter/test is intentionally absent until the final
`deriveDocumentStructure` binding exists. Add it once against that operation;
do not restore the retired child-process, JSONL, sidecar, handwritten wire, or
granular native-call path.

## Gate

- The candidate must reproduce all 24 expected public values from the exact
  hashed inputs.
- The full streaming verifier must then finish all 323,374 provider rows and
  report every mismatch class; the 24 vectors never substitute for that gate.
- Frozen candidate output may not become its own baseline. Provider parity is
  a non-regression ratchet, not universal structural ground truth.
- Production and production tests never import this experiment.
