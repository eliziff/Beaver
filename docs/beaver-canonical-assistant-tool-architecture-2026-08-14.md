# Beaver canonical assistant and tool architecture

Date: 2026-08-14

Status: implemented and verified

[`beaver-master-plan.md`](beaver-master-plan.md) remains the canonical project
status. This plan defines the assistant/tool refactor named there. It supersedes
earlier proposals for automatic tool-schema ranking, separate local and cloud
chat implementations, and a separately gated attested-characterization tool.

## Outcome

Beaver will have one chat engine, one tool registry, one resource plane, and one
provider-neutral event contract. Local and cloud deployments will differ only
at the persistence composition root. Assistant views, providers, and subagents
will select capabilities from the same registry instead of reimplementing chat.

The normal model-facing surface will be small and stable. Less common mature
operations will be loaded by exact name for the current turn. Legal-source
search may use FTS5/BM25 to rank source records; Beaver will not use BM25 or
another heuristic to guess which tool schemas the model should see.

This is a replacement, not a migration. Beaver has no users, so the refactor
will delete superseded paths and compatibility machinery.

## Implemented result

- Local and cloud assistant composition use one turn engine, executable
  registry, resource plane, event contract, and store interfaces.
- The ordinary Beaver surface is at most 12 schemas; exact-name loading admits
  at most three specialists, and external MCP tools remain directly visible.
- Note Up returns separately attributed judicial and journal lanes with exact
  evidence receipts and no cross-source-type score.
- Luna and Gemini live runs passed real DOCX read/edit, specialist execution,
  Note Up, interruption/retry, and native/host compaction-resume contracts.
- Backend and frontend release suites, production builds, and the standard
  local smoke matrix pass. Production source is 401 lines smaller across
  `backend/src` and `frontend/src` in the completed worktree.

## Fixed principles

1. One assistant turn engine owns provider execution, tool calls, steering,
   interruption, compaction, subagent events, and finalization.
2. One bound registry owns every tool's schema, availability, execution,
   effect class, and result projection.
3. One resource plane exposes Library files, generated artifacts, projects,
   workflows, jobs, and authoritative legal sources through durable references.
4. A feature flag removes an inapplicable capability from a view. It does not
   select another chat implementation.
5. Tool discovery is explicit. The model requests named specialist tools with
   `load_tools`; the host does not infer schemas from prompt similarity.
6. FTS5/BM25 remains appropriate inside bounded text/source corpora, where the
   ranked objects are documents or passages and a miss can be refined. It does
   not arbitrate runtime capabilities.
7. Tool results are typed data. Provider adapters translate protocol events;
   they do not parse display prose to recover state.
8. Local and cloud stores implement the same compiler-enforced ports and run
   the same conformance tests. No route or tool contains a local/cloud branch.
9. Mature document mutation, source structure, citations, receipts, and legal
   ingestion stay intact unless an output-fidelity test proves the replacement.
10. Experiments never enter the resident production schema until they earn a
    real caller and a promotion test.

## Target shape

```text
Assistant view + feature flags
             |
        assistantTurn
             |
      bound ToolRegistry -------- ProviderAdapter
       /       |       \                |
resource    source    document      canonical events
 tools       tools      tools
       \       |       /
         Runtime data ports
          /             \
   local SQLite       cloud/Supabase
```

The composition root constructs `createRuntime(dataPorts)` once, binds the
canonical registry to that runtime, and supplies the same assistant program to
every provider and view.

## Canonical registry

Each production tool is one entry:

```ts
type ToolEntry = {
  schema: ToolSchema;
  effects: readonly ToolEffect[];
  available: (capabilities: Capabilities) => boolean;
  execute: (args: unknown, context: ToolContext) => Promise<ToolOutcome>;
};
```

`ToolOutcome` carries structured content, resource references, evidence and
artifact receipts, and optional UI presentation metadata. There is no parallel
schema list, dispatcher switch, visibility allow-list, or display-prose parser
to keep synchronized by hand.

The registry derives:

- provider schemas;
- argument validation;
- runtime dispatch;
- view and subagent availability;
- user-visible tool status;
- evidence/resource projection; and
- schema-budget diagnostics.

An unregistered or unavailable tool call fails at the registry boundary. It is
never silently forwarded to an old dispatcher.

## Resident surface

The full ordinary-chat surface is at most these 12 tools:

| Tool | Purpose |
| --- | --- |
| `ask_inputs` | Request missing user decisions or files. |
| `Glob` | List matching resources in the current workspace. |
| `Grep` | Search text in addressable resources. |
| `Read` | Read a bounded range from an addressable resource. |
| `Edit` | Apply an exact, bounded document edit. |
| `generate_docx` | Create a complete Word work product. |
| `generate_excel` | Create a spreadsheet work product. |
| `generate_ppt` | Create a presentation work product. |
| `search_sources` | Search installed authoritative legal-source corpora. |
| `note_up` | Trace citation, judicial discussion, and journal analysis. |
| `submit_grounded_answer` | Finalize a source-grounded answer and receipts. |
| `load_tools` | Load named specialist schemas for this turn. |

Views use capability flags to subtract inapplicable entries from this same
registry. Tabular Review may enable grid-specific behavior and presentation,
for example, but it does not own another assistant or citation contract.

Initial hard budgets:

- no more than 12 resident schemas or 16,500 serialized schema bytes;
- no more than three specialist schemas loaded at once;
- no more than 15 Beaver schemas or 20,000 serialized schema bytes visible in
  one turn; and
- user-enabled MCP tools reported separately from the Beaver budget.

The measured pre-refactor local catalog is 38 schemas and approximately 38,635
serialized bytes. The implementation must replace that surface rather than add
another layer around it.

## Specialist tools

`load_tools` accepts exact registered names and returns their schemas for the
current turn. It is not a search endpoint and performs no ranking. The initial
specialist set is:

- `transform_docx`
- `link_docx_citations`
- `fix_docx_supras`
- `lint_docx_structure`
- `delete_and_renumber_docx`
- `compare_docx_versions`
- `verify_citations`
- `create_table_of_authorities`
- `update_library_metadata`
- tabular-only operations that cannot be expressed by `Read`, `Grep`, or
  `Edit`
- `delegate` and `resume_subagent` when delegation is enabled

The system prompt names available specialist tools and says when they matter.
The model may load them directly. Loaded tools expire at the turn boundary;
their receipts and resources do not.

Codex currently snapshots an MCP server's tools and does not refresh them after
the standard `tools/list_changed` notification. Its bridge therefore declares
the registered catalog once when the thread starts, while the same registry
still rejects every specialist until `load_tools` authorizes its exact name.
This transport accommodation performs no search or ranking. Providers that
support dynamic declarations receive only the resident and loaded schemas.

User-enabled MCP tools remain directly available through their native
registrations. Beaver does not re-rank, rename, wrap, or automatically select
them. Their count and schema bytes are measured so an excessive external
surface is visible, but they do not distort the Beaver surface budget.

## Resource plane

All addressable objects use stable typed references, including:

```text
document://<document-id>/version/<version-id>
source://<provider>/<source-id>
project://<project-id>
workflow://<workflow-id>
job://<job-id>
```

`Glob`, `Grep`, and `Read` operate on these references. Provider-specific
fetch/read/lookup tools collapse into the resource plane wherever their only
job is discovery or hydration. Provider adapters retain the legal work needed
to resolve native citations, paragraphs, pages, notes, and aliases; that logic
does not leak into generic chat orchestration.

Generated artifacts become ordinary versioned workspace resources immediately.
Projects and workflows are collections and state over those resources, not
parallel document implementations. Long-running jobs return durable job
references that `Read` can inspect.

## One local/cloud program

The shared data ports cover creation as well as reads and updates. At minimum:

```ts
type RuntimePorts = {
  documents: DocumentStore;
  chats: ChatStore;
  projects: ProjectStore;
  workflows: WorkflowStore;
  jobs: JobStore;
};
```

Local SQLite/AppData and cloud/Supabase implementations satisfy these ports.
Routes and tools call the ports only. The same parameterized store suite must
exercise IDs, ordering, pagination, creation, updates, deletion, version
conflicts, receipts, and schema-drift behavior against both implementations.
Docker is not required for this refactor; the cloud adapter is verified with
its contract double and static schema checks until cloud road-testing resumes.

## Note Up

### Research contract

`note_up` replaces both the existing note-up tool and the separately gated
`consult_attested_characterization` tool. Editorially attested passages remain
a core feature; they are presented under clearer source-role names.

The journal corpus is a rigorously reviewed legal-research collection. Its
editorial process checks cited pinpoints for fidelity to the underlying source.
Beaver must not characterize journal scholarship as presumptively inferior,
less reliable, or merely non-binding background. Source type identifies the
role a source plays in research; it is not a quality ranking.

The model-facing description is strictly operational:

> Trace how a Canadian decision is cited and discussed. Returns citing
> decisions, explanatory passages from later decisions, and relevant
> law-journal analysis with source citations and locators. Supports
> cited-paragraph and court filters. Does not assign treatment labels.

The general research prompt says:

> Do not discount journal sources because they are not primary law. They often
> contain more rigorous and fulsome statements of the law that can guide
> further research; most legal research guides therefore recommend beginning
> with secondary sources.

### Result contract

The tool returns separate, non-competing lanes:

```ts
type NoteUpResult = {
  target: CitationRef;
  citing_decisions: readonly CitationHit[];
  judicial_discussion: readonly AttestedPassage[];
  journal_analysis: readonly AttestedPassage[];
};
```

Each attested passage includes:

- the target authority;
- the actual containing decision or article citation;
- an exact passage;
- its paragraph or printed-page locator;
- source role (`judicial_discussion` or `journal_analysis`);
- evidence ID and source hash; and
- a `Read` reference for surrounding context.

Judicial passages may be ranked within the judicial lane by court, recency,
discussion density, and user filters. Journal passages may be ranked within the
journal lane by query relevance, citation specificity, and user filters.
Beaver never creates a cross-lane score that places one source type above the
other. Paragraph/court/date filters apply only where meaningful and never hide
the other lane accidentally.

The old `scc_journal_first` policy is deleted. The old receipt error that labels
journal analysis as `source_class: case` is corrected. A receipt cites the
containing article or decision, records the target authority separately, and
preserves the exact attested passage. Source ledgers accept both journal and
judicial roles.

## Subagents and providers

Subagent surfaces derive from the same registry by allowed effects. A read-only
research subagent receives read/search/note-up tools; an editing subagent also
receives mutation tools. There is no hand-maintained subagent tool-name list.

All providers consume the same assembled prompt, visible registry entries,
resource references, and canonical events. Adapters may use native continuation,
compaction, reasoning, or tool-call protocols, but they may not change Beaver's
capabilities or legal contracts. Provider-specific behavior belongs in the
adapter and its contract tests.

## Production removals and consolidations

The implementation should delete or absorb, rather than preserve:

- `backend/src/lib/chat/toolDiscovery.ts` and automatic prompt-to-tool BM25;
- duplicate schema construction in `localAssistantTools.ts`;
- the dispatcher switch in `tools/toolDispatcher.ts` once entries execute
  themselves;
- local/cloud branches in `localChatToolRunner.ts`, routes, and tool handlers;
- hand-maintained visibility and subagent allow-lists;
- prose parsing in `streaming.ts` where typed provider events exist;
- the separate `consult_attested_characterization` schema, environment gate,
  ranking policy, and duplicate execution path; and
- benchmark-only adapters from production. Benchmarks remain thin consumers of
  the production registry.

The target is fewer modules and net-negative production lines. New interface
code does not count as progress unless it deletes more duplicated behavior than
it adds.

## Experiments kept outside production

Keep the following in `experiments/` until independently promoted:

- semantic anchor and amendment-conflict machinery;
- deadline and term-drift detectors;
- drafting lint experiments;
- bilingual concordance experiments; and
- graph/visualization experiments.

Production and production tests must not import them. Note Up and its
editorially attested journal/case passages are production legal-research
capabilities, not part of this quarantine.

## Implementation sequence

1. Freeze behavior and schema measurements for the current local and cloud
   surfaces, including exact tool names, schema bytes, and representative tool
   receipts.
2. Introduce the executable registry entry and make current dispatch derive
   from it; do not add a second registry.
3. Bind one `assistantTurn` to the registry and route every provider, view, and
   subagent through it.
4. Complete common store creation/update ports and remove local/cloud branches
   from routes and tools.
5. Collapse discovery/hydration into the resource plane and make generated
   artifacts immediately addressable.
6. Add exact-name `load_tools`, move mature specialists behind it, and delete
   automatic BM25 schema selection.
7. Merge attested characterization into `note_up`, correct its receipts and
   lanes, and remove the old gate and ranking policy.
8. Delete superseded dispatch, visibility, prompt, benchmark, and adapter code;
   then run the full acceptance matrix.

Each step must leave one runtime path. Do not retain a legacy implementation
for comparison after its contract tests pass.

## Acceptance matrix

### Deterministic contracts

- Registry schemas, runtime dispatch, UI status, and subagent visibility all
  derive from the same entries.
- Unavailable and unregistered tool calls fail deterministically.
- Resident and maximum schema budgets pass from serialized provider payloads.
- `load_tools` loads exact names, respects capability flags, expires per turn,
  and never invokes a ranker.
- Local and cloud store implementations pass the same conformance suite.
- Resource references survive generation, editing, reload, and chat resume.
- Note Up returns both lanes without cross-lane ranking; every passage resolves
  to the containing source and surrounding text.
- Journal receipts identify journals as journals, cite the article, preserve
  the target authority separately, and enter the source ledger.

### Behavioral checks

- Existing DOCX generation, exact edits, tracked-change projection, citation
  linking, supras, structural lint, comparison, and renumbering retain their
  output contracts.
- Existing case, legislation, journal, Hansard, CourtListener, A2AJ, and local
  document retrieval retain their locators, quotes, receipts, and hashes.
- Tabular Review retains row/column citations and grid-specific operations
  through feature flags over the canonical assistant.
- Read-only subagents cannot mutate; editing subagents do not lose mature
  document operations.
- Benchmarks import production machinery through thin adapters only.

### Live provider checks

After deterministic tests pass, run at least three representative turns each
on Luna Low through Codex and Gemini Flash. Cover ordinary reading/editing,
specialist loading, legal-source research with Note Up, subagent completion,
steering/interruption, and compaction/resume. Compare visible tools, tool
receipts, event ordering, and final artifacts, not model wording.

### Release gates

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

The refactor ships only if production lines are net negative, test code is no
larger without protecting a durable contract, normal local startup remains
cloud-free, and no mature user-facing capability is lost.

## Adversarial failure checks

- **Specialist recall:** exact-name loading is acceptable only if the prompt
  names mature specialists clearly and live models load them when required.
- **Resource flattening:** generic `Read` must preserve provider-native
  paragraph, page, footnote, endnote, and citation coordinates.
- **Store parity:** create/update/version-conflict behavior must match, not just
  reads and pagination.
- **Note Up attribution:** an article's words must never be attributed to the
  target decision, and judicial discussion must never be presented as the
  target court's own statement.
- **Source-role bias:** prompts, schemas, ordering, and UI must not quietly
  demote journal research after the cross-lane score is removed.
- **Provider drift:** native provider conveniences must not create different
  Beaver tool capabilities or state transitions.
- **False compactness:** deleting a schema is not a win if its mature behavior
  becomes inaccessible, duplicated in prompts, or reimplemented by a view.

## Non-goals

- No semantic tool router, tool embeddings, automatic tool ranking, or
  provider-specific tool-selection policy.
- No new framework, service boundary, generic plugin system, or compatibility
  shim.
- No change to legal corpora or high-fidelity structure derivation as part of
  this refactor.
- No Docker/cloud deployment exercise in this phase.
- No claim that judicial sources are categorically more reliable than journal
  scholarship. Current-law verification is a task about legal effect and
  currency, not a quality judgment about scholarship.

## Design references

- [Pi coding-agent system prompt](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/system-prompt.ts): small resident filesystem/tool surface.
- [Oh My Pi](https://github.com/can1357/oh-my-pi): capability-rich runtime without prompt-similarity schema routing.
- [Codex search-tool description](https://github.com/openai/codex/blob/main/codex-rs/core/templates/search_tool/tool_description.md): explicit tool loading rather than silent semantic preselection.
- [Gemini function-calling guidance](https://ai.google.dev/gemini-api/docs/function-calling#best-practices): clear names, descriptions, and bounded parameters.
