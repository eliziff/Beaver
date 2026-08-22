# Instrument lineation parity

## Result

On 2026-08-22, the Rust `instrument_lineation_hypotheses` primitive matched
the displaced TypeScript implementation byte-for-byte on every available
input in both relevant local surfaces:

- 124 LegalBench-RAG agreement texts (69 mini and 55 holdout); and
- all 748 registered digital-native PDF extractions: 24,707 pages and
  1,221,262 extracted lines.

The gate checked 872 documents, 66,836,213 UTF-8 input bytes, and 1,958
deduplicated lineation hypotheses. It found zero mismatches in 22.932 seconds.
The TypeScript-oracle and Rust-candidate aggregate SHA-256 were both
`2a096d7b4155c431d66f57f8e4aef3c968762d9eff811c5234ae2698fd944284`.
The framed input SHA-256 was
`5e01fe03484840a584db1c2eca90cfab4bb704af77d53fac9fdcf577d078a2d9`.

This is a porting-parity receipt, not an accuracy claim. The 748-PDF surface
has no comprehensive structure ground truth; here it proves only that moving
lineation hypothesis generation from TypeScript into the shared Rust engine
changed no bytes. Public skeleton behavior is additionally protected by the
focused 46-test backend structure suite.

The next ownership slice used the same 872-document surface in a temporary
dual-execution build: Rust and the pre-deletion TypeScript selector chose the
same winning graph for all 872 documents. That shadow pass completed in
50.474 seconds. The TypeScript `headSpan` and `endorsement` selector was then
deleted; provision-reference recognition remains outside the structure engine
and enters the Rust selector only as typed `{ key, start, end }` evidence.

## Gate

The gate fails closed unless the agreement denominator is 124 and the PDF
cache is exactly 748 documents, 24,707 pages, and 1,221,262 lines. It reports
progress every ten documents and continually writes a compact partial report
under `.tmp/`.

```powershell
.\backend\node_modules\.bin\tsx.cmd experiments\instrument_lineation_parity\gate.ts
```
