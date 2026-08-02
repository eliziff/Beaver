# Hybrid retrieval v13: adversarial audit and preregistered thesis

Date: 2026-08-02

Status: design frozen before implementation and live calls. This document is
not a benchmark result and does not supersede the immutable run receipts.

## Decision

v13 will test the smallest conventional coding-agent architecture that fits
the product:

1. Keep one model trajectory and one explicit transcript from the original
   request through research, drafting, checking, and correction.
2. Start with a truthful file inventory and a small generic coding surface:
   `Glob`, `Grep`, bounded `Read`, model-selected `fetch_documents`, and compact
   tool discovery. Reveal authoring and specialist tools only when requested.
3. Let the model choose whole, targeted, or mixed reads. Permit complete-text
   batches only within one fixed, request-independent source budget derived
   from provider headroom. Ordinary reads remain bounded and return an exact
   continuation recipe.
4. Preserve exact source bytes, extracted text, versions, hashes, pinpoints,
   authored artifacts, and tool receipts on the host. Do not turn that durable
   store into a second model-facing evidence corpus.
5. Keep deterministic page addressing, exact evidence locators, mutation
   receipts, compiler checks, and evidence-before-mutation ordering. These are
   correctness properties, not a context architecture.
6. In the v13 path, disable fresh research/drafting contexts, checkpoint calls,
   hot packets, evidence unions/working sets, global already-read suppression,
   SLA orchestration, forced review agents, and task/domain routing.

This is deliberately an ablation, not a claim that every retired mechanism is
useless in every product workflow. A mechanism returns only after a measured
failure demonstrates the missing capability.

## What the runs actually say

The comparable three-task development set is Harvey LAB change-of-control,
transfer-pricing, and indenture. Scores below are the fixed Codex Sol judge
scores already stored with the runs; tokens are provider-reported totals from
the context manifests. The landed full-rehydration runs are diagnostic only.

| Cell | Score | Tokens | Baseline-token ratio | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Comparable upstream Mike | 150/217 | 1,436,478 | 1.00x | Quality target and simplest known comparator |
| Comparable coding finalist | 95/217 | 1,611,907 | 1.12x | Not actually a continuous pure-coding trajectory; it retained the context handoff |
| Checkpoint/paged v10 | 130/217 | 1,347,042 | 0.94x | Cheaper, materially worse |
| Checkpoint/paged v11 | 150/217 | 1,897,694 | 1.32x | Matched score only by paying substantially more |
| Checkpoint/paged v6 | 141/217 | 1,745,096 | 1.21x | Neither metric won |

Per-task receipts for the two central cells:

| Task | Upstream score / tokens | v11 score / tokens | v11 provider calls / rounds | v11 union paging |
| --- | ---: | ---: | ---: | ---: |
| Change of control | 38/57 / 406,836 | 48/57 / 1,102,787 | 8 / 17 | 31 calls, 574,133 characters |
| Transfer pricing | 42/77 / 559,453 | 34/77 / 324,730 | 8 / 12 | 0 calls |
| Indenture | 70/83 / 470,189 | 68/83 / 470,177 | 8 / 12 | 4 calls, 81,481 characters |

All three v11 runs report `reviewed_union_reuse_calls = 0`. The change-of-
control run made three checkpoint-model invocations; its last checkpoint prompt
was 524,838 characters to produce a bounded 12,000-character brief. The
checkpoint stack therefore added model cycles and duplicate evidence transport
without demonstrating reusable reviewed memory.

The older complete-coverage finalist is important but easy to misread. Across
nine visible tasks it scored 444/548 versus upstream's 432/548, at roughly
1.41x upstream tokens. That supports model-selected complete coverage as an
accuracy tool; it does not support a fresh drafting context or an evidence
union. Its three tasks corresponding to this v13 set used 43/57 and 597,286
tokens, 39/77 and 823,343 tokens, and 72/83 and 924,514 tokens. It is a useful
upper-bound diagnostic, not a token win.

The historical `v5` label is overloaded. The current `beaver-checkpoint-paged-
v5` receipts are unscored checkpoint/paged runs with 8--10 provider
invocations. They do have a distinct drafting handoff and are not evidence for
a winning single-session v5 architecture. Any earlier result called "v5" must
be identified by exact run path and fingerprint before comparison.

Authoritative local receipts live under:

- `benchmarks/harvey-labs/results/tool-surface-varied-luna-high-v1/upstream/`
- `benchmarks/harvey-labs/results/*/*/comparable-coding-finalist-default-codex-gpt-5-6-luna/`
- `benchmarks/harvey-labs/results/*/*/beaver-checkpoint-paged-v{6,10,11}-codex-gpt-5-6-luna/`
- `benchmarks/harvey-labs/results/coverage-finalist-v1/`

## Why the union hypothesis did not hold

The original hypothesis was sensible: expose each exact span once, retain the
union, and let later reasoning obtain full-document benefits without paying for
duplicate reads. It conflicts with the actual transport model in two ways.

First, in a continuous agent trajectory, every prior tool result is already in
the transcript. A separately rendered union repeats those bytes; it is not
memory. Second, after compaction, the useful operation is demand paging from
the durable source by an exact path/locator. Declaring a source "already
exposed" because it existed before compaction can suppress the very re-read the
model now needs. Codex and Pi preserve a compact trajectory summary and permit
ordinary reads again; neither maintains an accretive model-facing union of all
tool evidence.

The v11 telemetry confirms the predicted failure mode: no reviewed-union reuse,
but substantial paging and checkpoint costs. v13 therefore keeps the durable
exact source store and removes the union projection from the model path.

## Codex and Pi comparison

The relevant consensus is narrower than "summarize more":

- Codex keeps one normalized transcript, preserves tool-call/result pairing,
  truncates oversized tool results with a visible policy, and compacts only
  near the context limit. Its compaction path restores the canonical user
  context and current environment rather than opening a specialized drafting
  agent. It warns that repeated compaction can reduce accuracy.
- Pi begins with a stable four-tool coding surface. `read` is capped at 2,000
  lines or 50 KiB and gives an explicit offset continuation. Compaction keeps a
  recent tail, summarizes the older trajectory with exact file paths and
  errors, and cuts only at a valid message boundary.
- OpenAI's Responses guidance requires retaining reasoning and function items
  across turns. Provider compaction is intended near the context limit; prompt
  caching rewards a stable prefix.

Primary sources, pinned to the audited revisions:

- Codex [`compact.rs`](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/compact.rs), [`history.rs`](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/context_manager/history.rs), and [`tool_search.rs`](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/tools/handlers/tool_search.rs) at commit `2b5bdcf67547860f2e5c5a605009a70026796b2b` (Apache-2.0).
- Pi [`compaction.ts`](https://github.com/badlogic/pi-mono/blob/4c01c709380621c5ff2719162cd7a7973dcb2799/packages/coding-agent/src/core/compaction/compaction.ts), [`read.ts`](https://github.com/badlogic/pi-mono/blob/4c01c709380621c5ff2719162cd7a7973dcb2799/packages/coding-agent/src/core/tools/read.ts), [`truncate.ts`](https://github.com/badlogic/pi-mono/blob/4c01c709380621c5ff2719162cd7a7973dcb2799/packages/coding-agent/src/core/tools/truncate.ts), and [`tools/index.ts`](https://github.com/badlogic/pi-mono/blob/4c01c709380621c5ff2719162cd7a7973dcb2799/packages/coding-agent/src/core/tools/index.ts) at commit `4c01c709380621c5ff2719162cd7a7973dcb2799` (MIT).
- OpenAI [Compaction](https://developers.openai.com/api/docs/guides/compaction), [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state), [Reasoning](https://developers.openai.com/api/docs/guides/reasoning), and [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

The local Codex adapter already follows the core continuation rule: because the
subscription backend is non-persistent, each tool round resends the accumulated
input, the complete provider output items (including reasoning/function calls),
and tool results. The direct OpenAI adapter uses `previous_response_id` and
supports provider compaction. The Codex subscription endpoint rejects that
`context_management` field, so v13 does not add a bespoke checkpoint model to
imitate it. The live ablation instead reserves context headroom and should not
compact. Production can use provider-native compaction where supported; a
future client-side compaction ablation is justified only by an observed limit.

## Design-choice verdicts

| Choice | Verdict | Evidence and v13 treatment |
| --- | --- | --- |
| One continuous transcript | Keep | Matches Codex/Pi and avoids phase-reset loss. One outer provider invocation is a validity gate. |
| Original request retained | Keep | Canonical task context is immutable orientation, not a research-stage paraphrase. |
| Truthful file inventory and sizes | Keep | Lets the model choose coverage without request regexes or hidden domain labels. |
| Whole-document batch read | Keep, bounded | Upstream is efficient on small/few-document tasks; coverage finalist suggests accuracy value. Fixed 800,000-character cumulative budget reserves roughly 50k tokens under Luna's 258.4k effective window using a conservative four characters/token estimate. |
| Ordinary `Read`/`Grep` bounds | Keep | Pi-style 2,000-line and 50 KiB visible limits with deterministic continuation. |
| Generic coding vocabulary | Keep | Earlier grammar test: address schemas reduced initial schema/prose from 12,100 to 5,081 tokens. Progressive disclosure reduced an edit campaign from 79,425 to 56,149 tokens without a correctness-floor loss. |
| Compact tool discovery | Simplify | Keep one hop; do not add a hierarchy until routing failures prove a need. Specialist PDF/table/provider/case tools remain callable behind it. |
| Page-scoped Grep/Read | Keep | Fixes a general locator correctness bug and remains useful without a legal orchestrator. |
| Exact host evidence receipts | Keep | Durable bytes, versions, hashes, pinpoints, tables, provider receipts, and authored versions are audit state, not prompt state. |
| Evidence plus mutation in one batch | Keep guard | Execute evidence reads before mutation so same-batch edits cannot race source review. This is ordering, not a new agent stage. |
| Deterministic compiler/authoring receipts | Keep | The same trajectory can repair a concrete failure without a fresh reviewer. |
| Model-facing evidence union | Retire from v13 | It duplicates the transcript; v11 showed zero reviewed reuse. |
| Span/whole-read `already exposed` suppression | Retire from v13 | It is valid only while the bytes remain in active context. Host state cannot infer that across compaction. Repeated reads should return bytes. |
| Research checkpoint after every evidence batch | Retire from v13 | Adds an invocation and lossy rewrite to normal tool use; v11 CoC shows the cost directly. |
| Fresh drafting role/context | Retire from v13 | No general coding-agent analogue and no run evidence that the boundary earns its information loss. |
| 12k checkpoint plus 24k hot packet | Retire from v13 | Arbitrary lossy bottleneck layered over an exact source store. Keep only as a reproducible old arm. |
| Working-set virtual path | Retire from v13 | Generic source paths already support on-demand Grep/Read. Mounting a second concatenation adds addresses and copies. |
| SLA research/draft/check/reviewer chain | Isolate | Deterministic scanners remain useful; orchestration does not. H7 was expensive and mixed (for example transfer pricing 31/77 at about 2.15m tokens). |
| Forced fresh correction agent | Retire from v13 | Continue from the compiler receipt in the same transcript. |
| Legal/domain task router | Retire from v13 | No demonstrated advantage over model selection; risks benchmark leakage and brittle generalization. |
| Legal-specific prose/tool grammar | Simplify | Prior telemetry: none of 2,941 calls used `library_links`, graph following, or page addressing; all 61 `library_find.at` values were empty. Keep capabilities deferred, not resident instructions. |
| Provider/case/legislation/citator tools | Isolate behind discovery | Preserve exact evidence contracts and general callers; do not route tasks to them by benchmark identity. |
| Fixed mid-task compaction | Retire | Compact near the actual limit only. The v13 Codex arm is sized not to require compaction. |
| Cache-aware stable prefix | Keep and measure | Stable instructions/tool schemas help provider caching; schema variants and cache usage are telemetry. |

## SLA status

The SLA idea decomposes into two different things:

1. Deterministic checks and compiler receipts are valuable. They catch document
   structure or mutation failures and give the active agent concrete repair
   information.
2. The SLA multi-stage orchestration has not earned its cost. H7's live cells
   used roughly 470k--2.15m tokens per task without a reliable accuracy win;
   H4's evidence also indicates that synthesis, not retrieval availability, was
   often the limiting failure.

v13 therefore sets `MIKE_SLA_WORKFLOW=0` but retains ordinary creation/edit
receipts and deterministic checks invoked by those tools. This gets closer to
the older winning behavior: read enough source, draft directly, and fix only a
reported defect in the same trajectory.

## v13 frozen configuration

The arm will set these values explicitly and fail closed against ambient flags:

```text
MIKE_NAV_SHAPE=address
MIKE_TOOL_SHAPE=coding
MIKE_RETRIEVAL_EXPERIMENT=p0-pure-coding
MIKE_MODEL_COVERAGE_ROUTING=1
MIKE_WHOLE_READ_MAX_CHARS=800000
MIKE_TOOL_RESULT_CAP=51200
MIKE_TOOL_DESCRIPTION_VARIANT=terse
MIKE_SUPPRESS_DUPLICATE_WHOLE_READS=0
MIKE_CONTEXT_HANDOFF=0
MIKE_CONTINUOUS_EVIDENCE=0
MIKE_OPENAI_COMPACT_THRESHOLD=
MIKE_SLA_WORKFLOW=0
MIKE_GREENFIELD_REVIEW=0
```

The 800,000-character cap is the same for every task and applies to actual
complete-text transport, not a task classification. It is a deliberately
conservative source estimate: about 200k tokens at four characters/token,
leaving about 58k tokens under the provider-reported 258.4k effective Luna
window for instructions, schemas, reasoning, results, and drafting. `Read` and
`Grep` remain available after a selection response.

## Validity gates before scoring

A v13 run is invalid unless all of the following are true:

- exactly one outer provider invocation; multiple internal tool/context rounds
  are expected;
- no content reset, research refresh, research checkpoint, evidence handoff,
  evidence working-set receipt/update, SLA phase, or forced-review event;
- surface receipts show context handoff, continuous evidence, and duplicate
  whole-read suppression disabled;
- whole-read and ordinary-result caps equal 800,000 and 51,200 characters;
- every required DOCX exists and has a deterministic bytes/hash receipt;
- task instructions, source bundle, model, effort, service-tier request, system
  prompt, tool schemas, and code revision have exact fingerprints;
- trace inspection finds no hidden phase reset, task-specific routing, held-out
  data, or evidence result falsely suppressed as already read/exposed.

Only general structural defects found before scoring may be fixed. A fix creates
a new preregistration/fingerprint. Scores never choose the prompt or code.

## Success rule

The fixed three-task development comparison reports accuracy first, then
tokens/context, latency, coverage, cache behavior, rounds, and tool use.

- Strict v13 win: structurally valid aggregate score at least 150/217 and total
  tokens no more than 1,436,478, with no task more than five points below its
  upstream score.
- Quality-dominant candidate: at least 160/217, no catastrophic task regression,
  and no more than 1.5x upstream tokens. This is not a production win on three
  visible tasks; it only earns a wider, task-diverse validation.
- Otherwise: preserve the negative result and select the smallest observed
  missing capability for the next ablation. Do not restore the retired stack as
  a bundle.

The scoring configuration will be one fixed Codex Sol judge at below-normal
priority for all three structurally valid outputs. The comparator cells must
share the same task/source and judge semantics; Claude product cells and other
models remain separately labelled.
