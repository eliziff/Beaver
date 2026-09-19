# Tabular review: Jev routing

With an authorized TypeSafe key, `auto` lets Jev finish suitable cells with citations.
Accepted cells are removed from the normal review model's request; an entirely
accepted row skips its normal answering call. The table UI, questions, reader and
cell store remain unchanged. No key, or `BEAVER_JEV_TABULAR_MODE=off`, leaves the
normal path in place. The former hint-only/shadow implementation is removed.

## Routing and evidence

The configured review model classifies whole original column prompts: semantic
classification, entailment, supplied-rubric judgments and one stated source value
may use Jev. Compound deliverables, explanations, exhaustive lists, calculations,
outside law and dependent investigations remain on normal review. This does not
decompose questions or equate a Boolean display with an easy legal question.

Unchanged column definitions share cached routing across rows, reordered columns
and regeneration subsets. Only missing definitions are classified. The bounded
256-entry, ten-minute cache is per worker and keyed by user, model, policy and the
whole definition. Edits invalidate their own entry, not every column. Concurrent
misses share work; cancelling one waiter cannot cancel other rows. The last waiter
cancels an unfinished request. Failed routing is not cached.

The existing reader completes a bounded text scope without discarding material.
Jev answers and selects supporting/contrary evidence in shared-state Choice/Noul
batches. Each proposed cell then has a **separate support request containing only
that cell's cited passages**, original question and candidate. Other cells' evidence
is absent, not merely prohibited by a prompt. A probability threshold is still a
prediction, not a correctness guarantee. Direct cells use the existing evidence
integrity, format and citation validator. Their receipts reflect successful
publication; normal answers cannot inherit a Jev acceptance just by citing the
same passage. Persistence errors propagate rather than being retried as inference.

Unresolved cells share one normal row-level answering call, with all prefetched
text/images, current read cursors and continued Read access. Failed Jev guesses
are not fed to that model. Missing input never becomes a direct No or not_found.

Source selections preserve occurrence identity. ISO/English month-name dates,
unscaled scalar numbers/percentages, and literal monetary amounts are supported.
Amounts preserve scale words (USD 5 million), currency placement and source text.
Ambiguous numeric dates, locale decimals, fractions, accounting negatives and
scalars requiring precision beyond the supported number representation fall back
rather than exposing a truncated or rounded candidate.

## Bounds and operation

`TYPESAFE_JEV_MODEL` defaults to pinned `jev-1.13.0`; moving aliases are refused.
Defaults are answer/support probability 0.95, evidence selection 0.5, and a single
4-second deadline for the Jev phase. These are initial settings, not calibrated
legal accuracy. The routing call has its own 15-second deadline.

Limits: 160 passages, 96,000 serialized passage bytes including identity/locators,
192,000 request bytes, 256 questions per batch, at most eight answer batches and
24 total requests per row. At most two requests are in flight per row. Support
requests have reserved capacity. These are transport bounds, not tokenizer claims.
Packing serializes shared state once and counts question bytes incrementally.
Candidates are scanned once per value kind. A malformed answer or failed batch
only disqualifies dependent cells; other results remain usable. Authentication and
rate-limit failures stop unsent requests. No retries or redirects are introduced.

Source/version-bound Read receipts retain policy, routes, thresholds, decisions,
usage and elapsed time. Failed request usage is unknown, never recorded as zero.
The enclosing job retains its configured normal-model identity.

## Benchmark

```sh
cd backend
npx tsx experiments/jev-tabular/benchmark.mjs --live --model <configured-model> --out <new-results.json> --repeats 3
```

Both arms use the actual extractor and reader, including routing overhead. Paired
order alternates; repetitions expose cache-warm behavior rather than always giving
hybrid the second run. Eight authored synthetic rows contain 17 columns: 12 have
annotated value/evidence checks and five check routing only, not narrative quality.
The corpus includes scaled amounts and locale-formatted fees. Gold is not sent to
models; listed equivalent amount renderings prevent penalizing correct formatting.

Reports retain direct/missing/incorrect cells, routing failures, all call counts,
Jev token usage, row p50/p95, source/corpus/gold/code hashes and settings. Normal
model token usage is explicitly unavailable. Snapshots are replaced atomically;
cancellation preserves a valid partial report. Existing outputs are not overwritten.
Native reader prerequisites and TypeSafe credentials are required; metered normal
models additionally require `--allow-metered`. Nothing live runs without `--live`.
No test files are added or changed by this PR. The benchmark is not a claim of
held-out legal accuracy or a replacement for the broader PR #122 experiments.

## References

- [TypeSafe API and primitives](https://docs.typesafe.ai/primitives)
- [Shared-state execution](https://docs.typesafe.ai/patterns/fan-out)
- [Model limits](https://docs.typesafe.ai/models)
- [Source-value selection](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)
- [Conventional Mike review columns](https://github.com/Open-Legal-Products/mike-workflows/tree/main/tabular-review-workflows)
