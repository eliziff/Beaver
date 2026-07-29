# Beaver Evaluation, Benchmarking, Context, and Caching Implementation Brief

> **Suggested repository path:** `docs/beaver-evaluation-context-plan.md`  
> **Status:** implementation plan, not a request to implement everything in one change  
> **Last verified:** 2026-07-27  
> **Repository:** Beaver / Mike-Canada

## Operating instruction for the coding agent

> **Priority override (user, 2026-07-28):** external benchmarks first. Defer
> further Beaver-CAN iteration — no new internal tasks, gold, or validators
> unless the user asks. Run our capabilities against extant external suites
> (LegalBench, LegalBench-RAG, including the US material) and report against
> their published baselines. Existing Beaver-CAN assets stay maintained but
> frozen.

Read `AGENTS.md`, `docs/mike-canada-master-plan.md`, and the relevant existing code before changing anything. Those files override this plan.

Implement this plan **one numbered issue at a time**. Keep changes small, measurable, local-first, and reversible. Do not create a second evaluation framework beside the existing `benchmarks/` work. Reuse the existing `benchmarks/docx_corpus`, `benchmarks/gold_contract`, and `experiments/context_compaction_track_*` conventions where practical.

Do not commit downloaded benchmark corpora, private gold data, model traces, generated artifacts, caches, credentials, or client information. Prefer download/setup scripts, pinned versions, checksums, manifests, and ignored local result directories.

---

## 1. What this work must answer

Build a reproducible evaluation system that can answer five practical questions:

1. Does Beaver improve on calling the **same foundation model directly**?
2. Does a proposed Beaver change improve on a frozen Beaver baseline?
3. Is a failure caused mainly by retrieval, reasoning, document handling, context management, or output generation?
4. Does a cost-saving change preserve legally material instructions, authorities, quotations, pinpoints, and document versions?
5. Can Beaver be tested on the same closed-source task packet later used in Harvey, Legora, or another legal product?

Do **not** treat a public Harvey benchmark as the Harvey production product. Do **not** claim that Beaver beats current Harvey or Legora without running the same tasks, source packets, and rubric through the actual products.

The initial objective is an engineering instrument that catches regressions, not a marketing leaderboard.

---

## 2. Decisions already made

Use these defaults unless measured evidence supports changing them:

- Start with a **three-task vertical slice**, then expand to `Beaver-CAN-12`.
- Compare four arms:
  - `bare_model`
  - `oracle_sources`
  - `beaver_baseline`
  - `beaver_candidate`
- Use an **all-pass task score** plus diagnostic submetrics.
- Treat fabricated authorities, fabricated quotations, invalid pinpoints, wrong jurisdiction, superseded instructions, and leaked seeded identifiers as fatal errors.
- Keep public development tasks separate from hidden holdout tasks.
- Use deterministic validators wherever possible; use model judging only to prefill a rubric for human review.
- Store the complete transcript as an audit record, but assemble a smaller working context for each model call.
- Implement legal-specific compaction as **structured, provenance-bearing matter state**, not as a fine-tuned summarization model.
- Implement Beaver-owned deterministic caches before provider-specific prompt caching.
- Keep provider caching behind existing provider capability boundaries.
- Measure cost per **passing** task, not merely cost per request.
- Change one material variable per comparison.

---

## 3. Benchmark portfolio

### Tier 0 — preserve and connect Beaver’s existing benchmarks

#### `benchmarks/docx_corpus`

Keep this as the corpus-scale, deterministic challenge layer for DOCX/footnote/proposition handling. Preserve its fail-closed gold workflow: provisional labels are not accepted human gold.

#### `benchmarks/gold_contract`

Reuse its metric-contract validation approach rather than inventing incompatible result semantics. Extend only when a second real caller requires the extension.

### Tier 1 — fast development checks

#### LegalBench-RAG-mini

Use on retrieval-related pull requests to test chunking, embeddings, lexical search, hybrid weighting, reranking, deduplication, and precise passage retrieval.

Run when changing:

- chunk boundaries or overlap;
- embedding models;
- BM25 or metadata filters;
- query rewriting;
- reranking;
- top-k selection;
- context packing.

Report retrieval quality **and retrieved-token volume**.

#### Beaver-CAN development tasks

Run the visible development subset on changes affecting orchestration, retrieval, citations, context, memory, document handling, or model prompts.

### Tier 2 — release evaluation

#### CanLegalRAGBench

Use as Beaver’s primary public Canadian legal-RAG benchmark.

Evaluate separately:

- retrieval against annotated relevant cases;
- answer grounding;
- citation/proposition support;
- jurisdiction handling;
- unsupported material claims.

Automatic gold scoring may penalize a legitimate alternative authority. Preserve strict scores, but route plausible out-of-gold authorities to human adjudication and report an adjudicated score separately.

#### Harvey Legal Agent Benchmark (LAB)

Select approximately 15–25 transferable tasks involving supplied matter documents, drafting, diligence, review, extraction, or closed-source research.

Prefer tasks where the governing materials are included. Initially avoid tasks whose outcome depends primarily on uncaptured United States legal knowledge.

Run Beaver against the task packet and required deliverables, then use LAB’s rubric machinery where compatible.

**Claim boundary:** this compares Beaver with a public Harvey-designed benchmark or stock harness, not with the Harvey production product.

#### RedlineBench

Adopt a 12–20 task subset only after Beaver can reliably edit a DOCX in place with native tracked changes and comments.

Evaluate both legal/commercial decisions and document fidelity:

- tracked insertions and deletions;
- comments and replies;
- numbering;
- styles;
- tables;
- cross-references;
- unrelated formatting preservation;
- multi-turn negotiation state.

### Tier 3 — occasional or external comparison

#### Stanford legal-RAG hallucination dataset

Run the released question set to compare Beaver with archived outputs from historically evaluated commercial legal-research products.

**Claim boundary:** any comparison is historical and product-version-specific, not evidence that Beaver beats current Lexis or Westlaw.

#### Independent private evaluation

Prepare Beaver for submission to a private independent evaluator such as LegalBenchmarks.ai when the product has a stable evaluation interface and data-handling policy.

#### Legora BAR and other private vendor benchmarks

Use their methodology as inspiration only unless the actual tasks, sources, scoring, and product access are available. Do not compare normalized vendor charts with Beaver results.

---

## 4. Build `Beaver-CAN-12`

Create twelve small, high-value matters:

| Track | Count | Purpose |
|---|---:|---|
| Closed-source Canadian research | 3 | Reading, synthesis, legal reasoning, citations |
| Canadian retrieval | 3 | Authority discovery, ranking, jurisdiction, proposition match |
| Citation/document mechanics | 2 | Quotations, pinpoints, TOA, structured document output |
| Synthetic precedent/review | 2 | Versioning, approval status, jurisdiction, clause comparison, redaction |
| Long-thread matters | 2 | Changed facts, superseded instructions, document lineage, compaction |

Split them into:

- **8 visible development tasks**
- **4 hidden holdout tasks**

The hidden gold must not be available to the coding agent or public repository. Implementation changes and hidden-gold changes must never occur in the same pull request.

### Initial three-task vertical slice

Before creating all twelve, implement:

1. one closed-source Canadian memorandum;
2. one retrieval task with relevant and plausible distractor authorities;
3. one scripted long-thread task containing changed facts, a superseded instruction, a replacement document, an early formatting requirement, and a quotation/pinpoint that must survive.

Do not expand until these three tasks produce useful failure information.

---

## 5. Suggested file layout

Fit this into the existing repository rather than moving current benchmarks:

```text
benchmarks/
  beaver_can/
    README.md
    task.schema.json
    gold.schema.json
    tasks/
      dev/
        CAN-RESEARCH-001/
          task.yaml
          prompt.md
          sources/
          gold.yaml
        CAN-RETRIEVAL-001/
        CAN-CONTEXT-001/
    runner/
      run_eval.py
      score_eval.py
      compare_runs.py
    tests/
      test_schemas.py
      test_validators.py
      fixtures/
    private_results/          # ignored
  legalbench_rag/             # adapter/setup, not vendored corpus
  canlegalragbench/           # adapter/setup, not vendored corpus
  harvey_lab/                 # selected-task manifest and adapter
  redlinebench/               # selected-task manifest and adapter
```

Keep hidden holdout tasks outside the public repository or under an ignored path supplied by an environment variable.

Do not create a generalized adapter framework before at least two concrete adapters prove that shared code is needed.

---

## 6. Minimal task and gold contracts

A task should identify the legal and operational constraints:

```yaml
id: CAN-RESEARCH-001
jurisdiction: CA-AB
law_as_of: 2026-06-30
task_type: closed_source_research

deliverable:
  type: memorandum
  maximum_words: 1500
  required_filename: answer.docx

source_ids:
  - SRC-001
  - SRC-002
  - SRC-003

fatal_errors:
  - fabricated_authority
  - fabricated_quotation
  - invalid_pinpoint
  - wrong_jurisdiction
  - outside_source_packet
  - superseded_instruction
```

Gold should describe propositions and acceptable evidence, not one ideal prose answer:

```yaml
required_issues:
  - ISSUE-01
  - ISSUE-02

required_authorities:
  - source_id: SRC-001
    proposition_id: PROP-01
    acceptable_pinpoints: [42, 43, 44]

acceptable_alternative_authorities:
  - source_id: SRC-006
    proposition_id: PROP-01

required_conclusions:
  - id: CONCLUSION-01
    acceptable: [yes, qualified_yes]

forbidden_claims:
  - CLAIM-07
```

Never score legal prose by embedding similarity to a single “model answer.”

---

## 7. Four-arm experiment design

Run applicable tasks using:

| Arm | Inputs | Diagnostic purpose |
|---|---|---|
| `bare_model` | question only | Baseline model knowledge/reasoning |
| `oracle_sources` | question plus correct source packet | Upper bound when retrieval succeeds |
| `beaver_baseline` | frozen Beaver commit | Current product behavior |
| `beaver_candidate` | one changed variable | Proposed improvement |

Interpretation:

- Bare fails, oracle passes: retrieval is likely the bottleneck.
- Oracle fails: reasoning, prompting, source presentation, or task difficulty is likely the bottleneck.
- Oracle passes, Beaver fails: Beaver is losing, obscuring, or mishandling evidence.
- Baseline passes, candidate fails: regression.
- Both pass: compare cost, latency, stability, context size, and review burden.
- Both fail: the cheaper failure is not a win.

For ordinary development, one run may be enough. For a release decision or close result, run each stochastic configuration at least three times and retain every output.

Keep model, effort, temperature, sources, tools, and deliverable requirements fixed when testing a Beaver-only change.

---

## 8. Run trace contract

Every model/agent run must emit one machine-readable record. Extend the existing metric contract only as necessary.

Minimum fields:

```json
{
  "schema_version": "1",
  "run_id": "uuid",
  "task_id": "CAN-RESEARCH-001",
  "arm": "beaver_candidate",
  "started_at": "ISO-8601",
  "git_commit": "full-sha",
  "dirty_worktree": false,
  "provider": "provider-id",
  "model": "provider-model-id",
  "effort": "provider-specific-or-null",
  "context_strategy": "legal_state",
  "cache_strategy": "local_and_provider",
  "prompt_hash": "sha256",
  "source_manifest_hash": "sha256",
  "input_tokens": 0,
  "output_tokens": 0,
  "cached_input_tokens": 0,
  "cache_write_tokens": 0,
  "latency_ms": 0,
  "estimated_cost": 0.0,
  "retrieved_source_ids": [],
  "artifact_paths": [],
  "fatal_errors": [],
  "all_pass": false,
  "manual_review_minutes": null
}
```

Also retain enough receipts to reproduce:

- normalized prompt or prompt component hashes;
- model/provider response identifiers where available;
- retrieved passage IDs and locators;
- document/source hashes;
- tool calls and deterministic tool results;
- output artifact hashes;
- scoring version.

Never put secrets or client contents into logs by default.

---

## 9. Scoring

### Fatal failures

A task automatically fails on any material occurrence of:

- fabricated authority;
- fabricated quotation;
- invalid or non-supporting pinpoint;
- wrong jurisdiction;
- reliance on an impermissible source in a closed-source task;
- reliance on a superseded fact, instruction, or document;
- disclosure of a seeded sensitive field;
- missing or unusable required artifact;
- corrupted DOCX or lost required tracked changes/comments.

### All-pass rubric

Mark each material criterion pass/fail:

1. all material issues identified;
2. required or acceptable authorities used;
3. legal propositions accurately stated;
4. material claims supported;
5. quotations and pinpoints valid;
6. current facts, instructions, jurisdiction, and document versions followed;
7. requested deliverable usable without major reconstruction.

A task passes only when there is no fatal error and every material criterion passes.

### Diagnostic metrics

Report separately:

- criterion pass rate;
- Recall@5 and Recall@10;
- MRR and nDCG@10 where appropriate;
- supported material claims / all material claims;
- valid citations / all citations;
- retrieved input tokens;
- total input/output/cache-write/cache-read tokens;
- median and p90 latency;
- estimated cost;
- manual review/correction minutes;
- pass rate over repeated runs.

Primary economic metric:

```text
cost_per_passing_task =
    total_cost / number_of_all_pass_tasks
```

Use exact counts for small samples, such as `10/12`, rather than implying statistical generality.

---

## 10. Human review protocol

For the small Beaver-CAN suite:

1. strip product/provider names from outputs;
2. randomize output order;
3. let an LLM prefill the rubric and quote supporting passages;
4. manually confirm every material criterion and fatal error;
5. preserve the adjudication reason;
6. reveal the arm only after scoring.

When a benchmark retrieves an apparently relevant authority outside the annotated gold set, preserve the strict automated score and add a human-adjudicated result. Do not silently rewrite gold to make Beaver pass.

---

## 11. Context and memory architecture

### Principle

The full transcript is durable audit history. It is **not** automatically the model’s working memory.

Assemble each model request in this order:

```text
1. stable system instructions and relevant tool definitions
2. pinned legal, safety, and output constraints
3. authoritative matter state
4. request-specific retrieved evidence
5. bounded recent conversation/tool tail
6. current user request
```

### Authoritative matter state

Create or extend an inspectable structured state, conceptually:

```json
{
  "matter_id": "MATTER-001",
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
  "privacy_flags": [],
  "last_updated_from_turn": "TURN-014"
}
```

Every legally material item must carry provenance and status. For example:

```json
{
  "text": "The agreement was signed on 2024-03-01.",
  "source_id": "DOC-004",
  "locator": "page 7",
  "status": "asserted",
  "originating_turn": "TURN-006"
}
```

Model-proposed state updates must be schema-validated, versioned, attributable to a turn, and reversible. Distinguish deletion from supersession. Never silently replace a controlling instruction or document version.

### Never preserve these only in narrative summary

- case/statute citations;
- paragraph, page, and section pinpoints;
- exact quotations;
- source IDs and hashes;
- jurisdiction and law-as-of date;
- deadlines;
- active and superseded instructions;
- current and superseded document versions;
- accepted edits;
- privilege/sensitivity flags;
- disputed facts.

Narrative summaries may retain softer conversational rationale and drafting preferences.

### Initial working-context budget

Use an application-controlled budget rather than filling the provider maximum. A reasonable initial default is approximately 32,000 input tokens, configurable by provider/model capability.

Suggested allocation:

- matter state: 2,000–4,000;
- recent tail: up to 8,000;
- retrieved evidence: up to 12,000–16,000;
- narrative summary: no more than 2,000;
- remaining space: tools, system instructions, current request;
- reserve output/reasoning headroom separately.

Trigger compaction before the hard limit, around 75–80% of the configured working budget.

Keep approximately the last 6–8 conversational turns or last 5 substantial tool/result pairs, whichever is smaller. Store large tool outputs externally and retain evidence handles, hashes, and locators.

### Compaction experiment

Compare:

1. `full_history`
2. `generic_summary_plus_tail`
3. `legal_state_plus_tail`
4. `provider_native_plus_legal_state`

Do not fine-tune a summarizer initially.

Ship a compaction strategy only if the hidden long-thread tasks show:

- zero new fatal errors;
- no lower all-pass count;
- no lost citations, quotations, pinpoints, active instructions, or document lineage;
- materially lower input-token use, initially target at least 25%;
- no unacceptable latency or review-cost regression.

Provider-native continuation or compaction may optimize transport, but Beaver’s own matter state must remain sufficient to inspect, reconstruct, and migrate the matter.

---

## 12. Caching strategy

Caching and compaction solve different problems:

- **Caching** may reduce repeated processing cost/latency.
- **Compaction** reduces the amount of context and distraction.
- A cached long prompt is still a long prompt.
- Correctness must never depend on a cache hit.

### Phase 1 — Beaver-owned deterministic caches

Implement content-addressed local caches first:

| Item | Suggested key |
|---|---|
| Parsed document | file SHA-256 + parser version |
| Chunks | parsed-text hash + chunker/version/config |
| Embeddings | chunk hash + embedding model ID/version |
| Downloaded public authority | canonical source ID + source revision |
| Retrieval result | normalized query hash + filters + index revision |
| Citation validation | citation/locator + source hash + validator version |
| Generated preview/PDF | document hash + renderer version |

Requirements:

- use existing local storage/AppData conventions;
- changing content or implementation version naturally causes a miss;
- expose explicit invalidation/deletion;
- never mix matter-scoped client data;
- add tests proving hit/miss equivalence;
- log actual avoided work.

Do not add Redis or a cache service for a single-user local-first workflow without a proven need.

### Phase 2 — provider prompt-cache adapter

Core Beaver code should express intent, not provider syntax:

```text
stable_prefix
dynamic_suffix
matter_scope
cache_policy
```

The provider implementation translates that into current provider features.

Prompt order for cacheability:

```text
stable tools
stable system instructions
stable examples/rubric
stable source packet, when reused
---------------- cache boundary ----------------
current matter state
request-specific retrieved evidence
recent tail
current request
```

Do not place timestamps, random IDs, token counters, or user-specific dynamic content before the reusable prefix boundary.

Requirements:

- inspect current official provider documentation before implementation;
- use capability discovery rather than a reduced hard-coded model catalog;
- log cache reads, cache writes, hit rate, latency, and net cost;
- compare cache-hit and cache-miss substantive inputs;
- scope keys by matter/tenant where applicable;
- provide a no-cache/stateless fallback;
- review provider retention and zero-data-retention eligibility separately for every feature.

Implement one provider first—the one actually used most—then generalize only after a second provider proves the shared boundary.

---

## 13. Numbered implementation backlog

### Issue 1 — Common run trace

Add the minimum run-trace record and tests.

**Done when:**

- one existing benchmark emits the record;
- schema validation fails on malformed traces;
- secrets/client text are not logged by default;
- the trace records commit, model, prompt/source hashes, tokens, latency, cache usage, cost, artifacts, and score.

### Issue 2 — Beaver-CAN schema and three-task vertical slice

Implement task/gold schemas plus one research, one retrieval, and one long-thread task.

**Done when:**

- all fixtures validate;
- intentionally corrupted gold or outputs fail;
- private results are ignored;
- no downloaded corpus is committed.

### Issue 3 — Four-arm runner and comparison report

Support `bare_model`, `oracle_sources`, `beaver_baseline`, and `beaver_candidate`.

**Done when:**

- one command produces isolated outputs and traces for every selected arm;
- comparison reports all-pass, fatal errors, diagnostics, cost, and latency;
- baseline commit/configuration is frozen in the run metadata.

### Issue 4 — Deterministic legal validators

Start with:

- permitted-source validation;
- exact/normalized quotation occurrence;
- pinpoint existence and proposition check hook;
- required headings/filenames;
- seeded-identifier leakage;
- required provenance IDs;
- DOCX openability and required revision/comment structures.

**Done when:** deliberately corrupted fixtures fail for the expected reason.

### Issue 5 — LegalBench-RAG-mini adapter

Add pinned setup, selected configuration, and result conversion.

**Done when:**

- no corpus is committed;
- setup is reproducible;
- output records retrieval metrics and retrieved-token volume;
- at least one existing retrieval configuration runs end to end.

### Issue 6 — Expand to Beaver-CAN-12

Create 8 visible and 4 hidden matters.

**Done when:**

- visible tasks are stable;
- hidden tasks are outside agent/public access;
- every task has accepted human gold;
- results can be reproduced without editing the harness.

### Issue 7 — CanLegalRAGBench adapter

Implement retrieval first, generation second.

**Done when:**

- strict automatic retrieval metrics are reported;
- out-of-gold plausible authorities can be flagged for adjudication;
- answer scoring separates support, responsiveness, and citation validity.

### Issue 8 — Selected Harvey LAB adapter

Create a pinned manifest of selected transferable tasks.

**Done when:**

- Beaver produces the required deliverables;
- task outputs can be scored by LAB or a documented compatibility layer;
- documentation states that this is not the Harvey product.

### Issue 9 — Matter-state schema and bounded prompt assembler

Add feature flags such as:

```text
CONTEXT_STRATEGY=full_history
CONTEXT_STRATEGY=generic_summary
CONTEXT_STRATEGY=legal_state
CONTEXT_STRATEGY=provider_native
```

**Done when:**

- critical legal state is provenance-bearing and versioned;
- traces identify included/excluded context components;
- full history remains auditable;
- a save/reload preserves current and superseded state.

### Issue 10 — Context ablation

Run the four strategies on the long-thread tasks.

**Done when:**

- each strategy is repeated for release-quality comparison;
- fatal errors, all-pass, tokens, cost, latency, and state losses are reported;
- no strategy ships merely because it is cheaper.

### Issue 11 — Content-addressed local caches

Begin with parsing and embeddings.

**Done when:**

- unchanged content avoids repeated work;
- content/config/version changes cause misses;
- cached and uncached paths are substantively equivalent;
- deletion and invalidation work.

### Issue 12 — One provider prompt-cache implementation

Implement for the most-used provider.

**Done when:**

- cache reads/writes and real net cost are measured;
- stable/dynamic prompt boundaries are explicit;
- no-cache behavior remains correct;
- retention implications are documented;
- no cross-matter key reuse occurs.

### Issue 13 — RedlineBench subset

Only begin after Beaver’s DOCX mutation path is stable.

**Done when:**

- selected tasks edit the supplied DOCX in place;
- tracked changes/comments survive;
- unrelated formatting is checked;
- legal and document-fidelity results are separate.

### Issue 14 — Vendor trial pack

Package 6–8 closed-source tasks for manual use in Harvey, Legora, or another product.

**Done when:**

- each task has identical instructions and source packet;
- vendor output can be anonymized and blindly scored;
- product/date/settings/features are recorded;
- native product research is reported separately from closed-source controlled tests.

---

## 14. Release gates

| Change | Minimum gate |
|---|---|
| Retrieval | No lower end-to-end all-pass count; improved retrieval on previously missed cases or lower retrieved-token volume without quality loss |
| Prompt | No new fatal errors; same or better all-pass count |
| Context compaction | Zero new fatal errors; no lost legal state; target ≥25% lower input tokens |
| Cache | Same substantive behavior on hit/miss; demonstrated net latency or cost benefit |
| Cheaper model | Same all-pass count, or a documented task-specific trade-off explicitly accepted |
| Provider-native state | Beaver-owned state can reconstruct/migrate the matter |
| DOCX editing | Valid package, required revisions/comments preserved, unrelated formatting not materially damaged |
| Vendor comparison | Same packet, same task, blind rubric, complete run metadata |

Cost may break a quality tie. It may not compensate for an unusable legal result.

---

## 15. Pull-request rules

For every benchmark-affecting change:

- one material variable per PR;
- freeze the baseline before running the candidate;
- do not alter implementation and hidden gold together;
- do not change accepted gold merely because Beaver produced a plausible alternative—adjudicate first;
- retain raw outputs locally;
- add a failing test first where practical;
- preserve prior behavior behind a feature flag when risk is material;
- report files changed and exact verification commands;
- run focused tests while iterating and repository release gates before merge;
- revert an optimization that is not a strict measured win.

Suggested coding-agent instruction:

```text
Implement only the requested numbered issue from
docs/beaver-evaluation-context-plan.md.

Before editing, read AGENTS.md, the master plan, and the relevant existing
benchmark/experiment code. Do not refactor unrelated code. Do not modify
accepted or hidden gold. Add a failing test first where practical. Preserve
existing behavior behind a feature flag if the change is risky. Do not add a
dependency without identifying the production caller and explaining what risk
or code it removes. At completion, list every changed file, every command run,
the measured before/after result, and any remaining uncertainty.
```

---

## 16. Claim language

Acceptable:

> Beaver passed 10/12 Beaver-CAN tasks using Model X, compared with 8/12 for the same model without Beaver.

> Beaver retrieved an annotated relevant Canadian authority within the top 10 for X% of CanLegalRAGBench queries under configuration Y.

> Beaver passed X/Y selected public Harvey LAB tasks. This evaluates Beaver on a Harvey-designed public benchmark, not against the Harvey production product.

Not acceptable without direct controlled access:

> Beaver beats Harvey.

> Beaver beats Legora.

> Beaver is enterprise-grade because it scores well on legal tasks.

Capability benchmarks do not establish access control, tenant isolation, ethical walls, auditability, retention, deletion, availability, disaster recovery, DMS security, or organizational support. Maintain a separate enterprise-readiness scorecard later.

---

## 17. Explicit non-goals for now

Do not build yet:

- a complete local copy of Canadian case law;
- an enterprise vector cluster;
- distributed benchmark workers;
- a custom or fine-tuned legal summarizer;
- cross-matter autonomous memory;
- every provider’s caching implementation at once;
- a public leaderboard;
- a single composite “Beaver score”;
- a final LLM-only legal judge;
- automatic ingestion of real firm precedents;
- claims of superiority over inaccessible products.

---

## 18. First milestone definition of done

The first useful milestone is complete when:

1. the run-trace contract exists;
2. three Beaver-CAN tasks exist;
3. one command runs the four arms;
4. deterministic corrupted fixtures fail;
5. outputs, traces, and scores are stored only in ignored local directories;
6. the report shows all-pass, fatal errors, retrieval diagnostics, tokens, latency, cost, and artifacts;
7. the result is informative enough to identify whether a failure came from retrieval, reasoning, context, or document handling.

Stop there and review the instrument before building the remaining tasks or provider caches.

---

## 19. Reference sources

Recheck provider documentation immediately before implementation because API behavior, prices, cache accounting, and retention rules can change.

### Beaver

- [Beaver repository](https://github.com/Open-Legal-Products/mike)
- [Beaver agent guide](../AGENTS.md)
- [Existing benchmark directory](../benchmarks)
- [Existing context-compaction experiments](../experiments)

### Benchmarks

- [Harvey Legal Agent Benchmark](https://github.com/harveyai/harvey-labs)
- [CanLegalRAGBench paper](https://arxiv.org/abs/2605.30497)
- [LegalBench-RAG paper](https://arxiv.org/abs/2408.10343)
- [LegalBench-RAG repository](https://github.com/zeroentropy-cc/legalbenchrag)
- [RedlineBench dataset](https://huggingface.co/datasets/crosbylegal/RedlineBench)
- [RedlineBench code](https://github.com/crosbylegal/redline-bench)
- [Stanford RegLab legal-RAG evaluation](https://reglab.stanford.edu/publications/hallucination-free-assessing-the-reliability-of-leading-ai-legal-research-tools/)

### Provider context and caching

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
