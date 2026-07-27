# Context compaction research synthesis

Date: 2026-07-26
Inputs:
[Track A](context-compaction-research-track-a.md),
[Track B](context-compaction-research-track-b.md),
[Track A experiment](../experiments/context_compaction_track_a/README.md), and
[Track B experiment](../experiments/context_compaction_track_b/README.md)

## Decision

The two independent tracks support building and testing a layered Mike-Canada
context architecture. They do not support replacing the transcript with a prose
summary, treating an opaque provider checkpoint as an auditable legal record, or
compacting every session by default.

The smallest defensible architecture is:

1. an immutable event log and durable artifacts outside the routine prompt;
2. a deterministic, schema-versioned projection of active exact legal state;
3. an optional provider-owned compact checkpoint, replayed unchanged;
4. a non-authoritative task summary;
5. an event-aware recent tail; and
6. deterministic retrieval of source context when an atomized record is not
   sufficient.

This is a recommendation to test, not a production-readiness finding.

## How the independent findings compare

| Question | Track A | Track B | Synthesis |
|---|---|---|---|
| Method | Pinned implementation and literature review plus a dependency-free offline structural ablation | Independent benchmark review plus exact-scored OpenAI API and Codex smoke tests | A explains why the design is plausible; B supplies bounded behavioral evidence |
| Exact state | Separates immutable events from an active, supersession-resolved prompt projection | Shows an oracle exact capsule can recover all tested fields and that group omissions fail the corresponding fields | Exact application state should be authoritative; capsule generation quality remains untested |
| Recent continuity | Finds that a user-only tail loses an assistant-authored referent and proposes event-aware selection | Uses the same complete eight-turn tail for capsule and prose arms | Event-aware selection is promising but has not received a live-model test |
| Full history | Research review predicts context rot and stale-state risk at scale | Full history scored perfectly in the completed local smoke runs, including one 23,892-input-token fixture | Full history remains the control; local evidence has not yet shown its predicted crossover |
| Prose summary | Structurally exposes only 2/6 required probes | Recovers 4/42 exact fields in both OpenAI and Codex paired runs | Ordinary prose is orientation only, never legal state |
| Native compaction | Official contracts and implementation precedents support it as an opaque optimization | Preserves all 42 tested fields, but its separate call has material up-front token and latency cost | Keep the provider state opaque and separate; trigger it only for headroom or measured amortization |
| Ledger growth | Full append-only ledger exposes four superseded literals; the active projection exposes none | Does not compare append-only and active projections | Active projection is an unvalidated but necessary ablation before choosing the ledger representation |
| Evaluation | Calls for exact legal-state gates, paired live runs, and legal session wrapping | Implements typed exact scoring and controlled capsule omissions | Keep deterministic critical-field grading; use semantic or model judging only as a secondary diagnostic |

There is no result-level contradiction. The main unresolved tension is scope:
Track A predicts that active projection and event-aware selection will beat
larger alternatives, while Track B tests neither prediction. Conversely, Track
B shows that full history and native compaction can work on its fixtures, so
claims that either already fails legal work would overstate the evidence.

## Evidence

This section contains observations in the checked-in artifacts or evidence
reported from the pinned sources reviewed by the tracks. Architectural choices
are kept in the next section.

### Repository-observed results

Track A's offline harness measures literal availability, stale-literal exposure,
and a transparent UTF-8-bytes/4 size estimate. It does not call a model.

| Track A variant | Estimated tokens | Required probes available | Superseded-literal exposures |
|---|---:|---:|---:|
| Full history | 16,601 | 6/6 | 4 |
| Summary + recent full tail | 3,641 | 2/6 | 0 |
| Full ledger + summary + recent full tail | 3,947 | 6/6 | 4 |
| Active ledger + summary + recent full tail | 3,837 | 6/6 | 0 |
| Active ledger + summary + user-only tail | 354 | 5/6 | 0 |
| Active ledger + summary + event-aware tail | 424 | 6/6 | 0 |

These numbers establish structural sufficiency for the synthetic probes. They do
not establish model accuracy, and "stale exposure" is a risk proxy rather than
an observed model error.

Track B uses two synthetic 64-turn fixtures, 21 typed assertions per fixture,
and one repetition per cell. In the corrected paired run:

| Track B arm | OpenAI exact fields | OpenAI hard-pass sessions | Codex exact fields | Mean OpenAI final input |
|---|---:|---:|---:|---:|
| Full history | 42/42 | 2/2 | 42/42 | 4,991.5 |
| Oracle structured capsule + eight-turn tail | 42/42 | 2/2 | 42/42 | 1,418.5 |
| Prose summary + eight-turn tail | 4/42 | 0/2 | 4/42 | 1,158.5 |
| Native OpenAI compaction | 42/42 | 2/2 | not tested in the Codex arm | 3,476.5 |

The structured capsule's final input was 71.6% smaller than full history, but
the benchmark did not charge an extraction or validation call because the
capsule was oracle-built. The native final input was 30.4% smaller, but its
preceding compaction call averaged 4,617.5 input tokens. Under the report's
constant-size assumption, native input-token break-even occurred on the fourth
post-compaction response, not the first. Cached input was zero in these calls.
See the [paired OpenAI result](../experiments/context_compaction_track_b/results/openai-20260727T031117Z.json)
and [paired Codex result](../experiments/context_compaction_track_b/results/codex-20260727T031333Z.json).

The single larger-context fixture produced:

| Arm | Exact fields | Final input | One-time compaction input | Wall time |
|---|---:|---:|---:|---:|
| Full history | 21/21 | 23,892 | - | 3.299 s |
| Oracle capsule | 21/21 | 3,687 | not measured | 2.953 s |
| Prose summary | 2/21 | 3,425 | not measured | 4.842 s |
| Native compaction | 21/21 | 13,329 | 23,518 | 215.158 s |

On the same simplifying assumption, native input-token break-even occurred on
the third post-compaction response. The latency is an n=1 workload observation,
not a provider-level estimate. See the
[full/native stress result](../experiments/context_compaction_track_b/results/openai-20260727T031829Z.json)
and [capsule/prose stress result](../experiments/context_compaction_track_b/results/openai-20260727T031859Z.json).

Controlled omissions failed only the removed state group in the Canadian
fixture: instruction state scored 18/21, pinpoint state 16/21, edit state
19/21, and tool-receipt state 14/21. This verifies the fixture isolation; it
does not prove that another model/session could never infer an omitted value.
See the [ablation result](../experiments/context_compaction_track_b/results/openai-20260727T031145Z.json).

The retained pilot records both full and native arms at 20/21 because punctuation
made the expected URL ambiguous. The corrected JSON fixture removed the
ambiguity. Preserving the [pilot result](../experiments/context_compaction_track_b/results/openai-20260727T030939Z.json)
is useful evidence that benchmark defects can look like model defects.

Local verification during this synthesis passed Track A's self-test, Track B's
self-test, and all five Track B unit tests.

### Evidence reported from reviewed sources

The tracks report the following from official documentation, pinned source, or
primary research:

- OpenAI standalone compact output is opaque and must be replayed unchanged;
  prompt caching is exact-prefix reuse, not memory correctness.
- Codex separates lossy dialogue compaction from typed world-state snapshots
  and patches.
- OpenCode budgets the fully rendered request against output/buffer reserve and
  retains a bounded recent tail.
- Letta/MemGPT provide precedents for hierarchical memory, post-compaction
  recounting, and external recall.
- Lost in the Middle, RULER, and LongMemEval show that nominally fitting full
  history is not a correctness guarantee. LongMemEval also warns that
  fact-level compression can discard useful conversational context.
- LegalBench-RAG and Canadian legal RAG resources contribute retrieval and
  grounding tasks, but none is by itself a controlled session-compaction
  benchmark.

Those source findings motivate experiments. They do not prove that the proposed
Mike architecture is superior on Canadian legal work.

## Inference: proposed Mike-Canada architecture

| Component | Authority and lifecycle | Routine model visibility |
|---|---|---|
| Raw event log and artifacts | Immutable audit/recovery record; preserves every version and original payload | No, except through deterministic replay or retrieval |
| Active legal-state projection | Deterministically rebuilt, schema-versioned, supersession-resolved, and tied to an event high-water mark | Yes, on every legally material turn |
| Provider compact checkpoint | Opaque provider object stored and replayed byte-for-byte/as returned | Yes when that provider continuation is active |
| Task summary | Disposable model-authored orientation: goal, rationale, progress, next action | Optional |
| Event-aware tail | Recent instructions, assistant decision surfaces, unresolved approvals, errors, and bounded tool receipts; unknown events fall back to the full recent tail | Yes |
| Source-context retrieval | Exact quote/qualifier entry points to a fetchable paragraph, section, decision, and lineage | Only when interpretation or verification needs it |

The active projection should contain, at minimum:

- active and superseded instruction IDs;
- authoritative document/source ID, version, and hash;
- exact quote and limiting qualifier;
- locator hierarchy and deterministic source link;
- authority/status metadata used by the answer;
- accepted and rejected edit IDs;
- workflow phase, pending input, approval, and deadline;
- tool receipt status, exit code, truncation, cursor/count, durable artifact ID,
  and artifact hash; and
- projection schema version, event high-water mark, and projection hash.

A model may propose an event, but deterministic application code must validate
and commit it. Arbitrary source or tool prose must never become authoritative
state merely because a model summarized it.

### One falsifiable architecture hypothesis

> Across at least 30 licensed Canadian legal-session fixtures, three independent
> repetitions, and controlled 8k, 32k, and 96k rendered contexts, the architecture
> above using an active exact projection plus an event-aware tail will be
> non-inferior to full-history replay by at most one percentage point in paired
> exact-field accuracy, produce zero silent critical errors, expose no more
> superseded-state answers than full history, and, whenever native compaction is
> triggered, recover its compaction cost by the fourth post-compaction response.

Critical fields are quote, qualifier, pinpoint, authority/source version,
active instruction, edit disposition, deadline/approval, and tool
receipt/durability state. The hypothesis is falsified by any silent critical
error; a paired non-inferiority lower confidence bound at or below -1 percentage
point; a higher stale-state rate than full history; or measured cost break-even
after response four. Chronology questions must explicitly retrieve lineage; a
failure to do so also falsifies the architecture rather than being excused as a
different task.

## Inference: threshold and amortization policy

Compaction should use rendered size and measured economics, not transcript turn
count or a universal percentage.

For each provider/model/tool set, record:

```text
W = provider/model usable context
R = fully rendered input tokens, including instructions, tools, exact state,
    checkpoint or summary, tail, current input, and required excerpts
O = requested maximum output tokens
T = measured p95 token growth before the next safe compaction boundary,
    including expected tool receipts
H = max(O, configured model buffer) + T
```

Policy:

1. **Hard headroom trigger:** compact before sending when `R > W - H`,
   regardless of expected continuation count.
2. **Milestone trigger:** at a durable workflow boundary, compact only when the
   predicted remaining responses are at least
   `ceil(C / (F - K))`, where `C` is measured compaction cost, `F` is expected
   full-history continuation cost, and `K` is expected compacted continuation
   cost. Include any model-assisted capsule-generation/validation call in `C`;
   deterministic event projection should not need one. If `F <= K`, do not
   compact for economy.
3. **Cold-start default:** until a model/workload has enough measurements, use
   four remaining responses as the minimum for discretionary native compaction.
   This is a benchmark candidate derived from the 3-4-response smoke
   break-even, not a universal constant.
4. **Low-water target:** after compaction, require the rendered request to fit
   below `W - 2H`. If it does not, remove disposable tool payloads and old tail
   material or open a fresh provider window. Never trim exact legal receipts to
   hit the target.
5. **Recount and record:** persist pre/post component token counts, compaction
   cost and latency, predicted continuation count, trigger reason, and eventual
   observed break-even.

Use monetary cost rather than raw tokens in `C`, `F`, and `K` when cached input,
output, or reasoning tokens have different prices. A separate latency gate
should prevent a cost-saving compaction from violating interactive service
targets.

## Failure modes and required probes

| Failure mode | Evidence status | Control and benchmark probe |
|---|---|---|
| Prose drops exact legal state | Observed structurally in A and behaviorally in B | Prose-only negative control; exact-field hard gate |
| Append-only prompt ledger resurrects stale values | A observed exposure, not model error | Compare append-only and active projections while increasing supersessions |
| User-only tail loses “the second option” or “that quote” | A observed missing referent, not live behavior | Compare user-only, full, and event-aware tails on deictic prompts |
| Full history suffers middle-position or stale-state errors | Supported by external research; not observed in B's local runs | Scale fixed semantics and independently vary position, noise, and supersession count |
| Active projection drops legally relevant chronology | Inference | Require lineage retrieval on temporal/rationale questions |
| Atomized quote loses surrounding qualification | Inference plus LongMemEval warning | Store fetch handles; test answers that require surrounding provisions |
| Opaque checkpoint silently loses exact state | Contract creates an audit gap; B's tested outputs were correct | Reattach exact state; corrupt/missing checkpoint recovery and repeated-generation tests |
| Partial or truncated tool output becomes “complete” | B omission arm shows receipt dependence | Require observed/persisted status, exit code, cursor, truncation, and durable hash |
| Projection is stale relative to the transcript | Inference | Monotonic high-water mark, compare-and-swap update, replay consistency test |
| Prompt injection becomes durable state | Untested | Typed allowlist, provenance validation, adversarial tool/source payloads |
| Recursive compaction drifts across generations or models | Untested | Test one, three, and five compactions plus cross-model resume |
| Compaction costs more or adds unacceptable latency | Observed in B smoke runs | Apply the measured break-even rule and report p50/p95 latency |
| Exact grader rejects an alternative valid authority | Reported benchmark risk | Deterministic invariants plus blinded dual legal review for genuine alternatives |

## Staged benchmark plan

### Stage 0 - rights and provenance

Do not copy Canadian Semantic LegalBench data into Mike yet. At the pinned
revision reviewed by Track B, the repository is public but declares no license;
public access does not grant redistribution or derivative-fixture rights.
Obtain an explicit license or written permission and review the provenance and
reuse terms of the underlying A2AJ decision text. Until then, use only synthetic
fixtures or a caller-supplied external path, and commit only fixture IDs, hashes,
annotations that Mike owns, and run results.

Apply the same source-level review to CanLegalRAGBench: its code/annotations may
be MIT-labelled, but underlying judicial decisions retain upstream terms. Record
rights per artifact, not merely per repository.

Exit criterion: a machine-readable fixture registry records source, revision,
license/permission, upstream terms, allowed transformations, and redistribution
status for every non-synthetic item.

### Stage 1 - deterministic contract and synthetic controls

- Keep the existing Track A and B self-tests in CI.
- Expand synthetic sessions to 40-80 turns with independently controlled noise,
  supersession count, evidence count, referent position, and tool-output size.
- Add projection replay/hash checks, corrupt-checkpoint recovery, and context
  manifests.
- Run structural ablations before spending on model calls.

Exit criterion: every variant is reproducible from raw events, every expected
field has a deterministic grader, and no tail or omitted block leaks the answer.

### Stage 2 - paired live-model ablation

Use at least 30 synthetic or otherwise licensed fixtures, three independent
repetitions, randomized arm order, and 8k, 32k, and 96k rendered contexts. Hold
model snapshot, reasoning effort, tools, schemas, instructions, output limit,
cache policy, retry policy, and source excerpts constant.

Run:

1. full history;
2. prose summary plus full recent tail;
3. append-only exact ledger plus full tail;
4. oracle active projection plus full tail;
5. oracle active projection plus event-aware tail;
6. automatically generated/updated active projection plus event-aware tail;
7. native compaction plus the external active projection; and
8. Mike's production context path.

Repeat at one, three, and five compaction generations and across same-model and
cross-model resume. Report exact-field accuracy, all-fields hard pass,
stale-state resurrection, abstention, tool selection/refetching, every token
class, cache effects, repair calls, p50/p95 latency, and cost per successful
task.

Exit criterion: zero critical silent errors and the paired non-inferiority lower
bound above -1 percentage point. Do not advance an oracle capsule result as
evidence for the automatic projector.

### Stage 3 - licensed Canadian legal sessions

After Stage 0, wrap licensed Canadian Semantic LegalBench and/or
CanLegalRAGBench content in controlled sessions. Stratify paragraph, section,
and page pinpoints; exact continuation; limiting language; false premises;
reversed tests/holdings; mismatched authorities; contradictory retrieval; and
abstention. Add an instruction supersession, source-version correction, edit
reversal, partial receipt, durable completed receipt, and late update to every
fixture.

Grade exact text, types, hashes, locators, and workflow state
deterministically. Treat semantic similarity only as a secondary diagnostic.
Use blinded dual legal review, with adjudication, where more than one authority
can validly support an answer.

Exit criterion: the architecture hypothesis passes by task stratum and context
length, not only in aggregate.

### Stage 4 - production shadow and canary

Replay consented, de-identified Mike workflows with real tool schemas,
retrieval, prefix caching, failures, retries, session resume, and provider
version changes. Compare predicted and observed compaction break-even and test
recovery solely from raw events plus durable artifacts.

Ship only behind a kill switch and retain full-history replay as the diagnostic
control. Promotion requires zero silent critical errors, no partial receipt
marked complete, reproducible replay, and acceptable p95 cost and latency over a
predeclared observation window.

## Bottom line

Evidence currently rules out prose summary as authoritative legal memory and
shows that an exact capsule can be both sufficient and much smaller in a narrow
synthetic smoke test. It does not yet establish automatic projection quality,
event-aware-tail safety, repeated-compaction safety, Canadian legal correctness,
or population-level superiority over full history.

Build the layered path as an experimental arm, preserve full history as the
control and recovery source, and let the staged gates decide whether it becomes
Mike's default.
