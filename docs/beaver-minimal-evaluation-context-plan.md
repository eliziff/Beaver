# Beaver: Minimal Evaluation, Context, Compaction, and Caching Plan

> **Purpose:** give a coding agent a small, ordered engineering plan.  
> **Do not implement this entire document in one pull request.** Complete one step, measure it, and preserve the old behaviour behind a configuration flag until the new behaviour is proven better.

## What not to build yet

Do **not** begin by creating a new Canadian legal benchmark. Use existing public benchmarks first.

Do not build:

- a general evaluation platform;
- a custom legal summarization model;
- a large local Canadian-law corpus solely for testing;
- every provider’s caching implementation at once;
- a single composite “Beaver score.”

Beaver needs a thin runner, good traces, and controlled comparisons.

---

## Rules for every experiment

1. **Change one material variable at a time.**  
   Do not change the model, retriever, prompt, chunking, context policy, and cache policy in the same comparison.

2. **Use the same model and settings for baseline and candidate.**  
   Otherwise the test does not isolate Beaver’s contribution.

3. **Pin everything.**  
   Record the Beaver commit, dataset version/commit, model identifier, provider settings, prompt/config hash, and dependency lockfile.

4. **Keep every raw output.**  
   Do not retain only aggregate scores.

5. **Separate development from reporting.**  
   Use a small deterministic subset while iterating. Run the full benchmark for release checks. Never call a result “unseen” if the benchmark was used during development.

6. **A cheaper wrong answer is not an improvement.**  
   Compare cost and latency only after quality is acceptable.

---

# Step 1 — Add one common evaluation trace

Before changing compaction or caching, make every run measurable.

Each benchmark item should emit an `eval_run.json` containing at least:

```json
{
  "suite": "legalbench-rag-mini",
  "suite_version": "pinned-commit-or-release",
  "item_id": "item-001",
  "beaver_commit": "full-git-sha",
  "configuration_hash": "sha256",
  "provider": "provider",
  "model": "exact-model-id",
  "context_strategy": "full_history",
  "cache_strategy": "none",
  "retrieved_source_ids": [],
  "input_tokens": 0,
  "output_tokens": 0,
  "cached_input_tokens": 0,
  "cache_write_tokens": 0,
  "latency_ms": 0,
  "estimated_cost": 0.0,
  "score": {},
  "output_path": "ignored/local/path"
}
```

Also retain:

- the ordered IDs of retrieved passages;
- hashes of the prompt components and source documents;
- the assembled-context manifest;
- output and artifact hashes;
- errors and retries.

Avoid logging secrets or client contents by default.

### Done when

One command can run a benchmark configuration and produce:

```text
raw outputs
per-item traces
aggregate results.json
human-readable comparison.md
```

---

# Step 2 — Integrate existing benchmarks in this order

## 2.1 LegalBench-RAG-mini: fast retrieval development

Use this first because it is small and tests the part of RAG most affected by:

- chunk size and boundaries;
- embeddings;
- lexical versus dense retrieval;
- hybrid retrieval;
- reranking;
- top-k;
- deduplication.

Measure:

```text
Recall@5
Recall@10
nDCG@10
MRR
retrieved_tokens_per_query
latency
cost
```

Do not involve answer generation at first. Retrieval must be diagnosable independently.

### Done when

The runner can compare two Beaver retrieval configurations on the same items and show whether a quality gain required sending substantially more text to the model.

## 2.2 CanLegalRAGBench: Canadian legal RAG

Add this after the retrieval runner works.

Test it in two stages:

1. **Retrieval only:** did Beaver retrieve the annotated relevant Canadian cases?
2. **End-to-end answer:** did Beaver make supported, responsive claims from the retrieved material?

Report strict benchmark metrics, but preserve retrieved cases for manual review. The benchmark authors found that automatic scoring can penalize genuinely relevant authorities omitted from the annotated gold set. Do not silently count every out-of-gold case as either correct or incorrect.

Use a deterministic development subset while iterating. Run the full dataset for release checks and disclose that the public benchmark was used during development.

### Done when

A report separates:

```text
retrieval failure
generation/grounding failure
unsupported claim
citation failure
irrelevant over-answering
```

## 2.3 LongMemEval: memory and compaction

Use LongMemEval to compare conversation-memory strategies. It tests extraction, knowledge updates, temporal reasoning, multi-session reasoning, and abstention.

This is not a legal benchmark, but it answers the engineering question: **does the context system preserve and retrieve information from long conversations?**

Run it against the same model using each context strategy described below.

### Optional later suites

Only after the above works:

- a public legal-agent benchmark for end-to-end document work;
- RedlineBench if native tracked-change DOCX editing is a Beaver priority.

Do not add several suites before the first three produce reliable traces.

---

# Step 3 — Separate stored history from model context

The full transcript should be durable audit history, not the prompt sent on every turn.

Implement three separate layers.

## A. Append-only event log

Store every:

- user message;
- assistant message;
- tool call and result;
- uploaded document/version;
- state update;
- compaction event.

Do not destroy this when compacting.

## B. Structured matter state

Maintain an inspectable JSON object for legally important state:

```json
{
  "matter_id": "matter-001",
  "jurisdictions": ["CA-AB"],
  "law_as_of": "2026-07-27",
  "objective": "Prepare a research memorandum",
  "active_instructions": [],
  "superseded_instructions": [],
  "facts": [],
  "disputed_facts": [],
  "authorities": [],
  "document_versions": [],
  "accepted_edits": [],
  "open_questions": [],
  "privacy_flags": []
}
```

Every material entry should contain provenance:

```json
{
  "value": "The agreement was signed on 2024-03-01.",
  "source_id": "DOC-004",
  "locator": "page 7",
  "originating_turn": "TURN-006",
  "status": "asserted"
}
```

Model-proposed state patches must be:

- schema validated;
- versioned;
- linked to the originating turn;
- reversible;
- explicit about supersession rather than silent replacement.

Never preserve the following **only** in a prose summary:

- citations and authorities;
- exact quotations;
- paragraph/page/section pinpoints;
- jurisdiction and law-as-of date;
- deadlines;
- active and superseded instructions;
- current and superseded document versions;
- accepted edits;
- disputed facts;
- privilege or sensitivity flags.

## C. Prompt assembler

Build the working prompt from components, in this order:

```text
1. stable system instructions and relevant tool definitions
2. pinned legal/safety/output constraints
3. structured matter state
4. request-specific retrieved evidence
5. bounded recent conversation/tool tail
6. current user request
```

Emit a manifest showing the token count and hash of every component.

---

# Step 4 — Put context strategies behind one switch

Implement these as interchangeable strategies:

```text
full_history
recent_tail
summary_plus_tail
legal_state_retrieval_tail
provider_native_plus_legal_state
```

Do not implement all five at once. Start with `full_history` and `legal_state_retrieval_tail`.

A practical initial configuration:

```yaml
working_context_tokens: 32000
compact_at_ratio: 0.78
recent_tail_tokens: 8000
retrieved_evidence_tokens: 16000
narrative_summary_tokens: 2000
```

These are test defaults, not universal truths. Reserve output/reasoning space separately and tune them using benchmark results.

## `legal_state_retrieval_tail` mechanics

On each turn:

1. append the new events to the durable log;
2. propose and validate a matter-state patch;
3. retrieve evidence needed for the current request;
4. retain a bounded recent tail;
5. summarize only older narrative/tool history that is still useful;
6. assemble the prompt within the working budget;
7. record what was included, excluded, or compressed.

The narrative summary should explain conversational continuity and prior decisions. It should not become the sole store for legally material facts.

## Provider-native compaction

Treat provider-native compaction as an optional transport optimization.

For example, OpenAI currently returns an opaque compaction item. Beaver cannot inspect that item as authoritative legal state. Always pair native compaction with Beaver-owned structured matter state and the append-only log.

---

# Step 5 — Test compaction without inventing a large Beaver benchmark

Use:

- **LongMemEval** for broad memory performance;
- **CanLegalRAGBench** to ensure legal retrieval/answer quality does not regress;
- a few small Beaver integration tests for mechanical invariants.

The Beaver tests are not a new substantive benchmark. They only verify that the machinery preserves:

1. a newer instruction that supersedes an older instruction;
2. the current document version rather than a superseded version;
3. an exact citation, quotation, and locator;
4. a disputed fact that must not be treated as established;
5. a jurisdiction and law-as-of date stated early in the matter.

Compare, with the same model:

```text
full_history
legal_state_retrieval_tail
provider-native-plus-legal-state (later)
```

For close or release decisions, run stochastic configurations at least three times.

### Ship gate

Do not adopt a compacted strategy unless it produces:

- no additional failed legal-state invariants;
- no material reduction on LongMemEval;
- no material reduction on the selected legal benchmark;
- lower input-token use, with an initial target of at least 25%;
- no unacceptable latency or review-cost regression.

Record exact counts and confidence limits where practical. Do not hide weak categories inside an overall average.

---

# Step 6 — Add Beaver-owned caches before provider caches

Implement local, content-addressed caches in this order:

| Cached object | Cache key |
|---|---|
| Parsed document | file hash + parser version |
| Chunks | parsed-text hash + chunker/config version |
| Embeddings | chunk hash + embedding-model ID |
| Retrieval result | query hash + filters + index revision |
| Citation validation | citation/locator + source hash + validator version |
| Rendered preview | document hash + renderer version |

Requirements:

- a content or implementation change naturally causes a miss;
- cache hits and misses produce equivalent substantive results;
- caches are deletable and inspectable;
- matter-specific data is scoped by matter;
- tests prove invalidation works;
- traces record hits, misses, avoided work, and time saved.

Do not add Redis or a separate cache service unless local storage is demonstrably inadequate.

---

# Step 7 — Add provider prompt caching for one provider

Do this only after the prompt assembler is stable.

Expose a provider-neutral request shape:

```text
stable_prefix
dynamic_suffix
matter_scope
cache_policy
```

Arrange the prompt for prefix reuse:

```text
stable tools
stable system instructions
stable examples or rubric
stable source packet, when reused
---------------- cache boundary ----------------
current matter state
request-specific evidence
recent tail
current request
```

Keep timestamps, random IDs, changing tool definitions, and user-specific content out of the stable prefix.

Implement the provider Beaver actually uses most. Measure:

```text
cache-write tokens/cost
cache-read tokens/cost
hit rate
latency
total cost per successful benchmark item
```

Then add a second provider only if the first implementation proves useful.

Current provider behaviour differs:

- OpenAI caching depends on exact prompt prefixes and supports cache-routing keys and explicit breakpoints on current models.
- Anthropic supports automatic or explicit prefix breakpoints, normally with a five-minute cache lifetime and an optional longer lifetime.
- Gemini supports implicit caching on current models; explicit cache objects depend on the API surface used.

Re-read the official documentation immediately before implementation. Provider caching, pricing, retention, and eligibility rules change.

Caching does not shorten context and does not protect against irrelevant old history. Keep compaction and caching as separate features.

---

# Step 8 — Later, run controlled product trials

Once the runner is stable, select a small set of public closed-source legal tasks that include:

- identical instructions;
- identical uploaded source documents;
- objective rubric criteria;
- exportable outputs.

Run each product in a fresh workspace, record the product/date/settings, export the answer, remove product branding, and score it blind with the same rubric.

Keep this separate from Beaver development. The immediate goal is to improve Beaver against frozen public tasks and its own frozen baseline—not to produce vendor marketing claims.

---

# Recommended pull-request order

## PR 1 — Common trace and comparison report

No context changes yet.

## PR 2 — LegalBench-RAG-mini adapter

Establish retrieval baselines and token-volume metrics.

## PR 3 — Append-only log, matter-state schema, and prompt manifest

Preserve current full-history behaviour as the default.

## PR 4 — `legal_state_retrieval_tail`

Add the first compacted strategy behind a feature flag.

## PR 5 — LongMemEval adapter and context ablation

Compare full history against the new strategy.

## PR 6 — CanLegalRAGBench adapter

Verify Canadian retrieval and grounded answering.

## PR 7 — Local parsing/chunk/embedding caches

Measure avoided work.

## PR 8 — One provider prompt-cache adapter

Adopt only if benchmarked net cost or latency improves without quality loss.

---

# Coding-agent instruction

```text
Implement only the requested pull-request step from
docs/beaver-minimal-evaluation-context-plan.md.

Before editing, read AGENTS.md and the relevant current benchmark,
conversation-state, provider, and storage code. Do not refactor unrelated
code. Preserve existing behaviour behind a feature flag where appropriate.
Pin external benchmark versions and do not modify their prompts or gold data.
Add deterministic tests first where practical.

At completion, report:
1. every file changed;
2. every command run;
3. baseline and candidate results;
4. token, cache, latency, and cost changes;
5. any quality regression or unresolved uncertainty.
```

---

# Primary references

- [Beaver repository](https://github.com/eliziff/Beaver)
- [LegalBench-RAG](https://github.com/zeroentropy-cc/legalbenchrag)
- [CanLegalRAGBench](https://github.com/NLP-UBC/CanLegalRAGBench)
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
