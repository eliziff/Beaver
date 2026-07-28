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
per-criterion pass rates as the diagnostic.

Headline judge: `claude-code/claude-sonnet-4-6` — LAB's official judge
MODEL, reached through headless Claude Code (`claude -p`) on the Claude
subscription (flat rate, official surface; same legitimacy pattern as the
codex route). Differences from Harvey's API grading rig: no schema-enforced
output, no temperature pin.

Bulk/iteration judge: `codex/gpt-5.6-sol` (subscription route). Calibration
on the smoke runs (112 criterion verdicts, both arms): 110/112 agreement
(98.2%); both disagreements were borderline implicit-vs-express-statement
calls where codex was the STRICTER judge, on the Beaver arm — i.e. no
same-family leniency observed. Quote this calibration whenever codex-judge
numbers are reported.

## Task selection

Pilot: a deterministic stratified sample across practice areas and work types
(analyze / draft / review / research), small enough for subscription rate
limits. Smoke test first on
`trusts-estates-private-client/extract-client-intake-facts/scenario-01`.
Scale-up only after pilot results are reviewed.

## Deviations from official LAB (all forced by the no-API-spend constraint or platform)

1. Judge model is the official one (claude-sonnet-4-6) but via headless
   Claude Code, not the Anthropic API: no schema-enforced verdict JSON, no
   temperature pin. Agent model (gpt-5.6-sol via ChatGPT backend) is not a
   model Harvey published, so rows are still not leaderboard rows.
2. Agent-side temperature is stripped (codex backend rejects it); LAB
   defaults to 0.0.
3. Docker instead of podman for the sandbox.
4. LAB's LLM deliverable-filename matcher (Anthropic API, fires only when
   filenames don't match) now falls back to headless Claude Code with the
   same model (harvey-labs commit 7fd4f418). Discovered mid-pilot: keyless
   it errored to no-match and zeroed pilot-a-01 (95 criteria auto-failed,
   no judge calls) after Arm A shipped .md fallbacks named memo.md etc.
5. Pilot incident (task 01, pilot-a-01): the sandbox document-generation
   runtime (docker exec → python-docx) failed transiently mid-run; Arm A
   delivered Markdown instead of the four required .docx and burned ~10
   turns on shell diagnostics. The container passed the same operations
   when probed minutes later; smoke's Arm A ran the identical pattern
   successfully. Treated as our-infra fault (Docker adaptation), not a
   reference-harness deficiency: Arm A task 01 is rerun at the pilot tail
   (pilot-a-01r) and both scores reported.

## Fairness audit (pre-pilot, 2026-07-28)

Held constant across arms (verified, not assumed):
- Model and route: gpt-5.6-sol via the codex backend, both arms.
- Reasoning effort: explicit `medium` both arms (Arm A `--reasoning-effort`,
  Arm B `reasoning_effort` on /chat; the earlier Arm B smokes ran at backend
  default). Temperature: unsendable on this backend for both arms.
- Adapter semantics: live-probed — the backend emits no reasoning output
  items; both LAB's Python adapter and Beaver's openai.ts resend exactly the
  emitted output items plus function_call_output between turns. Multi-turn
  function calling verified working in both.
- Output-token basis: both arms report raw API `output_tokens` (inclusive of
  reasoning tokens); input tokens inclusive of cache reads in both.
- Information access: Arm A sandbox is --network=none; Arm B has Beaver's
  online research tools (CourtListener/A2AJ/public-legal) removed from the
  advertised tool list by the runner. Removal recorded per run in receipts.
- Output caps: `max_output_tokens` unsendable on this backend → uncapped in
  both arms (official LAB caps OpenAI runs at 128k; never binding in practice).
- Task inputs: identical bytes; non-uploadable types (.eml) reach Beaver
  wrapped as .docx with content unchanged, and reach Arm A raw.
- Grading: identical evaluator, judge model, prompts, pandoc extraction,
  strict filename matching (LLM matcher keyless) for both arms.

Harness-intrinsic differences (the thing being measured, not confounds):
tool inventories, system prompts, context assembly, loop budget (LAB: 200
turns; Beaver: product cap of 10 provider iterations per turn), Beaver
authoring deliverables via library_create_docx vs Arm A writing files.

Known residual imperfections (disclosed, judged immaterial):
- Beaver's local system prompt still mentions research capabilities whose
  tools are removed (function calling is constrained to advertised tools, so
  they cannot be invoked; mild self-handicap for Arm B if anything).
- Judge reached via headless CLI: no schema-enforced verdict JSON, no
  temperature pin (LAB itself drops the schema on final retry).
- Single run per task per arm → sampling noise; neither arm can pin
  temperature, so nondeterminism is symmetric.
- Arm A executes in a resource-limited container (2 CPU / 2 GB); Arm B runs
  in-process on the host. Affects file parsing speed only, not model calls;
  wall-clock comparisons favor neither arm materially.

## Results

Under `C:/Users/elias/Desktop/harvey-labs/results/` (LAB layout:
config.json / metrics.json / transcript.jsonl / output/ / scores.json).
