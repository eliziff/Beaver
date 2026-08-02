# Harvey LAB × Beaver: harness-comparison experiment

## Question

How much does Beaver's harness (document ingestion + context assembly +
prompting) contribute over a generic agentic file-workspace harness, holding
the model constant?

## Setup

- Benchmark: Harvey Legal Agent Benchmark (LAB), github.com/harveyai/harvey-labs,
  vendored at `benchmarks/harvey-labs` (dev+validation tiers only — see
  "Corpus split" and its PROVENANCE.md), branch `beaver/codex-route`
  (integration patches; upstream untouched).
- Model, both arms — held constant per pairing, so the harness is the only
  variable (corrected 2026-07-28; the design was always "measure the harness,
  not the model"):
  1. `claude-code/claude-sonnet-4-6` — Sonnet 4.6 over headless Claude Code
     (`claude -p`, subscription flat rate; adapter
     `harness/adapters/claude_code.py`). Transport-only: Anthropic message
     format, tool calls as JSON-in-text (no schema enforcement, retried),
     no temperature pin. Adaptive thinking is ACTIVE over this transport
     (probe-verified: thinking blocks on hard prompts) and effort passes
     through as `--effort`; experiment runs pin effort HIGH to match
     Harvey's published `claude-sonnet-4-6-high` config label. Effort
     provenance: the CLI default is `high` on effort-capable models
     (docs) AND this machine's ~/.claude/settings.json sets
     `effortLevel: high`, so runs made BEFORE the explicit pin
     (cc-harness-* rows, judge calls) also ran at high — all sonnet rows
     are tier-parity with Harvey's config. Known cap:
     the CLI limits output to 32,000 tokens per call — a whole-deliverable
     turn approaches it. Calls stream (`--include-partial-messages`) with
     a 240s inactivity watchdog instead of a total-time cap.
  2. `ollama/<qwen slug>` — the desktop PC's local Qwen over ollama
     (`harness/adapters/ollama.py`, native /api/chat tool calling,
     OLLAMA_BASE_URL / OLLAMA_NUM_CTX). The small-model pairing is the
     lean-context thesis test.
  The 2026-07-28 pilots ran both arms on `codex/gpt-5.6-sol` because it was
  the only wired flat-rate route at the time; those rows are pilot history.
  The INITIAL experiment pairing is sonnet-4-6 deliberately: it is the model
  Harvey's own rig uses, so our Arm A rows can be sanity-checked against
  Harvey's published reference-harness numbers (modulo the transport
  deviations below) before reading the Beaver delta. Other models —
  including codex/gpt-5.6-sol — can join later as additional pairings.
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
calls where codex was the STRICTER judge, on the Beaver arm. Initial experiment
rows are judged exclusively by the headline claude-code judge; the codex
bulk judge may return for later pairings (quote its calibration when
used). The sonnet-4-6 agent cells are therefore self-graded by model
family, which matches Harvey's own rig (their judge IS claude-sonnet-4-6).

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
   failures retried) and caps output at 32,000 tokens per call — both
   arms must use the SAME transport per pairing so these deviations
   cancel in the comparison. Thinking: adaptive thinking is active over
   claude -p and effort is pinned high (Harvey's own config label);
   thinking-token accounting rides inside output_tokens.
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

Under `benchmarks/harvey-labs/results/` (LAB layout:
config.json / metrics.json / transcript.jsonl / output/ / scores.json).

## Corpus split (2026-07-29)

Contamination control: the 1,207 LAB tasks are split dev/validation/sealed
(60/150/997) by seeded stratified draw (`split-corpus.py`, seed 20260729;
assignments and per-task SHA-256 manifests in `corpus-split.json`). The
tier unit is the task — sibling scenarios never straddle tiers. The 14
tasks exposed before the split (6 run + 8 read during the 2026-07-29
false-positive sweep) are forced into dev and marked `exposed` in the
manifest. Every practice area keeps a sealed majority (visible share
capped at 40%).

Rules of engagement:
- Dev: free to read, run, and debug against.
- Validation: run at milestones; inspect scores and our own outputs only —
  never task documents or rubrics.
- Sealed: NOT PRESENT on this machine. The corpus is vendored at
  `benchmarks/harvey-labs` with only dev and validation tasks; sealed
  task content lives solely in the upstream GitHub repo. At eval time:
  restore via git, verify each task dir against the manifest hash, run
  once against a pre-registered harness commit.
- Deterministic-grammar changes additionally validate on non-LAB corpora
  (A2AJ, Desktop/legal-generalization-corpus) before landing.

## Publishable three-way extension (planned 2026-08-02)

The engineering Luna runs are visible-development side runs. They can inform
the candidate but are not pooled with, or presented as, the canonical harness
comparison. A publishable claim uses one model and transport held constant
across all three arms:

1. LAB reference harness: the official six-tool file-workspace harness.
2. Pinned upstream Mike: commit
   `e89d3230db40193c540a6b38d8f301ae76377a1a`, schema SHA-256
   `78f2e1dfaa7f2c5a62dcc52531804373e998ee002fe783e7767a10113e7a87fc`.
3. Beaver candidate: one frozen commit and one pre-registered configuration.

### Pre-spend conformance gates

- Pin the LAB source. The existing split was made from upstream prerequisite
  commit `83f9b389ba51db3af00fdad07f744d48f3951b2e`; published LAB v1.0 resolves
  to `1da4750171bc5a534960b3d82d15ba7fd2cf653f`. Verify task hashes before
  choosing either label; do not silently mix corpus revisions.
- Use one neutral `claude -p` transport envelope, CLI version, account,
  model slug, and HIGH effort for all arms. The current LAB adapter is not a
  valid control yet: unlike Beaver, it does not disable Claude Code's native
  tools, settings, skills, MCP servers, and slash commands. Align those flags,
  retry semantics, and token accounting, then leave only each harness's own
  prompt, tools, state, and document handling different.
- Send identical task-instruction bytes and document bytes. Keep rubrics and
  task configuration inaccessible to performers, disable network research,
  and verify every input against `corpus-split.json`.
- Give every arm the same host backstop (200 provider iterations and three
  hours). Natural stopping and native prompt guidance remain part of the
  harness; a capped or context-overflowed run counts as a failed run, not an
  infrastructure rerun.
- Gate upstream Mike by exact prompt, tool names, schema order, and hashes on
  every run. For the primary retrieval claim, pre-register DOCX/Markdown
  deliverable tasks that its pinned surface actually supports. A broader
  artifact claim must add only upstream's own pinned Excel/PowerPoint tools,
  not Beaver substitutes.
- Run one unscored conformance smoke that asserts provider/model/effort,
  disabled ambient tools, source hashes, tool-schema hashes, token basis,
  output visibility, and evaluator inputs before touching validation or
  sealed tasks.

### Corpus and schedule

- Tune only on the 60-task dev tier. Validation remains milestone-only and
  blind to task documents and rubrics.
- Freeze the winning Beaver commit before final evaluation. Select a
  deterministic 120-task sealed sample, stratified without reading content by
  practice area, work type, source bytes, document count, and output type.
  Preserve the existing sibling-scenario grouping.
- Interleave arms within task using a pre-generated balanced order. Run one
  performer at a time for publishable latency; iteration runs may remain
  parallel. Rerun only a pre-defined infrastructure failure that produced no
  usable model output. A malformed call, bad retrieval choice, timeout after
  model work, or invalid deliverable is system performance and stays scored.
- Use one run per arm on all 120 sealed tasks, plus three repetitions on a
  preselected 30-task stability subset. Do not inspect any sealed output until
  all arms and repetitions have completed.

### Scoring and claims

- Blind arm identity before grading. Use the unchanged LAB rubric prompt and
  identical deliverable extraction for every arm.
- Primary judge: one fixed frontier judge over every criterion. Cross-family
  audit: a second frontier judge scores every criterion once; persistent
  disagreements are rerun twice per family and a stratified sample is reviewed
  by a lawyer. Automatic rubric labels are never called human gold.
- Headline metrics: task all-pass rate and macro mean per-task criterion pass
  rate. Report paired arm deltas with 95% task-clustered bootstrap intervals;
  criteria within a task are not independent observations.
- Pre-register source-size quartiles. Report the top quartile separately to
  test the actual doctrine: quality should rise or hold while unique source
  exposure, gross replay, provider input, cache-miss input, tool failures, and
  latency fall as matters grow.
- Accuracy is the gate. Beaver must beat pinned upstream Mike in macro
  criterion pass rate with a positive paired confidence interval and must not
  trail it in all-pass rate. Efficiency breaks ties only after that gate.
  Report LAB-reference results even if its pure coding tools win.
- Publish commits, patches, manifests, configuration, aggregate scores,
  confidence intervals, failure ledger, and metric definitions. Do not commit
  corpora, credentials, model traces, caches, or generated deliverables.

Harvey's private holdout numbers are a sanity check, not a replication target:
the task sample differs. The closer methodological comparators are their
120-task harness experiments, task-level bootstrap intervals, repeated
cross-family grading, and separate reporting of quality, cost, latency, and
agent behavior.
