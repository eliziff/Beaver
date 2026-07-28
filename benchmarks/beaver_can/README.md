# Beaver-CAN

Canadian legal evaluation matters for Beaver
(docs/beaver-evaluation-context-plan.md §4–6). This directory currently holds
the Issue-2 three-task vertical slice:

| Task | Track | Tests |
|---|---|---|
| `tasks/dev/CAN-RESEARCH-001` | Closed-source research memorandum | reading, synthesis, citations, pinpoints |
| `tasks/dev/CAN-RETRIEVAL-001` | Retrieval with plausible distractors | authority discovery, ranking, proposition match |
| `tasks/dev/CAN-CONTEXT-001` | Scripted long-thread matter | changed facts, superseded instruction, document lineage, surviving quotation, seeded identifier |

Do not expand toward Beaver-CAN-12 until these three produce useful failure
information (plan §4).

## Layout

Each task directory contains:

- `task.json` — the task contract (plan §6): id, jurisdiction, law-as-of,
  task type, deliverable, source packet ids, fatal errors.
- `prompt.md` — the instructions played to the system under test. For
  `long_thread` tasks it scripts the turns as `## TURN-nn` headings.
- `sources/manifest.json` — the source packet. Committed A2AJ fixtures under
  `backend/src/lib/__tests__/fixtures/sourcedoc/` are referenced by
  repo-relative path plus content hash instead of being copied; task-authored
  matter documents live in `sources/` directly. The `role` field
  (authority/distractor/matter_document) and `superseded_by` are scoring
  metadata — never show them to the model.
- `gold.json` — propositions and acceptable evidence, not one ideal prose
  answer (plan §6). Never score legal prose by embedding similarity to a
  single model answer.

## Schemas

The single source of truth is `backend/src/lib/beaverCan.ts` (zod, strict:
unknown keys are rejected, cross-checks are parse-or-throw). The committed
`task.schema.json`, `gold.schema.json`, and `source_manifest.schema.json` are
generated from it via `beaverCanJsonSchemas()`; a test fails if they drift.

Validation goes beyond shape: manifest hashes must match the (LF-normalized)
source content, gold pinpoints must exist as compiled blocks of the cited
source (case paragraphs `42` → `par42`, statute sections `"231(5)"` →
`sec231(5)`), required quotations must occur verbatim at an acceptable
pinpoint, seeded identifiers must actually be planted in a packet source, and
every gold id must carry a human definition.

```powershell
npx vitest run src/lib/__tests__/beaverCan.test.ts   # from backend/
```

## Decisions where the plan is silent

- **JSON, not YAML** for `task`/`gold`/`manifest`: the tree has no YAML parser,
  AGENTS.md forbids new dependencies without a production caller, and
  `benchmarks/gold_contract` already uses a JSON contract.
- **Schemas and tests live in `backend/`** (zod + vitest), mirroring the
  Issue-1 run-trace contract in `backend/src/lib/runTrace.ts`, rather than a
  parallel Python harness.
- **Pinpoint values**: integers for case paragraph numbers (per the plan §6
  example), strings for statute section labels.
- **Gold extensions**: optional `required_quotations` (plan §4's
  quotation/pinpoint that must survive), optional `seeded_identifiers` (plan
  §2/§9 seeded sensitive fields), and a required `definitions` map so gold is
  human-reviewable without an external key.

## Hygiene

- `private_results/` is git-ignored: outputs, traces, and scores stay local
  (run traces go to `benchmarks/traces/`, also ignored).
- No downloaded corpus is committed; packets reference fixtures already in the
  repository or small task-authored documents.
- Hidden holdout tasks (Issue 6) must live outside the repository or under an
  ignored path supplied by an environment variable — never in `tasks/dev/`.
- Implementation changes and hidden-gold changes must never share a pull
  request.
