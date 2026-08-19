# Beaver tool runtime v2: contraction plan

Date: 2026-08-17

Status: delivered on `main` (2026-08-18)

## Delivery record

The replacement is complete. The settled authored production trees contain
**109,001 nonblank lines** (`backend/src`: 75,600; `frontend/src`: 33,401),
down **9,189** from the 118,190-line contraction baseline. Experiments, tests,
generated files, and subrepositories are excluded from that measurement.

The delivered boundary uses canonical MCP-shaped definitions with direct
in-process Beaver execution and native MCP only where a provider process is an
MCP client. It has one `Write`, a small resident `Edit`, exact-loaded advanced
DOCX editing, and in-memory-by-default `compare_versions`. The old schema,
facade, receipt-reparse, provider-specific legal-source, chat-route, local
metadata, provider-completion, and secret-encryption duplicates were removed
instead of retained as compatibility paths.

Release verification on 2026-08-18:

- backend: 158 test files passed, 1,356 tests passed, 9 skipped;
- frontend: 86 test files passed, 387 tests passed, plus 3 build-guard tests;
- backend and frontend production builds passed;
- the required Beaver smoke suite passed backend, frontend, Library, model
  catalog, and Table of Authorities checks; and
- live `codex:gpt-5.6-luna` turns passed plain response, exact specialist
  loading, legal search plus `Read`, durable `Write` plus tracked `Edit`, and
  non-persisting `compare_versions`. The disposable live records were removed.

This delivery also executes
[`grounded-drafting-integrity-plan.md`](grounded-drafting.md).
The compact runtime is the host boundary for its narrow evidence receipts,
quote and unmarked-copy gates, host-only artifact details, and unified tool
activities. The two plans were delivered together and exceeded their combined
2,000-line contraction requirement.

This is Beaver's only current tool-runtime contract. The displaced registry,
parallel policy tables, and artifact-generation tools are not compatibility
surfaces.

## Outcome

Beaver will have:

- MCP-shaped canonical tool definitions and results;
- in-process execution for Beaver's built-in tools;
- actual MCP transport only at process/account boundaries;
- one compact executable definition per tool;
- one `Write` tool for DOCX, XLSX, and PPTX creation;
- one small resident `Edit` tool for exact DOCX text replacement;
- one exact-loaded advanced DOCX editor for deterministic structural and
  formatting operations;
- one `compare_versions` tool that is in-memory by default and persists a
  redline only when `save_redline: true` was requested by the user;
- ten resident Beaver schemas rather than twelve; and
- at least 2,000 fewer authored production lines.

The implementation is not complete if it adds a new layer around the existing
registry or leaves the old policy tables and dispatch path in place.

## What MCP does here

The concern that MCP is mainly for connectors is substantially right. MCP is a
JSON-RPC host/client/server protocol: hosts manage clients, and servers expose
focused tools, resources, and prompts. Connectors are a common deployment of
that architecture. The [MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)
does not require an application to send every internal function call through
an MCP server.

Beaver should use the installed `@modelcontextprotocol/sdk` in two different
ways:

| Boundary | Contract | Transport |
| --- | --- | --- |
| Built-in Beaver tools | MCP `Tool`, JSON Schema, and `CallToolResult` shapes | Direct in-process call; no JSON-RPC, client, or server |
| Registry validation | SDK `AjvJsonSchemaValidator` compiled once per input/output schema | In process |
| Codex app-server | The same canonical tool definitions | Real short-lived MCP server, because Codex is an MCP client |
| User MCP connectors | Native server definitions and results | Real MCP client transport |
| OpenAI, Claude, Gemini, DeepSeek, Ollama | Thin projections from the canonical MCP-shaped definition | Existing provider APIs |
| Claude Code print mode | The same canonical tool definitions | The same short-lived local MCP bridge as Codex |

This uses the useful standard without pretending Beaver's modular monolith is
a collection of remote MCP servers. It also removes the current lossy path in
which external MCP tools are converted to an OpenAI wrapper and later converted
back to MCP for Codex.

The [MCP tool schema](https://modelcontextprotocol.io/specification/2025-11-25/schema#tool)
already supplies the provider-neutral fields Beaver needs: `name`, `title`,
`description`, `inputSchema`, optional `outputSchema`, and annotations. Its
result contract supplies content blocks, `structuredContent`, and `isError`.
The official TypeScript SDK documents input validation, structured output, and
tool errors as ordinary model-visible results in its
[tool guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md).

MCP annotations remain hints. Beaver never uses an untrusted
`readOnlyHint` as authorization. Internal exposure and scheduling stay in the
executable definition.

## Why not another provider-neutral SDK

The [Vercel AI SDK](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
and Pi both provide provider-neutral tool loops. Either could be reasonable for
a new generic agent application. Neither is the small move for Beaver:

- Beaver already owns provider continuation, compaction, steering, Codex
  app-server, Claude CLI, local Ollama, evidence events, and durable sessions.
- Adopting another agent runtime would replace much more than the tool surface
  and temporarily duplicate the existing provider stack.
- Pi adds TypeBox, argument coercion, compatibility hooks, and coding-agent UI
  machinery Beaver does not need.
- Vercel AI SDK would add a framework and provider packages to obtain behavior
  the installed MCP SDK plus Beaver's current adapters already cover.

Decision: add no dependency. Use the installed MCP SDK v1.30.0 more fully.

## Compact executable contract

The only Beaver additions to MCP's `Tool` are runtime facts that the protocol
does not own:

```ts
type BeaverTool<Context> = Tool & {
  specialist?: true; // otherwise resident
  reader?: true;     // otherwise main turn only
  sequential?: boolean | ((input: Record<string, unknown>) => boolean);
  execute(
    input: Record<string, unknown>,
    context: Context,
    signal: AbortSignal,
    call: Readonly<NormalizedToolCall>, // transport identity for host events
  ): Promise<BeaverOutcome>;
};

type BeaverOutcome = {
  result: CallToolResult;
  events?: AssistantEvent[];
  evidence?: LegalEvidenceReceipt[];
  pause?: AskInputsEvent;
  mutated?: true;
  terminal?: true;
};
```

Defaults are resident, main-only, and parallel. There is no `effects[]`,
policy object, inheritance hierarchy, schema DSL, `prepareArguments`, or
generic operation bus.

The registry:

1. rejects empty, reserved, or duplicate names at construction;
2. compiles every input and declared output schema once with the SDK validator;
3. validates every call literally before domain code runs, without coercion;
4. loads specialists only by exact name, with the existing limit of three;
5. executes a batch in parallel unless any selected call is sequential;
6. returns results in assistant call order;
7. passes one `AbortSignal` to every executor;
8. converts thrown or malformed results to bounded, actionable tool errors;
9. validates `structuredContent` when `outputSchema` is present; and
10. treats annotations as descriptions, never as authorization.

The simple "one sequential call serializes the batch" rule is copied from Pi.
Dynamic `sequential` exists only for a real current need:
`compare_versions` is sequential when `save_redline` is true.

## Tool surface

### Resident tools

| Tool | Purpose |
| --- | --- |
| `ask_inputs` | Pause for a genuine user-only blocker. |
| `Glob` | List matching resources. |
| `Grep` | Search bounded resource text. |
| `Read` | Read bounded, addressable content and legal evidence. |
| `Edit` | Make exact version-pinned DOCX edits with tracked changes. |
| `Write` | Create DOCX, XLSX, or PPTX from Beaver semantic markup. |
| `search_sources` | Discover candidates in installed legal corpora. |
| `note_up` | Read later judicial discussion and journal analysis. |
| `submit_grounded_answer` | Finish a research answer from evidence IDs. |
| `load_tools` | Load up to three exact specialist names. |

`delegate_read` and `resume_read` are specialists. User-enabled MCP tools are
reported separately and remain directly available when the user enabled them.

### `Write`, not three generators

`generate_docx`, `generate_excel`, and `generate_ppt` are deleted, without
aliases. `Write` takes a filename and one semantic `content` string. The file
extension selects the existing deterministic renderer:

- `.docx`: Beaver Markdown already supported by `generate_docx`, including
  headings, lists, pipe tables, native footnotes, `{{field_id}}` content
  controls, `[@citation_id]` evidence bindings, and page breaks;
- `.xlsx`: `#` names the workbook, each `##` names a sheet, and a pipe table is
  the sheet body; and
- `.pptx`: `#` names the deck, each `##` starts a slide, bullets form slide
  content, and an explicit notes block supplies speaker notes.

DOCX-only options remain optional top-level fields and fail clearly when used
with another extension. The XLSX/PPTX markup parsers should be small adapters
into the existing `renderXlsxWorkbook` and `buildPptxPresentation` functions;
the renderers are not rewritten.

`Edit` remains separate, matching Pi and Oh My Pi's useful read/write/edit
division. Its resident schema covers the common exact-text replacement case.
The existing deterministic DOCX operation kernel is exposed once as an
exact-loaded specialist rather than recursively invoked through a hidden tool
name. Both definitions call the same low-level version-pinned commit path
directly. Neither claims XLSX or PPTX editing; support for another format is
added only with a real round-trip editor and fidelity tests.

### Comparison

Keep one comparison kernel and one tool:

```ts
compare_versions({
  document_id,
  old_version_id?,
  new_version_id?,
  save_redline?: boolean,
})
```

The default performs the comparison in memory and returns bounded structured
changes, abstentions, and the pinned version IDs. It creates no Library row,
bytes, event, or mutation receipt. `save_redline: true` materializes and saves
one Word redline and returns the canonical artifact receipt. The field
description says to set it only when the user requested a durable redline.

Because the tool can write, its static MCP annotation must not claim it is
read-only. Beaver's own `sequential(input)` and main-turn policy enforce the
conditional behavior. Do not split it into a second tool or add a generic
`mode` dispatcher.

## What to crib from Pi and Oh My Pi

Take:

- schema, execution, and concurrency co-located in one tool;
- exact resolution and validation before execution;
- `AbortSignal` at the executor boundary;
- parallel-by-default scheduling with source-ordered results;
- one normalization boundary for untrusted/third-party results;
- bounded read/search output with explicit truncation and continuation; and
- descriptions that teach selection, output grammar, and agent-fixable
  failures rather than restating schema fields.

Do not take:

- TypeBox or another schema authoring DSL;
- permissive argument coercion or compatibility hooks;
- BM25/semantic tool-schema routing;
- hashline editing or filesystem-specific addressing;
- their UI, plugin, memory, telemetry, approval, or subagent systems; or
- their provider runtime as a new Beaver dependency.

Beaver-specific augmentation stays narrow:

- research/read results carry exact evidence IDs, source/version hashes,
  native locators, and bounded continuation state; and
- `Write` understands Beaver's semantic artifact markup and grounded citation
  markers.

No legal doctrine, provider ranking, or document-rendering algorithm belongs in
the registry.

## Deletions

Delete in the same change that installs the replacement:

- the custom `OpenAIToolSchema` canonical type and every `type/function`
  authoring wrapper;
- `ToolEffect`, `effects[]`, `RESIDENT_TOOL_NAMES`, and effect-derived
  residency;
- `bindToolSchemas` and batch executors shared by unrelated tools;
- `MUTATIONS` and name-based mutation receipt parsing;
- `TURN_EDIT_TOOL_NAMES` and the second edit queue inside `assistantTools.ts`;
- the duplicate `ask_inputs` registration in `turnEngine.ts`;
- name-based event reconstruction when `BeaverOutcome.events` supplies the
  durable event directly;
- the Codex OpenAI-to-MCP schema conversion and silent duplicate suppression;
- Claude print mode's prompt-encoded `TOOL_CALLS` sentinel, JSON repair/salvage
  parser, replay protocol, and duplicate tool loop;
- `generate_docx`, `generate_excel`, and `generate_ppt`; and
- hand-authored `strict: true` fields in canonical schemas.

Provider adapters project cloned canonical schemas to their wire formats.
OpenAI strict mode is an adapter decision; it never changes the canonical MCP
schema.

## Measured size and estimate

Frozen measurements from the pre-refactor 2026-08-17 checkout:

| Baseline | Current |
| --- | ---: |
| Backend authored production | 202 files / 81,593 non-empty lines |
| `chat` + `llm` + `mcp` production area | 68 files / 27,261 lines |
| Ten core files most directly involved | 7,985 lines |
| `OpenAIToolSchema` references | 80 |
| OpenAI authoring-wrapper markers | 72 |
| Parallel residency/effect/mutation policy references | 31 |
| Three generation schemas | 3 tools / 5,347 serialized bytes |

The corrected pre-consolidation resident surface measured 12 schemas and about
15.7 KB. Replacing the three generation schemas with one `Write` schema should
produce 10 schemas and about 12.2-12.8 KB. The Codex static catalog should fall
from 23-24 schemas and 27.6-28.1 KB to 21-22 schemas and roughly 24-25 KB.

The earlier 400-600-line estimate is superseded. A schema-only migration is
not sufficient; the replacement must also collapse the duplicate batch,
mutation/event, provider-projection, and assistant dispatch layers that the
compact executable definition makes unnecessary.

Production-line budget:

| Change | Estimated net production lines |
| --- | ---: |
| MCP-shaped authoring and thinner provider projections | -60 to -90 |
| Registry replacement and policy-table deletion | -80 to -110 |
| Typed outcomes replacing mutation/event prose parsing | -100 to -130 |
| One `Write` schema/dispatcher, including two small markup adapters | -60 to -100 |
| Turn-engine duplicate ask/effect/batch plumbing | -40 to -70 |
| Codex bridge uses canonical tools directly | -20 to -35 |
| Delete the inner edit queue and batch-only assistant wrapper | -20 to -35 |
| Claude print mode uses the shared native MCP bridge | -800 to -930 |
| Delete recursive simple/advanced DOCX edit facades | -350 to -500 |
| Collapse redundant assistant/runtime dispatch and receipts | -1,500 or more |
| **Required net reduction** | **at least -2,000** |

Hard gate: at least 2,000 net authored production lines must disappear. Tests,
docs, generated files, blank-line churn, and formatting-only changes do not
count. Durable contract coverage may grow, but duplicated
implementation-presence tests should be deleted. If the implementation cannot
clear the hard gate, stop and redesign rather than waive it.

### Follow-on: whole-repo contraction

The later 5,000- and 10,000-line targets measure simplification of the same
product, not feature removal. Beaver's deterministic-analysis, working-set,
source-exposure, and virtual-TOC work is future product work: if it is not
production-ready, move it with its checks to `experiments/`, but report the
move separately and do not count it as architectural savings. Likewise
preserve the A2AJ passage lane, every legal-source provider, and the DOCX
comparison/editing fidelity kernels.

The next approved same-capability tranches are specified in
[`beaver-canonicalization-and-contraction-plan.md`](../roadmap/contraction.md):

- one host-agnostic legal-source core consumed by chat, DOCX citation linking,
  and Legal Library, deleting their repeated provider/resolver/result facades;
- one local application-metadata database for documents, chats, and projects,
  while Supabase remains the cloud persistence adapter; and
- later independent active-subsystem contractions selected from the measured
  whole-repo inventory, rather than forcing the tool runtime to supply an
  arbitrary global line target.

The legal-source contraction is gated on routing TNA, GovUK Employment
Tribunal, GovInfo, CourtListener, A2AJ, journals, and Hansard through the one
`search_sources -> Read` contract with exact citation/docket fixtures. It is
not acceptable to delete a facade until the unified path proves the provider
capability, canonical URL, source hash, locator, ambiguity behavior, and
evidence receipt in local and cloud compositions.

## Delivery sequence

1. Freeze current tool names, serialized schemas, composition counts, and
   behavior fixtures for main, resume, reader, local/cloud, and Codex-static
   surfaces. Record the production-line baseline with the counting rule above.
2. Change canonical schema authoring to MCP `Tool`, update provider projections,
   and make Codex/external MCP consume the same definitions. Delete the OpenAI
   wrapper type in the same step.
3. Replace the registry outright with the compact executable contract,
   SDK-compiled validation, exact loading, cancellation, and the simple
   scheduling rule. Delete effects, residency, mutation, and edit-name tables.
4. Convert the shared assistant dispatcher from batch input to one-call
   execution. Return typed outcomes and delete result/event reconstruction.
5. Replace the three generation tools with `Write`; add the XLSX/PPTX markup
   adapters over existing renderers and preserve the current DOCX renderer.
6. Make comparison in-memory by default with explicit durable opt-in. Run DOCX
   fidelity checks because the shared comparison kernel is touched.
7. Replace broad evidence receipts with model-visible child receipts, route
   chat/DOCX/activity citation rendering through one presenter, and enforce the
   deterministic marked-quote and unmarked-copy gates described in the
   grounded-drafting plan.
8. Keep artifact UUIDs, resource URIs, and URLs in typed host outcomes/events;
   expose only turn-local artifact handles to the model. Unify main/subagent
   tool activity updates on one typed contract.
9. Remove dead tests and add contract tests for duplicates, validation,
   provider projection, scheduling/order, loading, cancellation, result
   normalization, `Write` grammars, comparison persistence, and legal evidence
   receipts.
10. Recount production/test lines, schemas, and bytes; run the release checks.

Each numbered step lands one runtime path. Do not retain old names, aliases,
fallback dispatchers, or transition registries.

## Acceptance gates

- One advertised name maps to one executable definition.
- All input and declared output schemas compile with the installed SDK.
- Wrong scalar/container types fail before domain code and are not coerced.
- Every provider sees an equivalent canonical schema after transport-only
  normalization.
- Writes and interactions are absent from reader catalogs.
- Unloaded specialists cannot execute.
- Cancellation reaches every executor.
- Mixed sequential batches and all returned results preserve source order.
- `Write` creates faithful DOCX/XLSX/PPTX artifacts through existing renderers.
- `compare_versions` with default arguments leaves Library rows, bytes,
  events, and mutation state unchanged.
- `save_redline: true` creates exactly one canonical artifact outcome.
- Legal read/research outputs retain exact locators, evidence IDs, hashes, and
  bounded continuation.
- Resident and Codex-static counts/bytes are reported honestly.
- Authored production is at least 2,000 lines smaller.
- Account-free local mode and cloud/Supabase composition both pass.

Release checks:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

No metered provider run is authorized by this plan. Deterministic fixtures and
recorded provider contracts run first; live calls require separate approval.

## Non-goals

- No internal MCP microservices or JSON-RPC hop between Beaver modules.
- No Vercel AI SDK, Pi package, TypeBox, new validator, or agent framework.
- No compatibility aliases for removed generation tools.
- No universal XLSX/PPTX editing claim without real round-trip editors.
- No semantic tool router, opaque mega-dispatch tool, or provider-specific
  canonical schema.
- No legal-ingestion or corpus-structure refactor in this work.
