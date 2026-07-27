# Context compaction research — Track A

Date: 2026-07-26
Scope: independent critical review of Mike’s proposed legal-safe session
architecture, current open-source implementations, and primary research
Companion experiment:
[`experiments/context_compaction_track_a/`](../experiments/context_compaction_track_a/)

## Bottom line

Mike’s proposed dynamic three-layer state is defensible:

1. an exact evidence/matter ledger;
2. a lossy task summary; and
3. a bounded recent tail.

It should be tested against full-history replay, and there are good reasons to
expect it to win on cost, latency, stale-state resistance, and exact legal-state
recall. There is **not** enough evidence to say it will categorically outperform
full history on every legal task.

The architecture is likely to win only if all of the following are true:

- the durable audit log and the model-visible ledger are different things;
- the model sees a compact, active, supersession-resolved projection rather
  than every historical ledger version;
- exact state is written and validated by deterministic application events, not
  reconstructed from a model summary;
- exact quotations remain linked to retrievable source receipts, because an
  atomized fact ledger can lose legally relevant context;
- the recent tail retains assistant decision surfaces and bounded tool receipts
  when later user language refers to them;
- compaction is triggered from the fully rendered request with explicit output
  and tool headroom, not merely when the transcript crosses a fixed percentage;
  and
- every strategy is evaluated with exact-state gates and real model calls.

The [current Mike
plan](session-compaction-and-context-efficiency.md#recommended-architecture)
already gets the most important separation right: a prose summary is disposable
model context, while source IDs, versions, quotations, locators, and workflow
state are authoritative structured values. The main correction is to split
“authoritative capsule” into:

- an immutable event/audit record retained outside the prompt; and
- a small active projection assembled for this turn.

Otherwise, the capsule eventually becomes a second full transcript and recreates
the same context-rot problem.

In this report, **evidence** means a behavior directly documented in a primary
paper, official documentation, or pinned source code. **Inference** means an
architectural conclusion for Mike that still requires evaluation.

## The hypothesis being tested

The Mike plan describes five request layers: static instructions/tools,
authoritative state, provider checkpoint or narrative summary, recent tail, and
current input/excerpts. The “three-layer” formulation in this report refers only
to the dynamic continuity state:

```text
active exact ledger
        +
lossy task summary
        +
bounded recent tail
```

Static instructions and the current request remain separate request components.
The immutable raw transcript remains durable recovery/audit data, not a routine
model input.

### Base hypothesis

For a long legal-assistant session containing obsolete instructions, document
revisions, repeated source lookups, and large tool traces, the three-layer
projection will:

- equal full-history replay on hard legal-state assertions;
- reduce obsolete-state resurrection and unsupported answers;
- use fewer input tokens; and
- reduce latency and cost per successful task.

### What would falsify it

The hypothesis fails if, with model/provider/effort and all other request
settings held constant, the three-layer variant:

- loses a current constraint, document version, quotation, hash, pinpoint,
  deterministic link, accepted edit, workflow phase, or pending action;
- cannot answer questions about legally relevant chronology or rationale that
  full history answers;
- increases unsupported legal claims;
- causes materially worse tool selection or unnecessary re-fetching; or
- saves input tokens but increases total cost per successful task through extra
  summarization, retrieval, or repair calls.

## What current systems actually do

### OpenAI Responses compaction

**Evidence.** OpenAI’s official [compaction
guide](https://developers.openai.com/api/docs/guides/compaction) supports
automatic server-side compaction through `context_management` and explicit
stateless compaction. The resulting compaction item is opaque, should be passed
forward unchanged, and can replace earlier stateless input items. When using
`previous_response_id`, clients should send the new message and should not
manually prune the server-managed chain.

The official [deployment
checklist](https://developers.openai.com/api/docs/guides/deployment-checklist#leverage-compaction)
frames compaction as context engineering, not merely overflow handling: old
logs, retries, and obsolete branches can crowd out current state, and meaningful
milestones are useful compaction points.

**Inference for Mike.** Native compaction is a useful provider checkpoint, but
its opacity means Mike cannot audit whether a particular quote hash, paragraph
locator, or document version survived. The application ledger must therefore
remain independently durable and should be re-injected when required. Native
compaction is an optimization, not the legal system of record.

### Codex

Source reviewed: OpenAI Codex commit
[`95637f7056835fea66bdd0044414af480fc0fd74`](https://github.com/openai/codex/tree/95637f7056835fea66bdd0044414af480fc0fd74).

#### Compacted dialogue

**Evidence.** Codex’s local compaction has a 20,000-token budget for retained
user messages. It creates a replacement history from a model-written summary
and selected recent user messages, excluding an older summary from the
user-message collection. The source itself warns that long threads and repeated
compactions can reduce accuracy
([`compact.rs` lines
347–390](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/core/src/compact.rs#L347-L390),
[`compact.rs` lines
525–684](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/core/src/compact.rs#L525-L684)).

The current remote-v2 path uses a 64,000-token retained-message budget and
retains message roles `user`, `developer`, and `system`; assistant messages and
tool results are not part of that retained-message selection
([`compact_remote_v2.rs` lines
439–501](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/core/src/compact_remote_v2.rs#L439-L501)).

Codex derives automatic compaction at 90% of the resolved context window, while
model metadata separately defaults to a 95% “effective context window” for
input usability/headroom
([`openai_models.rs` lines
413–469](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/protocol/src/openai_models.rs#L413-L469)).

**Inference for Mike.** “Recent verbatim tail” should not be described as a
universal Codex behavior. The current local and remote implementations retain
recent input/instruction-side messages, not a complete recent
assistant/tool/user exchange. That is efficient for many coding turns, but it
can fail legal conversational deixis: “use the second option” is not resolvable
if the assistant-authored option list disappeared.

#### Exact world state

**Evidence.** Current Codex also has a separate, typed world-state mechanism.
Each world-state section defines a stable ID and a serializable snapshot.
Codex persists exact section snapshots, computes RFC 7386-style merge patches,
and renders current sections against the exact prior snapshot
([`world_state/mod.rs` lines
194–228](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/core/src/context/world_state/mod.rs#L194-L228),
[`world_state/mod.rs` lines
264–360](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/core/src/context/world_state/mod.rs#L264-L360)).

Rollout reconstruction treats a surviving replacement-history checkpoint as a
complete active-history base. It separately replays full world-state snapshots
and merge patches to recover a baseline
([`rollout_reconstruction.rs` lines
82–120](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/core/src/session/rollout_reconstruction.rs#L82-L120),
[`rollout_reconstruction.rs` lines
319–434](https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/core/src/session/rollout_reconstruction.rs#L319-L434)).

**Inference for Mike.** This is the closest implementation precedent for the
proposed exact ledger. It supports the claim that exact state and lossy dialogue
compaction should be separate channels. It does **not** eliminate the need for
Mike’s legal layer: Codex’s built-in sections cover model instructions,
permissions, environment, tools, plugins, collaboration state, and extension
contributions—not legal authority status, source pinpoints, quotation receipts,
document lineage, or accepted edits.

### OpenCode

Source reviewed: OpenCode commit
[`7ffc22c0ef6aba89fcf0e9de3a58e78a983c1dac`](https://github.com/anomalyco/opencode/tree/7ffc22c0ef6aba89fcf0e9de3a58e78a983c1dac).

**Evidence.** Current OpenCode compaction:

- uses a structured summary template for objective, important details, work
  state, next move, and relevant files;
- defaults to a 20,000-token buffer and 8,000-token recent serialized tail;
- clips tool output to 2,000 characters in the summarizer representation;
- asks the summarizer to retain still-true facts and remove stale ones;
- runs the summarizer without tools; and
- triggers when the fully rendered system/messages/tools estimate exceeds
  `context - max(requested output, buffer)`.

See [`compaction.ts` lines
12–46](https://github.com/anomalyco/opencode/blob/7ffc22c0ef6aba89fcf0e9de3a58e78a983c1dac/packages/core/src/session/compaction.ts#L12-L46)
and [`compaction.ts` lines
128–235](https://github.com/anomalyco/opencode/blob/7ffc22c0ef6aba89fcf0e9de3a58e78a983c1dac/packages/core/src/session/compaction.ts#L128-L235).
Active history is loaded from the newest compaction record forward
([`history.ts` lines
13–53](https://github.com/anomalyco/opencode/blob/7ffc22c0ef6aba89fcf0e9de3a58e78a983c1dac/packages/core/src/session/history.ts#L13-L53)).

**Inference for Mike.** OpenCode supplies strong implementation evidence for a
reserve-based trigger and a bounded full recent tail. It does not supply an
authoritative domain ledger. Its summary prompt can request exact identifiers,
but model compliance is not equivalent to deterministic legal-state
persistence. Its 2,000-character tool serialization cap is sensible for
summary input but would be unsafe as the only copy of legal evidence.

### Letta and MemGPT

Source reviewed: Letta commit
[`b76da9092518cbaa2d09042e52fdcbde69243e18`](https://github.com/letta-ai/letta/tree/b76da9092518cbaa2d09042e52fdcbde69243e18).

**Evidence.** MemGPT introduced a hierarchy of static instructions, mutable
working context, a FIFO message queue with a recursive summary, recall storage,
and archival storage. The model used functions to move information between
memory tiers, and memory editing/retrieval was self-directed
([MemGPT paper](https://arxiv.org/abs/2310.08560)).

Current Letta retains this layered approach while adding more explicit token
accounting and compaction fallbacks. Its sliding-window summarizer seeks an
assistant/approval-safe boundary, retains recent messages, and protects a
pending approval from eviction
([`summarizer_sliding_window.py` lines
128–232](https://github.com/letta-ai/letta/blob/b76da9092518cbaa2d09042e52fdcbde69243e18/letta/services/summarizer/summarizer_sliding_window.py#L128-L232)).
It recounts the compacted context including tools and attempts fallback
strategies when the result remains above the trigger
([`compact.py` lines
351–468](https://github.com/letta-ai/letta/blob/b76da9092518cbaa2d09042e52fdcbde69243e18/letta/services/summarizer/compact.py#L351-L468)).
Its context calculator budgets core memory, memory filesystem, external-memory
metadata, summary memory, messages, and tools separately
([`context_window_calculator.py` lines
184–210](https://github.com/letta-ai/letta/blob/b76da9092518cbaa2d09042e52fdcbde69243e18/letta/services/context_window_calculator/context_window_calculator.py#L184-L210),
[`context_window_calculator.py` lines
312–380](https://github.com/letta-ai/letta/blob/b76da9092518cbaa2d09042e52fdcbde69243e18/letta/services/context_window_calculator/context_window_calculator.py#L312-L380)).

**Inference for Mike.** Hierarchical memory and post-compaction recounting are
good precedents. Model-authored, unstructured working memory is not a sufficient
legal ledger. A model may omit, merge, or rewrite a source detail while
believing it preserved the meaning. Mike should let models propose state
updates, but deterministic code must validate and commit legal-state events.

## What the research says

### Full history is not a free correctness guarantee

**Evidence.**

- [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) found that
  long-context model performance depends materially on where relevant
  information appears, often degrading when evidence is in the middle.
- [RULER](https://arxiv.org/abs/2404.06654) added multi-hop tracing and
  aggregation to simple needle retrieval. Almost all 17 evaluated models
  degraded as length increased, and only half maintained the paper’s
  satisfactory threshold at 32K despite all claiming at least 32K.
- [LongMemEval](https://arxiv.org/abs/2410.10813) tests extraction,
  multi-session reasoning, temporal reasoning, knowledge updates, and
  abstention. At roughly 115K tokens, evaluated long-context models lost about
  30–60% relative to evidence-only oracle contexts. The paper also found that
  storing conversational rounds was generally better than compressing
  everything into individual user facts; fact-level compression lost context
  even though it helped some multi-session reasoning.

**Inference for Mike.** Removing irrelevant history can improve signal density,
but “more structured” is not automatically “more faithful.” The ledger should
contain exact receipts and relationships, while the original bounded source
passage remains re-fetchable. For example, a quote entry should preserve:

- source/version ID;
- exact text and hash;
- locator hierarchy and link;
- the proposition or issue it was retrieved for;
- enough surrounding-span identifiers to fetch context; and
- authority/status metadata when known.

The model should not receive every source passage on every turn. It must be able
to retrieve the passage deterministically when the task depends on nuance beyond
the exact ledger entry.

### Legal benchmarks support exact retrieval, but do not validate session compaction

**Evidence.**

- [LegalBench-RAG](https://arxiv.org/abs/2408.10343) contains 6,858 legal
  retrieval query-answer pairs over more than 79 million corpus characters and
  evaluates minimal relevant snippets at exact character ranges. Its design
  directly supports precise, citation-ready retrieval rather than sending large
  imprecise chunks.
- The new [CanLegalRAGBench](https://arxiv.org/abs/2605.30497) uses realistic
  Canadian legal questions and expert-annotated case-law grounding. Its first
  paper reports that 8–29% of generated claims were unsupported and cautions
  that automatic retrieval scoring can penalize alternative relevant
  authorities.

**Inference for Mike.** Both are valuable downstream evidence tests, but neither
isolates session compaction. LegalBench-RAG primarily tests retrieval; the
current CanLegalRAGBench paper tests Canadian RAG. A valid Mike experiment must
place benchmark evidence inside controlled multi-turn sessions containing
supersession, document revisions, tool noise, and assistant-side information,
then vary only the context strategy.

Prompt-compression results such as
[LLMLingua](https://arxiv.org/abs/2310.05736) are not proof that token-level
compression is safe for quotations, citations, or operative legal language.
Those methods can be evaluated for disposable narrative context, but exact legal
state must be excluded from lossy token compression.

## New falsifiable hypotheses

### H1 — active-projection crossover

An append-only ledger injected into every request will initially outperform a
summary-only context, but it will eventually lose its advantage as superseded
versions and resolved work accumulate. An active, supersession-resolved
projection will retain exact-state accuracy at lower token cost and with fewer
obsolete-state errors.

**Ablation.**

1. full transcript;
2. summary plus recent tail, no ledger;
3. full append-only ledger plus summary and tail;
4. active ledger projection plus summary and tail.

Increase independently:

- transcript/tool-log length;
- number of superseded values per key;
- number of active legal evidence entries; and
- proportion of queries asking for current state versus historical lineage.

**Prediction.** Variant 4 wins current-state and cost metrics. Variant 3 catches
up or wins only on questions that explicitly require history. Variant 2 fails
exact provenance. Variant 1 degrades as irrelevant history and stale alternatives
grow.

**Disconfirmation.** There is no crossover, or the active projection loses
legally relevant chronology often enough that its cost advantage disappears
after repair retrieval.

### H2 — event-aware tail beats both user-only and full tails

A recent user-message-only tail is too aggressive because users refer to
assistant-defined options and recent tool results. A full recent tail is robust
but can be dominated by bulky tool traces. A small event-aware tail that retains
user/developer instructions, assistant decision surfaces, unresolved approvals,
and bounded tool receipts should match full-tail accuracy with fewer tokens.

**Ablation.**

1. no recent tail;
2. recent user/developer/system messages only;
3. complete recent messages up to a token budget;
4. event-aware recent tail plus IDs for re-fetching omitted payloads.

Test deictic prompts such as “use the second option,” “apply that quote,” “accept
the previous edit,” and “continue after the failed lookup.”

**Prediction.** Variant 4 matches variant 3 on accuracy, beats it on tokens, and
beats variant 2 on assistant-side-information and tool-result questions.

**Disconfirmation.** Event classification misses referents or requires enough
special cases that the full tail is simpler and equally efficient in practice.

### H3 — rendered reserve beats fixed-percentage compaction

Compaction triggered from fully rendered system/messages/tools plus requested
output reserve will produce fewer overflow retries and truncations than a fixed
transcript percentage, especially across models with different tool schemas and
output limits.

**Ablation.**

1. trigger at 90% of nominal context;
2. trigger at 80% of nominal context;
3. trigger when rendered input exceeds
   `usable_context - max(requested_output, configured_buffer)`;
4. variant 3 plus a milestone trigger after a durable workflow phase closes.

Measure overflows, unnecessary compactions, post-compaction size, output
truncation, latency, and cost. No universal percentage should be selected before
this test.

## Isolated structural experiment

The dependency-free harness in
[`experiments/context_compaction_track_a/`](../experiments/context_compaction_track_a/)
builds a synthetic legal matter with:

- obsolete and current storage/account settings;
- document versions 1 and 3 with different hashes;
- a source/quote/locator/hash/link receipt;
- large disposable tool traces;
- an assistant-authored option list followed by “use the second option”; and
- six exact-match state probes.

It does not call a model. It checks only whether the required literals are
available, whether obsolete literals remain exposed, and an explicit
UTF-8-bytes/4 size estimate.

| Variant | Estimated tokens | Exact probes structurally available | Superseded-token exposures |
|---|---:|---:|---:|
| Full history | 16,601 | 6/6 | 4 |
| Summary + recent full tail | 3,641 | 2/6 | 0 |
| Full ledger + summary + recent full tail | 3,947 | 6/6 | 4 |
| Active ledger + summary + recent full tail | 3,837 | 6/6 | 0 |
| Active ledger + summary + user-only tail | 354 | 5/6 | 0 |
| Active ledger + summary + event-aware tail | 424 | 6/6 | 0 |

These results establish feasibility, not model superiority. “Superseded-token
exposure” is a conservative risk proxy: a capable model may correctly interpret
the supersession metadata in full history or the full ledger. Provider token
counts will also differ from the estimate.

The result nonetheless exposes two failure modes that the current four-variant
Mike benchmark would not isolate:

- injecting the entire exact ledger preserves facts but preserves stale values
  too; and
- retaining only recent user messages loses an assistant-defined referent.

Run:

```powershell
python experiments/context_compaction_track_a/harness.py self-test
python experiments/context_compaction_track_a/harness.py report
python experiments/context_compaction_track_a/harness.py prompts
```

The harness emits provider-neutral JSONL cases and scores exact answers. It has
no network calls, external packages, or imported benchmark data.

## Required live-model experiment

### Constants

Hold these fixed within each comparison:

- provider and exact model snapshot;
- reasoning effort/mode;
- maximum output;
- system/developer instructions;
- tool names, descriptions, schemas, and result envelopes;
- attachments and source excerpts;
- temperature/seed controls where supported;
- provider storage and continuation mode;
- prompt-cache policy; and
- retry policy.

Use fresh independent sessions for each variant and randomize run order. Run at
least five repetitions because hosted models can remain nondeterministic.

### Variants

Run at minimum:

1. current Mike full-history replay;
2. summary plus recent tail without exact state;
3. full ledger plus summary and tail;
4. active ledger plus summary and full tail;
5. active ledger plus summary and event-aware tail;
6. native OpenAI continuation/compaction plus the same external exact ledger;
7. resumed Codex native compaction plus the same external exact ledger.

Provider-native variants must receive the same legal ledger because the opaque
checkpoint cannot be assumed to preserve audited exact state.

### Workloads

Use three tiers:

1. **Synthetic control.** The included harness, expanded to 40–80 turns and
   multiple compaction boundaries.
2. **Memory control.** LongMemEval questions covering knowledge updates,
   assistant-side information, temporal reasoning, multi-session reasoning, and
   abstention.
3. **Legal grounding.** LegalBench-RAG and CanLegalRAGBench evidence wrapped in
   controlled sessions with source revisions, competing authorities, late
   corrections, and large irrelevant tool outputs.

For the legal tier, preserve benchmark licensing and do not use an evaluator
model as the sole ground truth. Exact source/span/locator assertions should be
deterministic. Expert or dual-review adjudication is needed where multiple
authorities can validly support an answer.

### Metrics and gates

Hard gates:

- exact current constraint and supersession order;
- current document/artifact version and hash;
- quote text/hash, source ID, locator hierarchy, and deterministic link;
- authority/status metadata used by the answer;
- accepted/rejected edit state;
- workflow phase, pending inputs, and approvals;
- no obsolete-state resurrection;
- no unsupported legal proposition; and
- successful recovery from a missing/corrupt provider checkpoint.

Report:

- task success and abstention;
- source/span recall and precision;
- claim-level groundedness;
- input, cached-input, cache-write, output, and reasoning tokens;
- summarization and repair-call tokens;
- time to first token and end-to-end p50/p95;
- compaction count and post-compaction size;
- overflow/retry/truncation rate;
- tool-selection accuracy and repeated retrievals; and
- total cost per successful task.

The architecture passes only if every exact-state gate remains at 100% and the
quality/cost gains repeat across models and session lengths.

## Implementation recommendations

These are inferences to test, not findings already established by the papers.

### 1. Keep two exact representations

Persist an append-only legal/matter event log for audit and recovery. Build a
separate active prompt projection by:

- resolving supersession;
- including only current workflow-relevant entries by default;
- retaining lineage IDs for on-demand historical retrieval;
- including exact receipts, not model paraphrases; and
- recording the transcript/event high-water mark from which it was built.

### 2. Make projection deterministic and inspectable

Each model request should record a context manifest:

- builder/schema version;
- transcript high-water mark;
- ledger snapshot/version/hash;
- included and omitted entry IDs;
- recent-tail boundary and selection reasons;
- summary version and source interval;
- provider checkpoint identity;
- prompt/tool-set hashes; and
- token breakdown by component.

This makes a failed model answer reproducible and separates retrieval failure
from reasoning failure.

### 3. Use event-aware tail selection

Retain:

- recent user/developer instructions;
- assistant option lists or proposed edit surfaces referenced by the user;
- unresolved approvals and pending questions;
- concise tool receipts containing durable IDs/status;
- explicit errors that remain unresolved; and
- a short amount of conversational prose.

Omit bulky payloads after writing a bounded receipt and durable fetch ID.
Selection should be rule-driven from event types, with a safe full-tail fallback
when an event type is unknown.

### 4. Trigger from the rendered request

Calculate:

```text
rendered_input =
    static_instructions
  + selected_tool_schemas
  + active_ledger
  + provider_checkpoint_or_summary
  + recent_tail
  + current_input
  + required_excerpts

compact when:
rendered_input > usable_context - max(requested_output, configured_buffer)
```

Recount after compaction. If still above the target, reduce disposable tail/tool
material or start a new model window; never silently cut exact legal receipts.
Use high/low watermarks so the system does not compact on every turn near the
boundary.

### 5. Treat summaries as caches

A task summary may preserve objective, rationale, completed/active/blocked work,
and next steps. It must never be used to reconstruct:

- quote text or hashes;
- pinpoints or links;
- current document versions;
- authority status;
- accepted edits;
- workflow inputs; or
- supersession relationships.

Regenerate or discard a summary when its source interval, schema, provider, or
prompt contract is incompatible. Recovery must come from raw events plus the
exact ledger.

### 6. Preserve context around atomized legal facts

For each exact evidence entry, retain a fetchable bounded context reference. On
a task requiring interpretation, retrieve the source paragraph/section and
necessary surrounding provisions. This addresses LongMemEval’s warning that
fact-level compression can lose useful context without putting whole documents
into every turn.

## Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Ledger grows without projection | A second full history recreates context rot | Active projection plus on-demand lineage |
| Model writes authoritative state | Omitted or mutated legal facts | Deterministic event validation and commit |
| Projection drops historical rationale | Wrong interpretation of a changed instruction or authority | Fetchable lineage; include history for chronology queries |
| Recursive summary drift | Goals or constraints silently change | Summary is disposable; exact gates come from ledger |
| Tail drops assistant/tool referent | “That quote” or “second option” becomes ambiguous | Event-aware tail and safe fallback |
| Opaque provider checkpoint loses a legal detail | Unverifiable incorrect answer | Re-inject audited exact ledger |
| Tool output is truncated without a receipt | Model treats incomplete evidence as complete | Explicit truncation/cursor and durable source ID |
| Untrusted tool text becomes state | Prompt injection becomes durable | Typed allowlisted events; never ingest arbitrary prose as state |
| Ledger is stale relative to transcript | Current correction is missed | Monotonic high-water mark and compare-and-swap updates |
| Changing ledger hurts prompt caching | Lower cache-hit rate | Stable static prefix; versioned state after cacheable instructions |
| Exact retrieval benchmark over-penalizes alternatives | Valid authority marked wrong | Deterministic spans plus expert adjudication for alternative support |

## Reproducibility and licenses

Pinned repositories were inspected as source, not copied into the experiment.
The local harness is an original standard-library implementation using synthetic
data.

| Project | Pinned commit | License reported by repository | Material inspected |
|---|---|---|---|
| [OpenAI Codex](https://github.com/openai/codex) | [`95637f7056835fea66bdd0044414af480fc0fd74`](https://github.com/openai/codex/commit/95637f7056835fea66bdd0044414af480fc0fd74) | Apache-2.0 | local/remote compaction, model thresholds, world state, rollout reconstruction |
| [OpenCode](https://github.com/anomalyco/opencode) | [`7ffc22c0ef6aba89fcf0e9de3a58e78a983c1dac`](https://github.com/anomalyco/opencode/commit/7ffc22c0ef6aba89fcf0e9de3a58e78a983c1dac) | MIT | compaction and active-history loading |
| [Letta](https://github.com/letta-ai/letta) | [`b76da9092518cbaa2d09042e52fdcbde69243e18`](https://github.com/letta-ai/letta/commit/b76da9092518cbaa2d09042e52fdcbde69243e18) | Apache-2.0 | sliding-window compaction, fallback recount, context component accounting |
| [RULER](https://github.com/NVIDIA/RULER) | [`c3f5e3b4f87f97e048793bb510a3a6b19a46bf3a`](https://github.com/NVIDIA/RULER/commit/c3f5e3b4f87f97e048793bb510a3a6b19a46bf3a) | Apache-2.0 | benchmark provenance; no code adapted |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | [`9e0b455f4ef0e2ab8f2e582289761153549043fc`](https://github.com/xiaowu0162/LongMemEval/commit/9e0b455f4ef0e2ab8f2e582289761153549043fc) | MIT | benchmark provenance; no code/data adapted |
| [LegalBench-RAG](https://github.com/zeroentropy-ai/legalbenchrag) | [`431bc8f2488a81569ab7259fa633dcc50ab77f9a`](https://github.com/zeroentropy-ai/legalbenchrag/commit/431bc8f2488a81569ab7259fa633dcc50ab77f9a) | MIT | benchmark provenance; no code/data adapted |

CanLegalRAGBench was reviewed from its
[paper](https://arxiv.org/abs/2605.30497); no code repository was identified in
the paper metadata reviewed here. Dataset/code availability and licensing must
be verified before incorporation.

## Conclusion

The strongest evidence does not support either “always replay everything” or
“summarize everything.” Current Codex itself now separates exact typed world
state from compacted conversation. OpenCode supplies a practical
rendered-request reserve and a recent full tail. Letta/MemGPT demonstrate
hierarchical memory and recoverable external storage. Long-context research
shows that full history can reduce usable accuracy, while LongMemEval warns that
over-compressing interactions into isolated facts can also lose important
context.

For Mike, the defensible design is therefore:

- immutable raw events for audit/recovery;
- deterministic active legal-state projection for exactness;
- lossy summary for task continuity;
- event-aware recent tail for conversational continuity;
- pinpoint/source retrieval for context on demand; and
- reserve-based, measured compaction with provider-native checkpoints treated as
  optional opaque accelerators.

That design is well-motivated. The included harness makes its new failure modes
explicit. It still must earn deployment through the controlled live-model and
legal-benchmark ablations above.
