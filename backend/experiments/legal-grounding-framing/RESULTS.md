# Results

## 2026-08-18 — assignment and figure checks quarantined

`legalAssignmentClosure.ts` and `legalFigureReconciliation.ts` were production
modules with no independent production entrypoint. Assignment closure was
reachable only through the now-retired turn exposure ledger; figure
reconciliation had no production caller. Both algorithms are preserved here so
their measured legal-grounding hypotheses remain available without expanding
the shipped assistant path.

Decision: neither check is promoted. Production grounding continues to rely on
exact evidence receipts and citation bindings. Promotion requires a corpus
evaluation and a direct, durable contract rather than an implicit side effect
of document reads.
