# Tabular review: Jev routing

The existing review table, column questions, document reader, citations and cell
store are unchanged. With a TypeSafe key configured, `auto` lets Jev **finish
suitable cells**, rather than add passage hints before repeating every LLM call.

## Execution

`extraction.ts` asks the configured review model to classify whole column prompts
into direct judgments/source selections or normal review. This is a single semantic
routing call, not a legal DSL or question decomposition. It permits meaning-based
classification, entailment and supplied-rubric judgments; legal terminology is not
an exclusion. Compound deliverables, open-ended explanations, exhaustive lists,
calculations and outside-source/dependent investigations stay with normal review.

The result is shared across concurrent rows and cached for ten minutes, keyed by
user, model, policy and **all** column definitions. Edits invalidate it. This cache
is per worker, not a durable promise that a table will never need another routing
call. Failure falls back; it does not become a user-facing planning error.

For a fitting text-only scope, the existing reader finishes the bounded packet.
Jev then answers the original questions and selects relevant evidence (including
conditions and contrary material) using parallel Choice/Noul questions. A second
call checks each proposed answer against **only its selected citations**. Both
checks must pass the configured thresholds. The existing cell validator still
checks format, exact evidence integrity and citation presentation before publishing.

Accepted cells are removed from the normal model's request. If all cells finish,
there is no normal answering call. Otherwise **one existing row-level call** handles
the remaining columns and receives every page already read, with continued Read
access. Failed Jev guesses are not supplied as authoritative answers or hints.

Source selection currently supports one explicitly stated date, number, percentage
or monetary amount. Dates support ISO and English month-name forms, not ambiguous
numeric dates or computed deadlines. Occurrence identity is preserved. No names,
amounts or dates are invented by the candidate finder. Unsupported/missing/overflowing
candidates fall back. Text classification requires a closed set explicitly named
in the prompt; tagged columns use the user's original tags.

## Configuration and limits

Set `TYPESAFE_API_KEY` only when the deployment authorizes sending review text to
TypeSafe. `BEAVER_JEV_TABULAR_MODE=auto` is the default when the key exists; `off`
disables it. The old `assist` and `shadow` paths are removed. No key means no routing
call and no TypeSafe request. Both local and cloud hosts use this same boundary.

`TYPESAFE_JEV_MODEL` defaults to pinned `jev-1.13.0`; moving aliases are refused.
Defaults: answer probability 0.95, joint citation-support probability 0.95, evidence
selection probability 0.5, and 4 seconds for the entire Jev decision phase.
These are **initial operating thresholds, not measured legal accuracy claims**.
The original classification prompt and source/version-bound evidence remain
inspectable. Existing Read receipts distinguish the `tabular_judgment` purpose and
record Jev's actual model, routing policy, thresholds, decisions, usage and latency;
the enclosing job retains its configured normal-model identity.

Packets are capped at 160 passages and 96,000 text/ID bytes, with 192,000-byte
requests, 256 questions per batch and eight calls per row. These are byte/transport
limits, not an exact tokenizer. Provider context-limit refusals fall back without
truncation. All selected support must fit the existing four-citations-per-claim
contract; extra evidence is not silently dropped. Partial scopes, image-dependent
reads, missing evidence, uncertainty and provider failures cannot publish a Jev
answer. Jev never publishes `not_found` or turns missing candidates into `No`.
Cancellation remains cancellation; it does not launch a new fallback request.

## Validation and measurement

Focused tests: `npm test --prefix backend -- jev.test.ts extraction.test.ts`.

The live comparison uses the **actual extractor and reader** in both modes:

```sh
cd backend
npx tsx experiments/jev-tabular/benchmark.mjs --live --model <configured-model> --out <new-results.json>
```

It requires the normal reader/native prerequisites. Metered normal providers also
require `--allow-metered`; no live calls run without `--live`. Six authored synthetic
rows cover 15 columns: mutual/unilateral duties, explicit negative permissions,
source dates, fees, a playbook rubric, and compound questions that must remain on
the normal route. Gold is separate and never sent to a model. Eleven cells have
exact value/evidence checks; four test routing only, not narrative correctness.
The credit maturity prompt deliberately tests the existing single-date format
conflict: Jev must not silently discard the second facility's maturity.

Results retain failed rows, source hashes, per-cell output and Jev decisions,
routing-call and normal-answering-call counts, and end-to-end elapsed time. They
measure whole-row savings, including setup. Synthetic checks are a starting corpus,
not a replacement for held-out legal documents or prompt families. Existing PR #122
remains the broader independent decision/reranking qualification harness.

## External basis

- [TypeSafe primitives](https://docs.typesafe.ai/primitives): Choice and Noul wire semantics.
- [Model limits](https://docs.typesafe.ai/models): pinned model and text/context requirements.
- [Confidence routing](https://docs.typesafe.ai/patterns/confidence-routing): accept-or-fallback pattern.
- [Source-value selection](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook): find candidates, select, copy.
- [Mike workflow columns](https://github.com/Open-Legal-Products/mike-workflows/tree/main/tabular-review-workflows): conventional compound column requirements.

The classifier and acceptance policy are this implementation's decisions, not
claims that these sources establish Jev's performance on Beaver's corpus.
