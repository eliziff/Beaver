# Legal grounding — restart plan (2026-07-31)

Four audits found the program's instrument, statistics and detectors all
defective. This supersedes the earlier Stage 19 plan.

**Current prior: LegalBench-RAG is not the main bed.** It has no case law, no
citations and no courts, so the citation web, court hierarchy and attested
characterization — the things Beaver does that nobody else can — are
structurally unmeasurable on it. F1 also showed its retrieval numbers are
substantially a query-format artifact (doc recall 1.00 → 0.71 when the document
name is stripped from the query). It gets closed out honestly, not extended.

## Settled

Verbatim membership is sound *as a matcher* (not evidence that quoted claims are
grounded). H16′ diff-carrying rejections (9/9 → 1/41). H17 prompt identity, which
produced the **0–13% checker-stochasticity floor** everything is judged against.
H12 suppression half. Typed claim roles 60/60. R2 phrase bigrams genuinely dead
(−0.15 corrected). The CRLF/LF portability defect — real, and unreported
anywhere upstream. Internal finding; we are not filing it or contacting the
maintainers.

## What went wrong — four classes

**Instrument.** CRLF/LF corrupted every maud number for five stages. D2
double-count inflated recall (235/776 cells >1.0) — R1's falsification compared a
double-counted arm against a clean one. D3 blended reranked and fallback systems.
Re-scoring ≠ re-running: re-deriving fused gives 0.8392 vs 0.8625 re-scored.

**Statistics from the wrong n.** The ±0.015 band was measured at 776 cells and
applied to stages of 32–246. H5 — "harness carries grounding, not model family",
premise #1 — was **8 cells over one item pair**; replicated at n=222 in Stage 20
and **falsified**. flat_recency retired on p=0.264. H18 falsified on ≤1-cell
deltas.

**Detector blindness read as a result.** `statuteSpine`'s label-alone rule matches
centred page numbers; a run of them wins the scope competition and suppresses real
headings (10/69 agreements).

**Bookkeeping.** Stage 13 read a 7→3→2 ladder as an effort effect; the "7" was
Stage 8b's pre-H20 number. Corrected it's flat (6/6/5). **sol@medium — the current
composer — was crowned on that.**

Pattern: every one favoured the incumbent. 16 bars in Stages 14–19 have no
registered rationale.

## Principles

1. Instrument oracle before any run (`text[start:end] == answer`, 100%).
2. Detector-blindness check before any structure verdict.
3. Bars carry a registered rationale.
4. Noise band computed from *that comparison's* n.
5. Every hypothesis ships the control that makes it falsifiable.
6. Receipts are append-only.
7. Precompute and inject retrieval for composed arms.
8. **Nothing is retired on a deterministic proxy.** Retirement needs a robust
   deterministic layer *plus* composed runs across ablations, solo and in
   concert, and only on demonstrated redundancy.

## Done

| commit | fix |
|---|---|
| `1ca6a238` | never reindex on transient `SQLITE_BUSY` |
| `9d4eafe6` | receipts append-only in all three harnesses |
| `a40f46ee` | one explicit per-doc cap per arm, recorded on the row |
| `1d220fce` | resume keys carry every meaning-bearing dimension |
| `74831c08` | product lane: cap decoupled from reranking |
| `0fdc1e81` | page-number runs may extend a spine, never constitute one |
| `bdcd53e6` | contract enumerator dialects, gated by the ladder itself |
| `a8cdd08c`, `2d903c82` | shared reference-grammar kernel; cross-reference graph |

perDocCap confound was **~16× the composer band**. CourtListener widened to
**55,504 opinions** (was 17,343, only 1,332 with text).

## Priority order

**1. Harden the deterministic structure layer** *(in flight)*. Currently 24/69
documents refused, 8/17 on maud; figures are stale — taken before the enumerator
work landed. Re-measure, then attack the causes (privacy_qa heading detection,
6/7 falling back; two NDAs with no sections to attach to).

**2. ~~Premise #1: the checker-family crossing~~ — DONE, and it failed.**
Stage 20 (`fc820b65`, 1,156 checker calls on 289 banked compositions, no
composer call). Cross-family disagreement **35.8% [31.5, 40.4]** against a
**6.3%** same-model floor; paired **+29.5 pp [23.2, 36.0]**. Direction is
symmetric (45.9% fail-closed), so Stage 5's "crossing never introduced a false
accept" is gone; on `housing:0` the *claude* checker false-accepts 6/16 and
codex catches it. Aggregate accept rates match within 3 pp — which is how 8
cells read as family-invariant. The deterministic tier is invariant by
construction (0/4,951 mismatches). **Consequence: every per-cell verdict,
disagreement audit and false-accept count in Stages 6–13 is single-family
evidence.** Arm-level *rates* may still be family-stable; which cells pass is
not. Open thread: 8 claude calls on 4 of 67 tier-cleared rows returned
`unsupported` on all-verbatim answers — a grounding-level contradiction.

**3. Free re-tests on banked data.** C4 ensemble/marginal-value study (zero model
calls, data on disk). H7's decision-quality half — the gate was disjunctive and
only the economic disjunct was tested. Stage 13 ladder re-analysis. Recompute
"93% of keys have one citer" — the full graph says **62%**.

**4. The case-law bed — where the thesis actually lives.** Gate: build the A2AJ
full-text store (provider sqlite is `metadata_only`; 0 of 248,536 documents carry
text; 2–5 h background). Then passage sidecars; Bed A `canlaw-pinpoint` (the quote
located in the cited case *is* the gold; the judge's pinpoint is an independent
check, measured agreement 0.891); Bed B `canlaw-attested` (~1,200 single-citation
journal footnotes, author+editor gold). Gates frozen before build, including the
F1 name-strip test applied to our own bed. Scope limit: gold labels *the paragraph
this judge cited*, so recall is meaningful and precision is systematically
understated.

**5. Arms never run**, ranked by (value if true) × P(discard was wrong):
rank policy **with a citer-count-only control** (without it "authority wins" is
unfalsifiable from base rates) · clause/skeleton re-round · `corpusAlienness`
composed ablation (AUC 0.834, shipped, never given an arm) · attested
characterization at cap 3 · Claude-5 re-run under the hardened transport ·
doc-name-blind rerank · Charlotin adversarial probes · H13 prong 2 and D3's lint
form · B4 judicially-provenanced labels (gates every C4 verdict).

**6. Structure round composed ablations** — `legal-structure-graph-round-2026-07-31.md`.
Built, unproven, never shown to a composer.

**7. LegalBench closeout — low priority, not a gate for anything.** Tier C
(~70 min, pools injected) answers whether `G+ctx` was ever separable from plain
`G`; if not, the crowning unwinds to plain G. The hold-out burn is a **separate
decision**, not queued behind Tier C, on a bed we have deprioritized.

## Do not

Contact or file anything upstream. Add LegalBench stages beyond Tier C. Re-test
against a bar with no rationale.
Decide a composed verdict inside that comparison's band. Rebuild the citator,
journals or alienness indexes — they exist; query them. Promote any model- or
checker-derived label to gold.
