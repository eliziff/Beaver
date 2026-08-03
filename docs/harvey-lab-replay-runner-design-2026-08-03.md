# Harvey LAB replay-runner design — drafting-efficiency fork (O5)

Status: design note for the O5 drafting-efficiency sub-benchmark. Companion to
`backend/scripts/drafting-efficiency-replay.ts` (dry-run scaffold) and §O5 of
`docs/harvey-lab-deterministic-operationalization-2026-08-03.md`.

## Goal

A fair A/B for drafting-phase token cost: fork N drafting strategies from a
**byte-identical checkpoint at "just finished reading, about to draft"**, then
meter ONLY the drafting turns. Two axes:

1. **Drafting representation** — Beaver "markdown → deterministic .docx"
   (`generate_docx(markdown)` / `library_create_docx`) vs upstream-mike
   structured-direct `.docx` generation (`generate_docx(sections)`, the
   frozen Will Chen surface at commit `2266446b0d26f735865b8cd3bb153b28e7d11b17`).
2. **Ingestion representation** — `.docx`-as-markdown (the mounted paged
   evidence union at `.mike/working-sets/evidence.txt`) vs whole-document
   ingestion (`fetch_documents` / `read_document` whole reads).

## What the checkpoint machinery already does

`checkpoint_paged_v1` arms (`lab-beaver-arm.ts`, env
`MIKE_DRAFT_HANDOFF_MODE=paged`) already walk the checkpoint gate:

- Research runs in the first provider context; when the model has gathered
  evidence it is asked to write a compact `research_checkpoint` brief via the
  `checkpoint_research` tool (`researchCheckpointMaxChars`, default 12,000;
  `INITIAL_RESEARCH_CHECKPOINT_MAX_COUNT = 3`).
- When the brief is complete (`continue_research: false`) the host compiles a
  fresh drafting context with `compilePagedEvidenceHandoff`
  (`backend/src/lib/chat/evidenceExposure.ts`): ORIGINAL REQUEST + PINNED
  ORIENTATION (bounded Glob results) + RESEARCH CHECKPOINT + EVIDENCE MAP +
  HOT EXACT EVIDENCE + a mounted exact evidence union (`EvidenceVirtualWorkingSet`).
- The drafting phase then runs against that fresh context (`drainPendingEvidenceTransitions`
  in `backend/src/routes/chat.ts`); the host stamps every tool result with
  phase `"drafting"` once `draftingPhase` is true.

`metrics.json` already records `research_tool_calls` vs `drafting_tool_calls`,
`research_checkpoint_count`, `checkpoint_handoff_hash_mismatch_count`, and the
`context-manifest.jsonl` logs per-round `usage`. Tier 0
(`backend/scripts/drafting-efficiency-tier0.ts`) showed a drafting-phase token
slice is measurable from those artifacts for the single-invocation arms.

## The checkpoint gap

No current run is replayable from a byte-identical drafting checkpoint:

1. **The drafting-context prompt is not persisted.** The `evidence_handoff`
   SSE event and `beaver-receipts.json` store `initial_prompt_chars`,
   `checkpoint_sha256`, `working_set_sha256`, etc., but **not the prompt text**
   itself. The prompt is a pure function of host-side state
   (`compilePagedEvidenceHandoff`), so it is *reconstructible* — not *pinned*.
2. **The research brief is only recoverable from tool-call input.** The final
   reviewed brief text survives only as the `brief` argument of the last
   `checkpoint_research` tool call in `beaver-receipts.json`
   (`tool_calls[].input.brief`, the one with `continue_research: false`).
3. **The pinned orientation Glob content is truncated.** `beaver-receipts.json`
   stores `tool_results[].content_preview` (1,600 + trailing 400 chars), not the
   full Glob result, so the PINNED ORIENTATION block of the handoff is not
   byte-recoverable from current artifacts.
4. **The `draft_handoff_mode: none` arms emit no checkpoint at all.** The
   `upstream`, `lean_batch_v1`, `mike_grep_v1`, and coding `v13-v15` arms run a
   single continuous context with no research brief and no evidence union. Only
   a `checkpoint_paged_v1` source run can seed a replay fork.

## What a "finished reading, about to draft" checkpoint must contain

The byte-identical fork point is the **drafting-context user message** plus the
arm-specific system prompt/tools. The user message is arm-independent:

- `originalRequest` — task instructions (recoverable from `config.json` / LAB task).
- `researchBrief` — final reviewed checkpoint (recoverable from the last
  `checkpoint_research` call input).
- `orientation` — pinned research Glob results (NOT byte-recoverable today).
- `workingSet` — mounted exact evidence union text (`evidence-working-set.json`,
  fully persisted including `text`).
- `hotItems` — hot exact evidence (`evidence_handoff.hot_items`, persisted).
- `evidenceMap` — derived deterministically from the working set.
- `draftingContextPrompt` — the assembled user message (sha256-pinnable).

Independent variables (per strategy): system prompt, tool schemas, drafting
representation mechanics. These must be held constant *within* a fork across the
four cells except for the axis under test.

## Fork matrix

| cell | drafting representation | ingestion representation | drafting tools (model-facing) |
|---|---|---|---|
| beaver-markdown × docx-as-markdown | `generate_docx(markdown)` / `library_create_docx` | paged evidence union (working set) | Grep/Read on `.mike/working-sets/evidence.txt` + markdown authoring |
| beaver-markdown × whole-document | `generate_docx(markdown)` / `library_create_docx` | whole `fetch_documents`/`read_document` | upstream retrieval + markdown authoring |
| upstream-structured × docx-as-markdown | `generate_docx(sections)` | paged evidence union (working set) | Grep/Read on working set + structured authoring |
| upstream-structured × whole-document | `generate_docx(sections)` | whole `fetch_documents`/`read_document` | upstream retrieval + structured authoring |

All four fork from the SAME reconstructed drafting-context prompt. The only
differences are the system prompt, tool schema, and the `generate_docx`
argument shape the drafting agent is asked to produce.

## Runner design (`backend/scripts/drafting-efficiency-replay.ts`)

- **Dry-run first (this scaffold):** `--run-dir <checkpoint_paged_v1 run dir>`
  loads `beaver-receipts.json` + `evidence-working-set.json` + `config.json`,
  reconstructs the checkpoint, and prints a per-strategy report (system prompt /
  tool schema / user message fingerprints) with **zero model calls**. It
  verifies the drafting-context user message is byte-identical across the fork
  and reports reconstruction fidelity vs the recorded `initial_prompt_chars`.
- **Real mode (TODO):** per strategy, issue ONE fresh provider call
  (`streamChatWithTools` / codex route) with the fixed user message, run the
  strategy's tool executor (`runLocalAssistantTools` for Beaver markdown; a
  `generate_docx(sections)` renderer for upstream-structured), meter drafting
  tokens from `context-manifest.jsonl`, and write `replay-<strategy>.json`
  receipts beside the source run.
- **Harness change required (TODO):** `lab-beaver-arm.ts` should persist a
  `replay-checkpoint.json` at the `evidence_handoff` boundary containing the
  exact `draftingContextPrompt` text + sha256, the final research brief, the
  orientation content, hot items, and the working-set text. Until that lands,
  reconstruction is Tier-0 best-effort and the design note above lists the
  recoverability limits.

## Constraints honored

No new LAB runs; no LLM API calls in the scaffold; sealed tier off-machine;
fork user message byte-identical; drafting-phase-only metering; source run is a
real `checkpoint_paged_v1` run (e.g.
`tax/draft-transfer-pricing-documentation/beaver-checkpoint-paged-v10-codex-gpt-5-6-luna/2026-08-02T14-22-41Z-r1`).
