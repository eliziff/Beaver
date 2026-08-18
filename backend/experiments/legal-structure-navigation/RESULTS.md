# Results

## 2026-08-13 — quarantine baseline

- Literal cross-reference traversal remains production functionality.
- On the recorded LegalBench-RAG mini study, defined-term and lexical edges
  underperformed contiguous context; they remain hypotheses, not retrieval
  inputs.
- Page/section summaries, graph hubs, neighbourhoods, and the outline formatter
  were reachable only through retired research surfaces. Their implementations
  and behavioral checks are preserved here for later evaluation.
- Folded find recovered measured served-Markdown misses (emphasis markers,
  escaped punctuation, and smart quotes), but was never adopted by the
  canonical `Grep` path. It remains available for a direct A/B.

Decision: retained as experiments; none promoted.

## 2026-08-18 — working-set exposure quarantine

Interval-based body-exposure accounting had no production consumer; its only
caller was its own test. The algorithm and its overlap/index witnesses now live
here until a measured navigation policy needs them. Production's bounded
`Read` no longer maintains a second exposure ledger.

## 2026-08-18 — virtual structure boundary

Production created an empty working-set map but had no producer for it. The
associated virtual-file `Read`/`Grep`, `.toc`, section-lead injection, and
source-exposure branches were therefore unreachable. The DOCX-to-served-text
anchoring algorithm is preserved here in `docxSectionAnchors.ts`, alongside the
existing navigation and exposure experiments. Canonical production `Read` and
`Grep` still return bounded exact source spans and evidence receipts.

Decision: keep virtual structure views out of production until an experiment
demonstrates that they improve task outcomes enough to justify a real producer
and a smaller public contract.
