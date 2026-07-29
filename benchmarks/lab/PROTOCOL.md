# Harvey LAB × Beaver: harness-comparison experiment

## Question

How much does Beaver's harness (document ingestion + context assembly +
prompting) contribute over a generic agentic file-workspace harness, holding
the model constant?

## Setup

- Benchmark: Harvey Legal Agent Benchmark (LAB), github.com/harveyai/harvey-labs,
  local clone at `C:/Users/elias/Desktop/harvey-labs`, branch `beaver/codex-route`
  (integration patches committed there; upstream untouched).
- Model, both arms — held constant per pairing, so the harness is the only
  variable (corrected 2026-07-28; the design was always "measure the harness,
  not the model"):
  1. `claude-code/claude-sonnet-4-6` — Sonnet 4.6 over headless Claude Code
     (`claude -p`, subscription flat rate; adapter
     `harness/adapters/claude_code.py`). Transport-only: Anthropic message
     format, tool calls as JSON-in-text (no schema enforcement, retried),
     no temperature pin, no thinking control.
  2. `ollama/<qwen slug>` — the desktop PC's local Qwen over ollama
     (`harness/adapters/ollama.py`, native /api/chat tool calling,
     OLLAMA_BASE_URL / OLLAMA_NUM_CTX). The small-model pairing is the
     lean-context thesis test.
  The 2026-07-28 pilots ran both arms on `codex/gpt-5.6-sol` because it was
  the only wired flat-rate route at the time. Those rows are pilot history,
  not experiment rows — no codex in any experiment cell.
- Sandbox: LAB's container sandbox via Docker (`LAB_SANDBOX_ENGINE=docker`;
  podman not installed on this machine). Same image (`ghcr.io/harveyai/lab-sandbox`),
  same isolation flags.

## Arms

- **A — LAB reference harness**: LAB's own agent loop (six workspace tools:
  bash/read/write/edit/glob/grep, skills for docx/xlsx/pptx) driving the
  held-constant model. This is the "generic agent scaffold" baseline.
- **B — Beaver harness**: Beaver's production chat pipeline (its document
  extraction, context assembly, system prompt, tool loop) fed the same task
  instructions and documents, producing the same named deliverables.
  Export shim: Beaver's answer content is converted to the required deliverable
  format (e.g. pandoc markdown→docx); the judge reads deliverables as
  pandoc-extracted text, so formatting fidelity beyond text content is not
  scored for memo-type deliverables. Runner: `backend/scripts/lab-beaver-arm.ts`
  (Beaver repo), writing LAB-layout results so LAB's evaluator judges both
  arms identically.
- **Side observation — Claude Code product harness** (NOT an arm of the
  controlled comparison; it changes model AND harness at once): headless
  Claude Code as its own agent loop on the host, model `claude-sonnet-4-6`,
  tool inventory pinned to Arm A's six workspace tools (+TodoWrite);
  WebFetch/WebSearch disallowed; ANTHROPIC_API_KEY stripped (subscription
  auth). Runner: `backend/scripts/lab-claude-arm.ts`, LAB-layout results
  under `cc-harness-*` ids (B tasks only). Reads as "what a strong
  integrated agent product does on these tasks".

## Grading

LAB's own evaluator (`evaluation.run_eval`), all-pass rubric scoring,
per-criterion pass rates as the diagnostic.

Headline judge: `claude-code/claude-sonnet-4-6` — LAB's official judge
MODEL, reached through headless Claude Code (`claude -p`) on the Claude
subscription (flat rate, official surface; same legitimacy pattern as the
codex route). Differences from Harvey's API grading rig: no schema-enforced
output, no temperature pin.

Bulk/iteration judge (pilot era only): `codex/gpt-5.6-sol`. Calibration on
the smoke runs (112 criterion verdicts, both arms): 110/112 agreement
(98.2%); both disagreements were borderline implicit-vs-express-statement
calls where codex was the STRICTER judge, on the Beaver arm. Experiment
rows are judged exclusively by the headline claude-code judge — no codex
anywhere in the experiment. The sonnet-4-6 agent cells are therefore
self-graded by model family, which matches Harvey's own rig (their judge
IS claude-sonnet-4-6).

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
2. Agent-side temperature cannot be pinned on the pilot route (codex
   rejects it) nor on the claude-code transport; ollama accepts it and
   runs at LAB's 0.0 default. The claude-code transport additionally
   carries tool calls as JSON-in-text (no schema enforcement; parse
   failures retried) — both arms must use the SAME transport per pairing
   so the deviation cancels in the comparison.
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
   successfully. Ruled our-infra fault (Docker-on-Windows adaptation), not a
   reference-harness deficiency: pilot-a-01's 0/95 is VOID for arm
   comparison and recorded as an incident only. A clean rerun (pilot-a-01r)
   supplies Arm A's task-01 number if run; the pilot was paused after
   task 03 before the rerun.

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
