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

Column definitions are classified when columns are created or edited. Decisions are saved
with the review and carried in each durable job snapshot; extraction never invokes
the classifier. Worker restarts, long runs, reordered columns, different answering
models and regeneration subsets reuse the saved decisions. Only changed definitions
or a changed routing policy need classification. A generation request prepares any
missing decisions before queuing jobs, including reviews saved without Jev enabled
and failed earlier preparation; individual document rows never classify columns.

The existing reader completes a bounded text scope without discarding material.
Jev answers and selects supporting/contrary evidence in shared-state Choice/Noul
batches. Each proposed cell then has a **separate support request containing only
that cell's cited passages**, original question and candidate. Other cells' evidence
is absent, not merely prohibited by a prompt. The selected candidate must be the
unique highest-probability answer; unresolved and tied choices fall back. Support
must favor yes over no (Noul > 0.5); negative or tied support falls back. Scores are
retained as diagnostics, not subjected to an uncalibrated 0.95 cutoff. These model
judgments do not guarantee correctness. Direct cells use the existing evidence
integrity, format and citation validator. Their receipts reflect successful
publication; normal answers cannot inherit a Jev acceptance just by citing the
same passage. Persistence errors propagate rather than being retried as inference.

Unresolved cells share an initial normal answering turn, with prefetched text/images
and continued Read access where source pages remain. Each cell is submitted once
in that turn. A rejected or omitted cell gets one separate repair turn containing
only its column question, source, rejected submission and validation error. Saved
siblings cannot be rewritten. A failed repair leaves that cell in error; the
application preserves the other cells. Provider, cancellation and storage failures
remain failures rather than being interpreted as rejected answers.

The submission schema binds each column to its value type and allowed tags. An
answered cell needs supported claims; not_found needs a null value, empty claims
and complete reading. Claims take one to four unique passage IDs. Tabular permits
directly reused source wording without quotation marks; that editorial diagnostic
does not reject a cell. Explicit quotations must still match their cited passages,
and evidence integrity, value formats and reader-handle checks remain enforced.
Initial instructions and the tool schema state these rules. Legal-writing callers
retain the default rejection of unmarked copied prose.
Tabular submissions own completion, so generic chat-answer repair is not run over
the row. Failed Jev guesses are not fed to the normal model. Missing input never
becomes a direct No or not_found.

Source selections preserve occurrence identity. ISO/English month-name dates,
unscaled scalar numbers/percentages, and literal monetary amounts are supported.
Amounts preserve scale words (USD 5 million), currency placement and source text.
Ambiguous numeric dates, locale decimals, fractions, accounting negatives and
scalars requiring precision beyond the supported number representation fall back
rather than exposing a truncated or rounded candidate.

## Bounds and operation

`TYPESAFE_JEV_MODEL` defaults to pinned `jev-1.13.0`; moving aliases are refused.
Evidence selection defaults to 0.5, with a single 4-second deadline for the Jev
phase. Answer/support confidence cutoffs are not configurable. The routing call
has its own 15-second deadline.

Limits: 160 passages, 96,000 serialized passage bytes including identity/locators,
192,000 request bytes, 256 questions per batch, at most eight answer batches and
24 total requests per row. At most two requests are in flight per row. Support
requests have reserved capacity. These are transport bounds, not tokenizer claims.
Packing serializes shared state once and counts question bytes incrementally.
Candidates are scanned once per value kind. A malformed answer or failed batch
only disqualifies dependent cells; other results remain usable. Authentication and
rate-limit failures stop unsent requests. No retries or redirects are introduced.

Source/version-bound Read receipts retain policy, routes, acceptance rules, decisions,
usage and elapsed time. Failed request usage is unknown, never recorded as zero.
The enclosing job retains its configured normal-model identity.

## Benchmark

```sh
cd backend
npx tsx experiments/jev-tabular/benchmark.mjs --live --model codex:gpt-5.6-luna --effort max --out <new-results.json> --repeats 3
```

Both arms use the actual extractor and reader. Each fixture's column configuration
is prepared once and reused across repetitions and resumes. Setup duration is
reported separately and included in total elapsed time; row timings exclude setup. Paired
order alternates; repetitions expose cache-warm behavior rather than always giving
hybrid the second run. Eight authored synthetic rows use distinct column configurations
containing 17 columns: 12 have
annotated value/evidence checks and five check routing only, not narrative quality.
The multiple-facility maturity question uses a list column, since a scalar date
cannot represent its requested answer. The corpus includes scaled amounts and
locale-formatted fees. Gold is not sent to
models; listed equivalent amount renderings prevent penalizing correct formatting.

Reports retain direct/missing/incorrect cells, routing failures, Jev token usage,
row p50/p95, source/corpus/gold/code hashes and settings. Measurements include read,
routing, Jev, initial answer and isolated repair durations; rejected/duplicate
submissions; and each cell's acceptance time from row start. Read durations within
an answering session overlap its duration and must not be added to it.

Provider receipts are retained when available. A native provider session may contain
multiple internal requests: inference sessions are counted separately, request
counts remain null without per-request receipts, and adapter-reported usage is not
claimed as complete normal-model token accounting. The benchmark closes its own
Codex app servers on exit.

Snapshots are replaced atomically; cancellation preserves a valid partial report.
Use --case <row-id> for a focused paired run without replaying the whole corpus.
Use the same command with --resume to skip its recorded prefix. Resume verifies
code, corpus, gold, model, effort and settings; it restores saved column decisions
and records the process restart. Existing outputs require this explicit flag.
Native reader prerequisites and TypeSafe credentials are required; metered normal
models additionally require `--allow-metered`. Nothing live runs without `--live`.
The benchmark is not a claim of held-out legal accuracy or a replacement for the
broader PR #122 experiments.

## References

- [TypeSafe API and primitives](https://docs.typesafe.ai/primitives)
- [Shared-state execution](https://docs.typesafe.ai/patterns/fan-out)
- [Model limits](https://docs.typesafe.ai/models)
- [Source-value selection](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)
- [Conventional Mike review columns](https://github.com/Open-Legal-Products/mike-workflows/tree/main/tabular-review-workflows)
