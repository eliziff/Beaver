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

Finally, collapsing graph derivation and winner selection behind one native
`deriveInstrumentStructure` operation was shadowed against the displaced
multi-call path over the same 872 documents. Every selected graph was
byte-identical. The pass covered 66,836,213 input bytes, 24,707 pages, and
1,221,262 lines in 71.2 seconds; the temporary dual path was then removed.

The instrument-contents reader was then ported literally and checked on the
same 872-document surface before the TypeScript copy was deleted. All 872
readings were byte-identical. The framed TypeScript and Rust output SHA-256
were both
`89a58801a93225325234a52d0423b5f82e1830a5587898e557332fc193db1a78`.
The final optimized pass measured 641.4 ms in TypeScript and 554.5 ms through
the Rust native boundary. A prior optimized pass measured 472.7 ms and 478.7
ms respectively, so these isolated timings establish comparable cost, not a
stable speed ratio. Production does not make this standalone call: contents
now travels with the graph from the existing `deriveInstrumentStructure`
operation, amortizing the text crossing and call overhead.

As with lineation, this is a porting-parity receipt rather than contents
ground truth. The 748 cached PDFs are a broad regression surface; the focused
tests preserve the detector's refusal, nesting, footer, duplicate, page-order,
pageless-tail, guarded-schedule, packed-entry, and UTF-16 offset behavior.

The complete pre-cut instrument product is now frozen on the same 872 inputs.
An independent replay completed in 263.7 seconds with zero mismatches across
separate hashes for provision nodes, SourceDoc blocks/index/ranges, defined
terms, schedules, cross-reference summaries, ladder diagnostics, and contents
outcomes. The aggregate result SHA-256 is
`3f0bb97dd0cccf41342718f45614d7e0b232773e2786db12c962445703d40b5a`.
The receipt covers 60,331 nodes/SourceDoc blocks, 1,171 defined terms, 1,218
schedules, 26,807 internal and 3,124 external references, 3,146 distinct
unresolved targets, 80 accepted contents outlines, and 792 typed refusals.

The 872 text inputs supply no native table-cell maps, so their table-node count
is honestly zero. This freeze therefore does not certify table projection;
the focused table fixtures and complete DOCX/grid inventory remain separate
gates. The per-document component hashes are stored compactly on one line in
`structure-baseline.json`, avoiding a 12,235-line generated-artifact increase.

The final Rust ownership cut replaced the skeleton-only cross-reference
summary with the canonical full graph and removed an unconsumed heading string
from the node receipt. The resulting Rust freeze completed in 59.0 seconds
with result SHA-256
`2658c563c9a461f4f51e5ef1ab00c000512be421ab6c391cce45a9a1c6b2272f`.
It covers 60,331 nodes/SourceDoc blocks, 1,171 defined terms, 1,218 schedules,
50,341 internal and 8,317 external references, and 2,405 unresolved
references. The input receipt remains
`5e01fe03484840a584db1c2eca90cfab4bb704af77d53fac9fdcf577d078a2d9`.
This freeze proves deterministic current output, not historical TypeScript
parity by itself. The paired oracle run then compared every retained product
on all 872 documents and found zero mismatches in 110.3 seconds. Its one warm-
up plus alternating measured calls produced medians of 4.564 ms for historical
TypeScript and 3.298 ms for Rust including projection (1.38x faster); measured
totals were 37.126 and 29.483 seconds (1.26x). Rust's median split was 2.547 ms
derivation and 0.691 ms projection. The test-only historical projector removes
the deliberately deleted, unconsumed node `heading`; contents headings remain
in the comparison.

The historical checkout was `b275951d832bdc4806757c580338b464c3f3da6b`
with addon SHA-256 `5a3ec165...378a4`; the measured Rust addon SHA-256 was
`3bfa515e...8fe0`.

On 2026-08-23, the first Rust-native optimization pass removed per-line
definition metadata work, stopped materializing discarded lineation graphs,
made SourceDoc projection lazy, and replaced descendant rescans with one
ordered pass. The paired 872-document oracle remained exact. Rust measured
1.570 ms median / 11.784 s aggregate including projection, versus TypeScript
at 2.617 ms / 19.531 s (1.67x median, 1.66x aggregate). This is an intermediate
optimization receipt, not the performance target.

## Gate

The gate fails closed unless the agreement denominator is 124 and the PDF
cache is exactly 748 documents, 24,707 pages, and 1,221,262 lines. It reports
progress every ten documents and continually writes a compact partial report
under `.tmp/`.

```powershell
.\backend\node_modules\.bin\tsx.cmd experiments\instrument_lineation_parity\gate.ts
.\backend\node_modules\.bin\tsx.cmd experiments\instrument_lineation_parity\structure_gate.ts
```

Supplying `--oracle-root=...` and `--oracle-addon=...` makes the same gate run
historical TypeScript and Rust for every document, after one warm-up each. The
partial report records exact JSON paths plus paired median and total time;
native derivation and projection are timed separately.
