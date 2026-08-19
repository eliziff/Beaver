# Durable findings

- Boundary-aware character and clause chunks retain exact source offsets.
- SQLite FTS passage ranking can improve local-corpus recall over whole-document
  search, and citation resolution can pin a named authority ahead of lexical
  matches.
- Optional listwise reranking only reorders verbatim passages and falls back to
  lexical order on failure.
- The prototype requires a multi-gigabyte derived sidecar and was disabled by
  environment flags in production. It has not earned a permanent product
  storage, update, or authorization contract, so the complete runnable lane
  remains an experiment.

Promotion requires a product-level corpus/update lifecycle, measured retrieval
quality against the frozen legal benchmark, bounded resource receipts, and a
single canonical search contract without environment-selected implementations.
