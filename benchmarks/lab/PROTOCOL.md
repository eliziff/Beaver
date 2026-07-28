# Harvey LAB × Beaver: harness-comparison experiment

## Question

How much does Beaver's harness (document ingestion + context assembly +
prompting) contribute over a generic agentic file-workspace harness, holding
the model constant?

## Setup

- Benchmark: Harvey Legal Agent Benchmark (LAB), github.com/harveyai/harvey-labs,
  local clone at `C:/Users/elias/Desktop/harvey-labs`, branch `beaver/codex-route`
  (integration patches committed there; upstream untouched).
- Model, both arms: `gpt-5.6-sol` via the ChatGPT-subscription Codex backend
  (`chatgpt.com/backend-api/codex`) — the repo's only sanctioned model route
  (no per-token API spend). Reasoning effort: medium. LAB's temperature knob is
  inoperative on this backend (parameter rejected; stripped by the adapter).
- Sandbox: LAB's container sandbox via Docker (`LAB_SANDBOX_ENGINE=docker`;
  podman not installed on this machine). Same image (`ghcr.io/harveyai/lab-sandbox`),
  same isolation flags.

## Arms

- **A — LAB reference harness**: LAB's own agent loop (six workspace tools:
  bash/read/write/edit/glob/grep, skills for docx/xlsx/pptx) driving
  `codex/gpt-5.6-sol`. This is the "generic agent scaffold" baseline.
- **B — Beaver harness**: Beaver's production chat pipeline (its document
  extraction, context assembly, system prompt, tool loop) fed the same task
  instructions and documents, producing the same named deliverables.
  Export shim: Beaver's answer content is converted to the required deliverable
  format (e.g. pandoc markdown→docx); the judge reads deliverables as
  pandoc-extracted text, so formatting fidelity beyond text content is not
  scored for memo-type deliverables. Runner: `backend/scripts/lab-run.ts`
  (Beaver repo), writing LAB-layout results so LAB's evaluator judges both
  arms identically.

## Grading

LAB's own evaluator (`evaluation.run_eval`), all-pass rubric scoring,
per-criterion pass rates as the diagnostic. Judge: `codex/gpt-5.6-sol`
(same subscription route; LAB's official judge is claude-sonnet-4-6, which
is API spend — see deviations). Same judge for both arms, so the A/B
comparison is internally consistent even though absolute scores are not
comparable to Harvey's published numbers.

## Task selection

Pilot: a deterministic stratified sample across practice areas and work types
(analyze / draft / review / research), small enough for subscription rate
limits. Smoke test first on
`trusts-estates-private-client/extract-client-intake-facts/scenario-01`.
Scale-up only after pilot results are reviewed.

## Deviations from official LAB (all forced by the no-API-spend constraint or platform)

1. Judge is codex/gpt-5.6-sol, not claude-sonnet-4-6 → absolute scores not
   leaderboard-comparable; A/B deltas are the deliverable.
2. Judging the model's own family invites self-preference bias — identical in
   both arms, so it cancels in the comparison but inflates absolute numbers.
3. Temperature is stripped (backend rejects it); LAB defaults to 0.0.
4. Docker instead of podman for the sandbox.
5. LAB's LLM deliverable-filename matcher (Anthropic API, fires only when
   filenames don't match) is left keyless → degrades to no-match; both arms
   must name deliverables exactly as task.json specifies.

## Results

Under `C:/Users/elias/Desktop/harvey-labs/results/` (LAB layout:
config.json / metrics.json / transcript.jsonl / output/ / scores.json).
