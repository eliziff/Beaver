# Context compaction research — independent Track B

Date researched: 2026-07-26 MDT / 2026-07-27 UTC

This report independently evaluates the hypotheses in
`docs/session-compaction-and-context-efficiency.md` and the benchmark material in
`frontend/public/mike-research-reader.html`. It does not rely on the other
research track.

## Bottom line

Beaver's proposed layered state design is defensible, with one important
qualification: an ordinary prose summary cannot be the authoritative memory for
legal work.

In the bounded experiment built for this report:

- full history, an exact structured state capsule plus an eight-turn tail, and
  OpenAI's native opaque compaction each recovered every one of 21 exact legal
  state fields on two 64-turn fixtures;
- a prose summary plus the identical tail recovered only 2 of 21 fields on each
  fixture;
- the same full/capsule/prose ordering reproduced through `codex exec`; and
- the native result remained 21/21 when controlled distractor context increased
  the full request to 23,892 measured input tokens.

This is a smoke test, not proof of equivalence. There were only two synthetic
fixtures and one run per cell. It does, however, falsify the idea that a normal
high-level prose summary is an adequate substitute for exact legal session
state. It also shows that both an exact capsule and native opaque compaction can
preserve the tested state in a reproducible setup.

Native compaction was not an immediate cost or latency win in these runs. The
compacted *next request* was smaller, but the separate compaction call added more
input tokens and substantial latency. It should be triggered where it can be
amortized over continued work, not indiscriminately on short sessions.

## The OpenAI contract Beaver must respect

OpenAI documents two related but distinct mechanisms:

1. Server-side compaction can be enabled on a Responses request with
   `context_management` and a `compact_threshold`.
2. The standalone `/responses/compact` endpoint returns a canonical next context
   window.

The returned state is opaque and not intended to be human-readable. For the
standalone endpoint, OpenAI expressly says to pass the output array through
unchanged and not prune it. For stateless input-array chaining after server-side
compaction, only material before the most recent compaction item may be dropped;
with `previous_response_id`, the client should not prune manually. See the
[official Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
and [deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist#leverage-compaction).

That produces a clean architecture:

```text
immutable raw transcript and durable artifacts
             |
             +-- exact Beaver state projection (auditable JSON)
             |
             +-- provider-native opaque compact window (never rewritten)
             |
             +-- bounded recent tail and current request
```

Beaver should not deserialize, summarize, "clean up," splice, or selectively copy
fields from an OpenAI compaction item. The exact Beaver capsule is a separate
application-owned projection, not a replacement representation of the opaque
provider state.

Prompt caching is also separate from session memory. OpenAI's
[prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
describes exact-prefix reuse: stable instructions and tool definitions belong at
the beginning and changing material at the end. A cache hit reduces repeated
computation; it does not resolve stale facts, supersession, or compaction
fidelity.

## Exact verification of the named benchmark

The benchmark the user called “Semantic Legal Bench by Marty Rudolf” is exactly:

**Canadian Semantic LegalBench**, authored in the pinned commit by **Marty
Rudolf** (`martinwrudolf`).

- Repository:
  [martinwrudolf/Canadian-Semantic-LegalBench](https://github.com/martinwrudolf/Canadian-Semantic-LegalBench)
- Pinned revision:
  [`e10e23c929c16b5cc3e442c92f885eddb0412171`](https://github.com/martinwrudolf/Canadian-Semantic-LegalBench/tree/e10e23c929c16b5cc3e442c92f885eddb0412171)
- Commit author at that revision: Marty Rudolf; 2026-05-30.
- Access: public and ungated. The 500-row A2AJ-derived JSONL and its summary are
  present under `data/`.
- License: **none declared**. The pinned root contains no `LICENSE` file and
  GitHub reports no license.

The README says the 500 A2AJ documents were manually curated into:

- `pinpoint_summarization_similarity`; and
- `sentence_completion_evaluation`.

Each task has 190 train, 30 validation, and 30 test items, including adversarial
items. The adversarial patterns are unusually useful here: false premises,
reversed statutory sequence or disposition, unsupported identity, mismatched
court/citation, reversed legal tests, reversed facts or holdings, and mismatched
authority.

It is not, by itself, a compaction benchmark. Each row is a static source/prompt
target and the supplied evaluator scores output-target semantic similarity.
There is no long session, forced compaction boundary, update/supersession
sequence, tool receipt, or before/after comparison. Its own README correctly
warns that semantic similarity is not legal correctness and can miss legal
errors, omitted caveats, and invented citations.

It is nevertheless a strong *content source* for a compaction benchmark:

1. place the authoritative pinpoint or continuation early in a 40–80 turn
   session;
2. introduce a clearly non-authoritative adversarial claim;
3. add a later correction or superseding source/version;
4. compact at a controlled boundary;
5. ask for the exact quote, qualifier, locator, source identity, and disposition;
   and
6. grade exact fields and legal invariants, with semantic similarity as a
   secondary diagnostic only.

Because no reuse license is present, this report does not vendor or redistribute
the benchmark data. Public readability is not a permissive license. Before Beaver
ships derived fixtures, the repository should gain an explicit license and the
provenance/reuse terms for underlying A2AJ decision text should be checked.

## Reproducible benchmark inventory

Pinned revisions are the revisions inspected on 2026-07-26. A repository license
describes the repository unless a dataset card or upstream-source caveat says
otherwise.

| Resource | Exact artifact and license | What it contributes | Compaction limitation |
|---|---|---|---|
| Canadian Semantic LegalBench | [commit `e10e23c9`](https://github.com/martinwrudolf/Canadian-Semantic-LegalBench/tree/e10e23c929c16b5cc3e442c92f885eddb0412171); no declared license | Canadian A2AJ pinpoints, continuations, adversarial contradictions | Static semantic benchmark; must be session-wrapped; cannot redistribute without permission |
| CanLegalRAGBench | [paper v1](https://arxiv.org/abs/2605.30497v1); [HF revision `fa20096d`](https://huggingface.co/datasets/UBC-VL/CanLegalRAGBench/tree/fa20096d614bb4fe633ac9bcdd596f74bb792682) | 532 realistic Canadian queries, 588 ground-truth documents, 3,193 query-document pairs; answer grounding and contradictory retrieval | Static RAG evaluation; dataset card uses MIT for code/annotations but source decisions retain upstream terms |
| COLIEE 2026 Task 1 | [official task](https://coliee.org/COLIEE2026/tasks/task1) | Federal Court of Canada noticed-case retrieval with citations redacted | Competition access; no permanent open data license verified; retrieval rather than session memory |
| LegalBench | [paper](https://arxiv.org/abs/2308.11462); [repo commit `b46bf4ff`](https://github.com/HazyResearch/legalbench/tree/b46bf4ffae90524b2b72aaa30e7745fe9db64481); [HF data revision `daec8237`](https://huggingface.co/datasets/nguha/legalbench/tree/daec8237410aa23e3faf4bc41ad8b3a7e1696826) | 162 diverse legal tasks; useful instruction and reasoning content | Mostly static; repo has no top-level license, while the HF data card declares CC BY 4.0 |
| LegalBench-RAG | [paper](https://arxiv.org/abs/2408.10343); [commit `431bc8f2`](https://github.com/zeroentropy-ai/legalbenchrag/tree/431bc8f2488a81569ab7259fa633dcc50ab77f9a), MIT | 6,858 query-answer pairs over more than 79M characters with exact character-level relevant snippets | Excellent minimal-snippet retrieval, but static; underlying ContractNLI/CUAD/MAUD/PrivacyQA sources retain their own terms |
| Harvey Legal Agent Benchmark | [commit `1da47501`](https://github.com/harveyai/harvey-labs/tree/1da4750171bc5a534960b3d82d15ba7fd2cf653f), MIT | Closed-universe matter documents, work product, expert rubrics, long-horizon legal tasks | Tests agent work product, not controlled same-session compaction fidelity |
| PRBench | [paper](https://arxiv.org/abs/2511.11562); [commit `7b2df0a2`](https://github.com/scaleapi/PRBench/tree/7b2df0a28bf99ec51263c41b90dd510a740a7711), MIT | 1,100 professional conversations and 19,356 rubrics, including law | Rich multi-turn work but no explicit full-versus-compacted paired arm |
| LongMemEval | [paper](https://arxiv.org/abs/2410.10813); [repo commit `9e0b455f`](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc), MIT; [cleaned data revision `98d7416c`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f), MIT | 500 questions across extraction, multi-session reasoning, knowledge updates, temporal reasoning, and abstention; strong stale-versus-updated fact tests | Roughly 3 GB cleaned data; not legal; no quote/pinpoint/edit/tool-receipt assertions |
| LOCA-bench | [paper](https://arxiv.org/abs/2602.07962); [commit `8b6fac49`](https://github.com/hkust-nlp/LOCA-bench/tree/8b6fac49d9edd92922593e703b74ea255357c3ec), MIT | Controllable 8k–256k environment growth while task semantics stay fixed; evaluates model plus scaffold and context-management strategy | Strongest general scaffold analogue, but its 15 task types use non-legal mock services and require a separate environment/dependency stack |
| RULER | [paper](https://arxiv.org/abs/2404.06654); [commit `c3f5e3b4`](https://github.com/NVIDIA/RULER/tree/c3f5e3b4f87f97e048793bb510a3a6b19a46bf3a), Apache 2.0 | Synthetic retrieval, variable tracking, multi-hop tracing, and aggregation at configurable lengths | Tests model context ability, not session updates or compaction state |
| LoCoMo | [paper](https://aclanthology.org/2024.acl-long.747/); [commit `3eb6f2c5`](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376); LICENSE text is CC BY-NC 4.0 | Long conversations, QA, and event summaries | Only ten conversations; non-commercial license; not legal |
| ConstraintRot / Governance Decay | [paper v2](https://arxiv.org/abs/2606.22528v2) | Direct compaction-specific instruction-retention benchmark with deterministic prohibited-tool-call grading; motivates constraint pinning | No public benchmark repository, data artifact, or software license was located as of the research date; paper results are not a runnable dependency |
| Compaction as Epistemic Failure | [paper](https://arxiv.org/abs/2607.13071) and [reproduction issue](https://github.com/anthropics/claude-code/issues/76584) | Direct example of exit 143 and partial stdout becoming falsely “confirmed”; motivates receipt status and durable-artifact checks | Case study rather than a broad benchmark |

The practical combination is:

- Canadian Semantic LegalBench and CanLegalRAGBench for legal substance,
  pinpoints, caveats, source identity, and contradictions;
- LongMemEval for update, temporal, abstention, and buried-fact patterns;
- LOCA-bench's fixed-semantics/context-growth method;
- ConstraintRot's instruction-pinning ablation; and
- the exit-status/durable-artifact invariant from Compaction as Epistemic
  Failure.

No single existing benchmark covers all six failure classes Beaver needs.

## Track B executable scaffold

The dependency-free scaffold is at
`experiments/context_compaction_track_b/`.

Files:

- `benchmark.py` — fixture generator, exact scorer, controlled ablations, Codex
  runner, and OpenAI Responses/native-compaction runner;
- `test_benchmark.py` — five local regression tests; and
- `README.md` — commands and interpretation limits.

The two synthetic fixtures are safe to redistribute. Each has 64 turns and 21
exact assertions grouped as:

1. active and superseded instructions;
2. authoritative document ID/version/hash;
3. locator, exact quote, limiting qualifier, and source URL;
4. accepted/rejected multi-turn edits;
5. receipt ID/status/exit code/result count/cursor/artifact hash/truncation; and
6. a deadline updated late in the session.

Older contradictory values appear before explicit authoritative corrections.
The partial tool receipt is later superseded by a completed receipt. A
provisionally accepted edit is later rejected. These are designed to catch stale
resurrection rather than simple needle retrieval.

The arms are:

- `full_history`;
- `structured_capsule` — exact oracle capsule plus the last eight turns;
- `prose_summary` — ordinary lossy narrative plus the same tail;
- `native_openai_compact` — full window through `/responses/compact`, returned
  output passed unchanged to `/responses`;
- `no_instruction_state`;
- `no_pinpoint_state`;
- `no_edit_state`; and
- `no_tool_receipt_state`.

`--noise-repeats N` grows non-authoritative distractor context while holding the
legal state, turn count, and final question fixed. This borrows LOCA-bench's
central experimental idea without importing its stack.

The scorer uses exact typed equality. There is no LLM judge. A changed
apostrophe, missing “unless,” stale version, string `"0"` in place of integer
`0`, or unverified tool result fails.

Local verification:

```powershell
python experiments/context_compaction_track_b/benchmark.py selftest
python experiments/context_compaction_track_b/benchmark.py inspect
python -m unittest discover -s experiments/context_compaction_track_b -p "test_*.py"
```

All five tests pass.

## Real-call results

### Main paired smoke test

The OpenAI API arms used requested model `gpt-5.6`, which resolved to
`gpt-5.6-sol`, at low reasoning effort and structured JSON output. The Codex
arms used `codex-cli 0.145.0`, `gpt-5.6-terra`, low effort,
`--ephemeral`, and a read-only temporary directory. There was one repetition per
fixture.

| Arm | OpenAI exact assertions | OpenAI hard-pass sessions | Codex exact assertions | Average OpenAI final input tokens | Average OpenAI wall time |
|---|---:|---:|---:|---:|---:|
| Full history | 42/42 | 2/2 | 42/42 | 4,991.5 | 3.360 s |
| Structured capsule + tail | 42/42 | 2/2 | 42/42 | 1,418.5 | 3.481 s |
| Prose summary + tail | 4/42 | 0/2 | 4/42 | 1,158.5 | 6.873 s |
| Native OpenAI compaction | 42/42 | 2/2 | not exposed through this Codex arm | 3,476.5 | 10.767 s |

The structured capsule reduced final input by 71.6% versus full history in this
smoke test. That excludes the cost of generating and validating the capsule; the
current arm uses an oracle projection.

The native compacted final request reduced input by 30.4%, but each preceding
compaction call averaged 4,617.5 input tokens. The first compacted answer
therefore consumed an average 8,094 input tokens across both calls—62.2% more
than the direct full-history answer. Under the simplifying assumption that
future full and compacted request sizes remain constant, the input-token cost
breaks even on the fourth post-compaction response. Output cost, state growth,
cache hits, and latency can move that boundary.

API caching did not confound the comparison: reported cached input tokens were
zero in these calls.

Results:

- [OpenAI paired run](../experiments/context_compaction_track_b/results/openai-20260727T031117Z.json)
- [Codex paired run](../experiments/context_compaction_track_b/results/codex-20260727T031333Z.json)

### Controlled omissions

On the Canadian fixture, removing one exact capsule group caused exactly that
group to fail:

| Ablation | Exact score | Failed fields |
|---|---:|---|
| No instruction state | 18/21 | active ID/text and superseded IDs |
| No pinpoint state | 16/21 | locator kind/value, quote, qualifier, URL |
| No edit state | 19/21 | accepted and rejected edit IDs |
| No tool receipt state | 14/21 | all seven receipt/durability fields |

This does not prove the model could never infer an omitted value in another
session. It validates that the fixture and scorer isolate the intended fields
and that the recent tail does not leak them.

Result:
[OpenAI ablations](../experiments/context_compaction_track_b/results/openai-20260727T031145Z.json).

### Larger-context stress smoke

With eight controlled distractor packets per non-critical turn, the Canadian
full-history request measured 23,892 API input tokens.

| Arm | Exact score | Final input tokens | One-time compaction input | Wall time |
|---|---:|---:|---:|---:|
| Full history | 21/21 | 23,892 | — | 3.299 s |
| Structured capsule + tail | 21/21 | 3,687 | not measured | 2.953 s |
| Prose summary + tail | 2/21 | 3,425 | not measured | 4.842 s |
| Native OpenAI compaction | 21/21 | 13,329 | 23,518 | 215.158 s |

The native final window was 44.2% smaller, but the immediate two-call workflow
used 54.2% more input tokens than full history. On the same steady-state
assumption, it breaks even on the third post-compaction response. The observed
212-second compaction overhead is account, model, endpoint, and workload
specific; it is an n=1 measurement, not a general latency claim. It is enough to
show why “always compact” is not a strict win.

Results:

- [full versus native stress run](../experiments/context_compaction_track_b/results/openai-20260727T031829Z.json)
- [capsule versus prose stress run](../experiments/context_compaction_track_b/results/openai-20260727T031859Z.json)

### Disclosed pilot correction

The first two-call pilot scored both full and native arms 20/21 because the
fixture rendered an exact URL immediately followed by sentence punctuation.
Both models included the terminal period. The fixture was corrected to carry the
record as JSON before the complete run. The original result remains available
at
[openai-20260727T030939Z.json](../experiments/context_compaction_track_b/results/openai-20260727T030939Z.json).
This was a benchmark ambiguity, not a compaction difference.

## What the experiment does and does not establish

Observed in this run:

- native compaction preserved every tested field as well as full history;
- the exact capsule was sufficient downstream and much smaller;
- prose summarization discarded the precise state legal work requires;
- pinpoints, qualifiers, edit dispositions, and receipt status do not survive
  when omitted from durable state; and
- native compaction has an up-front cost that must be amortized.

Not established:

- population-level or model-family equivalence;
- performance after multiple compaction generations;
- automatic capsule extraction quality;
- session resume across model/version changes;
- adversarial prompt injection against a compactor;
- legal correctness beyond the synthetic closed record;
- performance at 96k–256k context; or
- production cost with prefix caching and real Beaver tools.

The native compact object is opaque. Passing this test means the downstream
answer was correct, not that every internal detail can be audited. That is why
Beaver still needs its own exact, inspectable state projection and immutable raw
log.

## Falsifiable full-study hypothesis

Primary hypothesis:

> Across at least 30 licensed legal fixtures, three independent repetitions,
> and controlled 8k, 32k, and 96k contexts, an exact structured capsule plus an
> eight-turn tail and native OpenAI compaction will each be non-inferior to full
> history by no more than one percentage point in paired exact-assertion
> accuracy, while producing zero silent errors in quote, qualifier, pinpoint,
> active-instruction, source-version, and tool-durability fields.

The zero-critical-error requirement is deliberately stricter than ordinary
average accuracy. A system that is 99% accurate but silently turns an exception
into a general rule is not acceptable for this purpose.

Secondary hypotheses:

1. A same-budget prose summary will fail at least one critical state group in at
   least 25% of sessions.
2. Removing a pinned instruction/supersession block will materially increase
   stale-instruction errors after compaction.
3. Removing exit code, truncation, and durable-artifact fields will materially
   increase false confirmation of partial tool output.
4. Native compaction's one-time input cost will amortize only after multiple
   subsequent turns; the break-even turn must be measured rather than assumed.
5. Repeated compaction generations will be worse than one generation unless
   exact application state is reattached on every turn.

Use a paired design: the same fixture, model snapshot/alias, effort, tools,
instructions, output schema, and request order seed for every arm. Cluster
confidence intervals by fixture, report both field accuracy and all-fields
hard-pass rate, and keep raw per-field failures. Semantic similarity may be
reported only as a secondary measure.

## Exact implementation sequence

1. **Resolve data rights.** Add an explicit license to Canadian Semantic
   LegalBench or obtain written permission; review the A2AJ/source-decision
   provenance. Respect CanLegalRAGBench's upstream-source caveats.
2. **Create adapters, not copies.** Read licensed external rows from a caller
   supplied path. Emit only fixture IDs, hashes, expected field annotations, and
   run results into this repository.
3. **Build 30–60 legal sessions.** Stratify paragraph/section/page pinpoints,
   exact continuation, limiting language, false premises, reversed holdings,
   mismatched authorities, and abstention.
4. **Add operational events.** For every legal content fixture, add at least one
   instruction supersession, source-version correction, edit reversal, partial
   receipt, successful durable receipt, and late update.
5. **Scale context without changing semantics.** Use the scaffold's controlled
   distractors at 8k/32k/96k. Add 256k only after cost and latency are acceptable.
6. **Run six arms.** Full history; oracle capsule; automatically generated
   capsule; prose summary; native standalone compaction; and Beaver's actual
   production session/compaction path.
7. **Add repeated compaction.** Test one, three, and five generations and
   cross-model resume.
8. **Grade deterministically.** Exact strings/types/hashes for state; normalized
   legal-specific graders only where surface variation is permitted. Never let
   a model judge decide whether a missing qualifier is harmless.
9. **Measure cost correctly.** Include the compaction/capsule-generation call,
   cache reads/writes, all continuation turns, tool-output tokens, and wall
   latency. Report the measured break-even continuation count.
10. **Gate deployment.** No critical silent failures; lower bound of the paired
    non-inferiority interval above -1 percentage point; no stale receipt marked
    complete; and raw transcript/artifact replay must reproduce every expected
    field.

## Recommendation for Beaver

Implement the current layered hypothesis, but call the pieces by their actual
roles:

- **Raw event log:** immutable audit and recovery source.
- **Exact legal state capsule:** deterministic, schema-versioned, and updated
  transactionally from events. It must include active/superseded instructions,
  document versions/hashes, quote plus qualifier, locator hierarchy and URL,
  accepted/rejected edits, and complete receipt/durability metadata.
- **Provider compact state:** opaque provider-owned continuation state, stored
  and replayed exactly as returned.
- **Narrative summary:** optional orientation only; never authoritative.
- **Recent tail:** bounded conversational continuity.
- **Cache key/prefix:** performance optimization only.

Compaction should be threshold- and continuation-aware. The smoke results support
using it when a session will continue long enough to amortize the extra call or
when the uncompressed window is approaching a model limit. They do not support
compacting every short session.

Finally, treat tool results like transactions. A receipt should distinguish
`observed` from `persisted`, carry exit status and truncation, and identify the
durable artifact/hash that proves completion. If that evidence is absent, the
capsule must say “unverified” rather than converting terminal prose into fact.
