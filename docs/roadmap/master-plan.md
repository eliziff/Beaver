# Beaver master plan

Status: canonical implementation plan
Last reconciled: 2026-08-20

This is the single source of truth for unfinished Beaver work. Earlier
planning files remain as design records and technical appendices; their status
lists are not authoritative where they differ from this file.

The plan consolidates the user's requests without turning every experiment into
a permanent subsystem. The default is a small deterministic implementation,
measured against the current Beaver baseline, with model calls reserved for
ambiguity that cannot be resolved reliably in code.

## Status key

- **Done**: implemented and verified in the current worktree.
- **Active**: the current execution focus; work proceeds under a dedicated
  implementation plan and harness goal.
- **Partial**: a useful implementation exists, but the requested end-to-end
  behavior or validation is incomplete.
- **Research**: investigated and documented; runtime behavior is unchanged.
- **Blocked**: implementation exists but an external credential, license, or
  dataset is unavailable.
- **Planned**: not implemented.

## Fixed architecture decisions

These decisions are not open backlog items:

1. Beaver supports account-free local mode and optional cloud/Supabase with
   private S3-compatible object storage. They are two persistence compositions of one application, not
   two behavior paths to maintain independently.
2. Provider downloads, bulk databases, and shared source caches live under the
   versioned `OpenLegalData` contract, normally
   `%LOCALAPPDATA%\OpenLegalProducts\LegalData`.
3. SQLite is the lookup/runtime format. DuckDB, PyArrow, and Parquet readers
   are optional import-time dependencies.
4. ALR Quote Verifier remains an independent product. Beaver does not import its
   private modules or require its checkout. Small algorithms and fixtures may
   be ported into neutral packages with parity tests.
5. `legal-pdf-parser` is the neutral PDF structure package. Beaver,
   Authorities Helper, ALR, and future applications consume thin
   adapters.
6. Exact evidence, document versions, source locators, hashes, and tool
   receipts are durable state. A prose session summary is disposable context
   and is never legal authority.
7. Exact lexical/pinpoint lookup hydrates authoritative source text. Dense
   vectors are an optional candidate-generation layer, not a source of truth.
8. Model choice and reasoning effort are capability-driven and dynamically
   enumerated where a provider exposes a catalog. Values such as `max` are not
   hardcoded away.
9. The browser UI is the sole maintained Table of Authorities UI used both
   standalone and inside Beaver. The retired Tk UI is not a compatibility
   surface and must not be recreated.
10. Legal ontology artifacts use renderer-independent JSON. A viewer is a
    replaceable projection, not the data model.
11. Accessibility is a cross-cutting product constraint. New and changed
    browser workflows target WCAG 2.2 Level AA and use native HTML before
    custom ARIA widgets.
12. Beaver remains a modular monolith with small provider/process boundaries.
    Extensibility comes from stable SQLite/JSON/CLI contracts and thin adapters,
    not speculative services, duplicate UIs, or one-implementation interfaces.
13. Local/cloud selection occurs once at the composition root. One
    `createRuntime(dataPorts)` factory owns the domain program; the local and
    cloud data-port constructors satisfy one compiler-enforced persistence
    contract. Routes, tools, DTOs, events, pagination semantics, and the
    automatically parameterized conformance suite are shared.
14. `DocumentStructure` is the one canonical semantic result for an immutable
    document version. `SourceDoc` is its optional linear legal-text projection;
    typed grids, raw-preserving DOCX sessions, and neutral PDF artifacts remain
    authoritative format objects rather than duplicate semantic models. Beaver
    does not replace source bytes with a universal lossy AST.
15. Every assistant view and provider uses one turn engine, executable tool
    registry, resource plane, and event contract. Specialist tools load by
    exact name; Beaver never ranks tool schemas from prompt similarity.
16. The browser product is one statically built Vite/React Router application
    served from the Express application origin. Local and cloud deployment may
    place identical immutable assets behind different caches, but application
    code has no Next/OpenNext runtime, server-component split, API-base branch,
    or normal-operation CORS topology.
17. Before Beaver's first supported persistent-data release, migration effort
    is not an architectural constraint. A replacement updates every caller,
    adapter, schema, fixture, and deployment surface and deletes the displaced
    implementation in the same vertical slice. Production retains no legacy
    alias, fallback, compatibility DTO, dual read/write, migration framework,
    or transition flag; Git is the rollback mechanism.
18. The deterministic structure/citation core ships as one coherent capability;
    provider-native adaptation and text-only detection are not separate engines.
    Legal PDF Parser artifacts may still select heavyweight PDF, language, OCR,
    or layout capabilities. Protocol handshakes fail closed when a required
    capability is absent, and no artifact carries an unselected model/runtime.

## Canonical legal-document stack

Status: **Active exact Rust port and contraction**

The governing design and execution gates are in
[Shared document structure](document-structure.md). In short: light source
adapters preserve provider-native facts, one Rust analysis pipeline owns every
shared detector, `DocumentStructure` is the canonical result, SourceDoc is an
optional projection, and Beaver invokes the pipeline once per immutable
document version through one typed structure host. The existing
`documentProjectionService` remains the byte/file ingress for uploaded
documents; provider adapters call the same host after their own fetch/render
step rather than being forced through that file-oriented service.

Neither the present provider silos nor Beaver's present consumer requests are
compatibility constraints. Preserve useful behavior and detector quality, then
replace the old calls, DTOs, duplicate representations, and granular native
exports outright. Git retains the superseded plans and implementations.

## Implemented baseline

The following work is complete enough to build upon and is not repeated as
backlog:

| Area | Current baseline |
| --- | --- |
| Local identity | Anonymous account-free startup, durable Library/chat state, matters/projects, project documents/chats, and tabular reviews under shared AppData |
| Assistant | One store-backed turn engine and executable registry serve local/cloud chat, resources, exact document work, evidence, Note Up, and read subagents; mature specialists load by exact name |
| Codex | Persistent app-server threads provide native steering, interruption, compaction, subagents, model/effort control, and a Beaver MCP bridge with unrelated Codex tools disabled |
| Providers | OpenAI, Claude, Gemini, Codex, DeepSeek, and OpenRouter share one provider-neutral turn/event contract |
| Legal lookup | A2AJ, CourtListener, TNA Find Case Law, GOV.UK ET, GovInfo, and journal article lookup surfaces; CourtListener consumes native paragraph/note structure where supplied |
| Pinpoints | Deterministic native anchors/text fragments, including multi-text directives, are appended without asking the model to construct URLs |
| Shared data | `OpenLegalData` SQLite/bulk contract and AppData layout; A2AJ and CourtListener bulk paths |
| Growing collections | Bounded cursor pages, server-side filters, exact-ID reads, local SQLite/FTS, shared frontend paging hooks, and the same local/cloud wire shapes |
| Journal data | `public_endpoint.db` page/structure access and a contentless FTS5 sidecar |
| PDF core | Standalone deterministic digital-born parser plus Beaver on-demand ingestion, content-addressed artifacts, exact page/paragraph/footnote/section lookup, cache, diagnostics, and provider adapters |
| Source structure | Public `SourceDoc` behavior and the frozen provider/PDF parity fixtures exist; the current TypeScript-to-Rust bridge is transitional and is deleted by the canonical-stack cutover above |
| DOCX citations | Bounded deterministic citation splitting and hyperlink insertion with a Codex worker only for unresolved splits |
| Legal Library | Lightweight A2AJ/journal pointers and a structured source viewer |
| Table of Authorities | Shared data path, dependency bootstrap, browser UI, standalone host, and a Beaver sibling route |
| Cloud continuity | Audit history, fresh-schema alignment, and explicit schema-drift protection remain available while local mode stays cloud-free |
| Runtime shape | Lazy route imports, bounded structure caches, turn-scoped DOCX reuse, shared local/cloud Library and document/version route contracts, and legal-evidence experiment code outside production |
| UI | Beaver name, maple leaf identity, red accents, flat text-presentation symbols, visible model control, and separate effort control |

The governed source baseline remains commit `02aff487` (247 files, 5,837
insertions, 61,730 deletions). The contraction harness, behavior inventory,
and deferred Office rendition fix have since landed. The current full backend
suite passes 1,341 tests with eight intentional skips at normal parallelism;
the former three SQLite/DOCX timeouts are gone without raising a timeout.
Generated local probes/corpora remain intentionally uncommitted, the nested
PDF-engine worktree remains dirty. The backend/frontend tests and builds and
the local backend/frontend/Library/model-catalog/Table-of-Authorities smoke
matrix pass; real local-Supabase road-testing remains deferred.

## Priority 0 — correctness, reliability, and measured performance

### P0.0 Canonicalize and contract the application

Status: **Active**

Execute the
[canonicalization and contraction plan](contraction.md)
from checkpoint `02aff487`.

The governing design is one `createRuntime(dataPorts)` domain factory, selected
once at composition. Local SQLite/files and cloud Supabase/S3 constructors
satisfy one compiler-enforced persistence contract and feed the same domain
program. All routes, tools, assistant surfaces, DTOs, events, pagination rules,
document projections, and behavior tests are shared. Ordinary feature work
must not require remembering or reimplementing a second mode.

The refactor replaces parallel assistant/tool, route/persistence,
document/SourceDoc, DOCX, provider/evidence/cache, and frontend event/resource
paths. It proceeds in net-negative vertical slices: a replacement, all callers,
its behavior contract, and deletion of the superseded path land together. Git
is the rollback mechanism; Beaver gets no legacy runtime shims.

Measured baseline and target:

| Metric | Current Beaver | Current upstream Mike | Beaver target |
| --- | ---: | ---: | ---: |
| Backend production lines | 84,053 | 39,748 | no independent quota; remove backend duplication first |
| Frontend production lines | 34,137 | 51,951 | remain compact while sharing event/resource paths |
| Combined production lines | 118,190 | 91,699 | 70,000 or fewer |
| Production + test lines | 190,274 | not frozen | lower than 190,274 without weakening behavior coverage |

Acceptance is the plan's full definition of done. In particular: one
assistant runner and tool registry, one local metadata database and immutable
blob store, canonical document projections, raw-preserving DOCX mutation,
automatically enumerated SQLite/Supabase contracts, no affected-path
performance regression, and all repository release checks passing.

### P0.1 Reliable local lifecycle

Status: **Partial**

Build one small Windows launcher/doctor path that:

- starts the backend, frontend, and optional Table of Authorities service from
  known production builds;
- refuses duplicate listeners and reports exact owning PIDs;
- pins the selected Codex executable without corrupting `PATH`;
- waits for health endpoints, prints actionable failures, and can stop only the
  processes it started;
- checks required runtime versions and optional provider credentials without
  exposing secret values; and
- opens Beaver only after the frontend is ready.

Acceptance:

- Five cold start/stop cycles leave no orphan watcher or duplicate listener.
- A missing build, occupied port, missing optional key, and failed backend each
  produce a specific diagnosis.
- `http://127.0.0.1:3000`, backend health, Library upload, model selection,
  effort selection, first assistant message, and the integrated Authorities workflow
  pass one automated smoke flow.

### P0.2 Frontend responsiveness and build time

Status: **Partial**

The user reported excruciating loading and long builds. Existing cache,
single-flight, streaming, and lazy-start improvements are useful but have not
established a reproducible win.

Work:

- Record cold/warm navigation, first contentful UI, assistant-ready, first
  token, Library listing, model catalog, and legal-source-open timings.
- Profile the production build and client bundles before deleting code.
- Remove dead assets, duplicate dependencies, unreachable routes, redundant
  adapters, and accidental server/client boundary crossings only where the
  profile shows a win.
- Keep useful warmup. Do not trade lower build time for slower first legal
  lookup or first assistant response.
- Split rarely used heavy surfaces at route boundaries, including graph,
  tabular, workflow, and legacy/cloud-only UI where safe.
- Add a fast verification lane for backend-only and static-public changes; keep
  the full production build as a release gate.
- Run a width-criminal audit across every route, modal, panel, toolbar, growing
  collection, and embedded service. Reading/forms/chat/settings/setup stay at a
  human-scale maximum width; long catalogs use bounded searchable lists; no
  ordinary surface grows to its contents or the available viewport.
- Exercise desktop, narrow viewport, 200% zoom, and 320 CSS pixels. Fail on
  shell horizontal overflow, clipped controls, upward-opening full-screen
  dropdowns, or a bounding-box change caused by hover, focus, selection,
  loading, or moving between modal steps.

Acceptance:

- Publish before/after medians from the same machine and exact build command.
- No regression in first model response, Library open, legal source lookup, or
  warmed Table of Authorities open.
- Remove code/dependencies only when tests and bundle/runtime measurements show
  a strict win.
- Keep screenshots and measured element rectangles for representative wide,
  narrow, and stepped states. A visual assertion from source code alone does
  not pass the width audit.

Recorded strict wins on the same Windows/i3-1315U machine:

| Change | Reproducible method | Before | After |
| --- | --- | ---: | ---: |
| Publish compact PDF pages directly | 24-page/150-footnote Library PDF; seven alternating fresh Python processes; cache disabled | 1.4219 s cold median; 2,856,039 transient B | 1.2182 s (`-14.3%`); 401,103 B (`-86.0%`); structural/evidence artifacts byte-identical |
| Skip impossible reporter-regex compilation | Same PDF; seven alternating cold compact parses against engine `80848aa`; cache disabled | 1.3513 s median | 1.2472 s (`-7.7%`); structural/evidence artifacts byte-identical |
| Add geometry after a compact parse | Same PDF; seven alternating cold processes; full reparse versus verified compressed page sidecar | 1.7850 s; 2,856,038 added B | 1.7284 s (`-3.2%`); 535,790 added B (`-81.2%`); loaded pages exact |
| Defer cloud-storage SDK in local startup | `npm run build --prefix backend`; seven alternating fresh-Node imports of `dist/app.js`, median | 2,193.0 ms; 958 modules; 88.9 MiB RSS delta | 1,768.6 ms; 833 modules; 77.2 MiB (`-19.4%`, `-13.0%`, `-13.2%`) |
| Stop global logo from prefetching Assistant on Library | `npm run build --prefix frontend`; production Next server; cache-disabled Chromium; 6× CPU; three-run median | 1,667,888 decoded JS bytes; 1,928 ms FCP; 1,608 ms long tasks | 903,634 bytes; 1,400 ms; 1,271 ms |
| Same prefetch removal on Authorities | Same frontend method | 1,486,012 decoded JS bytes; 1,476 ms FCP; 1,978 ms long tasks | 721,758 bytes; 996 ms; 905 ms |
| Defer cloud-only MFA SDK and remove duplicate Tabular UI | `npm run build --prefix frontend`; `.next` route-manifest decoded JS + CSS | Projects 1,146,769 B; Authorities 1,089,077 B; Tabular detail 1,474,644 B | 934,566 B (`-18.5%`); 876,473 B (`-19.5%`); 1,256,484 B (`-14.8%`) |
| Share MCP/MFA fields and remove dead frontend API declarations | `npm run build --prefix frontend`; all `.next` chunks; full Vitest | 7,870,663 JS B; 135,316 CSS B | 7,864,904 JS B (`-5,759`); 135,251 CSS B (`-65`); primary-route JS unchanged; 312 fewer production lines; 174/174 tests |
| Delete remaining no-caller frontend helpers | Same build/chunk method; full Vitest | 7,864,904 JS B; 135,251 CSS B | 7,864,658 JS B (`-246`); 135,110 CSS B (`-141`); 113 fewer production lines; 168/168 tests |
| Consolidate document selection, removal, and tabular streaming | Same build/chunk method; full Vitest; five project-modal opens at 6× CPU | 7,864,658 JS B; 135,110 CSS B; 50,361 production lines; 313.3 ms modal median and one project fetch/open | 7,859,667 JS B (`-4,991`); 135,087 CSS B (`-23`); 50,112 lines (`-243`, 69 below OG Mike); 278.1 ms (`-11.2%`) and zero project fetches; 173/173 tests |
| Delete the one-caller Tabular workflow wrapper | Same build/chunk method; full Vitest | 7,859,667 JS B; Tabular detail 1,164,368 JS B; 50,112 production lines | 7,859,357 JS B (`-310`); Tabular detail 1,164,058 B (`-310`); 50,082 lines (`-30`, 99 below OG Mike); 173/173 tests |
| Remove Tabular model/effort prop relay | Same build/chunk method; focused payload assertion; full Vitest | 7,859,357 JS B; Tabular detail 1,164,058 JS B; 50,082 production lines | 7,859,235 JS B (`-122`); Tabular detail 1,163,936 B (`-122`); 50,069 lines (`-13`, 112 below OG Mike); 173/173 tests |
| Replace five drag state machines and the one-item Workflow Actions menu | Exact frontend build/chunk method; live pointer drags at 1440; 390/320 overflow QA; full Vitest | 7,859,881 JS B; 136,486 CSS B; 50,065 production lines | 7,858,373 JS B (`-1,508`); 136,017 CSS B (`-469`); 49,901 lines (`-164`, 280 below OG Mike); three exact `+80 px` live drags; 175/175 tests |
| Replace three selected-item popovers with fixed native controls | Exact frontend build/chunk method; 1440/390/320 geometry and Escape QA; full Vitest | 7,858,373 JS B; 136,017 CSS B; 49,901 production lines | 7,856,163 JS B; 136,037 CSS B (`-2,190` combined); 49,803 lines (`-98`); zero toolbar movement or overflow; 176/176 tests |
| Reveal the warmed Authorities host on navigation intent; fit project tables at 640/320 | 15 warm transitions each at normal/6x CPU; exact build/chunks; live geometry; full Vitest | Old-screen hold 13.5/41.9 ms median; three internal overflows of 26/4/4 px; 7,992,200 combined JS+CSS B | 0.8/8.1 ms (`-94.1%`/`-80.7%`); zero overflow/shifts/reloads; 7,992,324 B (`+124`, `+0.0016%`); 180/180 tests |
| Stabilize remaining bulk, attachment, and member controls | Exact frontend build/route manifests; 1440/390/320 geometry, popup, Escape, and overflow QA; full Vitest | Measured routes 879,154–1,373,985 B; member hover shifted the row 25.5 px; 49,786 production lines | Every route `-169` to `-952` B; zero shift or overflow and inward narrow-screen popup; 49,716 lines (`-70`); 181/181 tests |
| Remove duplicate Tabular cell overlay and redundant workspace loading state | Exact frontend build/chunks; intercepted live review at 1440/390/320; full Vitest | Two clicks and an intermediate 179/283 px overlay; 7,927,910 JS B; 49,716 production lines | One click to Details in 47.1/46.9/63.1 ms; zero shift/overflow/errors; 7,925,369 JS B (`-2,541`); 49,553 lines (`-163`); 182/182 tests |
| Replace the custom column-preset overlay and delete zero-caller props | Exact frontend build/chunks; 1440/390/320 chooser geometry, reachability, search, and Escape QA; full Vitest | Only 7/14 presets visible; Escape closed the parent; 7,925,369 JS B; 49,553 production lines | All 14 bounded/searchable; parent stays fixed; 7,921,183 JS B (`-4,186`); 49,481 lines (`-72`); 183/183 tests |
| Mount document-table drag listeners once | Exact frontend build; instrumented Library/Project interactions at 1440/320; full Vitest | Per event, Library reached 8 adds/7 removes and Project 6/5 | Every stage stays 1/0/1 active; zero geometry/overflow/error regression; `+35` JS B and `+5` production lines; 184/184 tests |
| Delete the duplicate document-drop surface and write-only active-chat state | Exact frontend build/chunks; Library/Project drag and two-chat navigation at 1440/320; full Vitest | Two external-file drop state paths; 9 active-chat writes; 7,921,218 JS B; 49,486 production lines | One upload path; pathname is sole active-chat source; 7,920,179 JS B (`-1,039`); 49,404 lines (`-82`); zero shift/overflow/errors; 185/185 tests |
| Make pending-chat handoff non-reactive and one-shot | Exact frontend build/chunks; intercepted workflow/chat navigation at 1440/390; provider render contract; full Vitest | Broad context invalidation and a stale handoff when chat creation failed; 7,920,179 JS B; 49,404 production lines | Zero consumer renders from stage/claim; one stream request after navigation/reopen; no stale failed-save handoff; 7,920,420 JS B (`+241`); 49,429 lines (`+25`); 188/188 tests |

The Assistant and workflow-modal lazy-load experiments were reverted after
6×-CPU interaction tests regressed fast send by about 307 ms and modal open by
about 1.07 seconds. No build-time improvement is claimed yet. The warmed
Authorities route passed 110/110 internal transitions at 1440, 390, and 320
CSS pixels with zero changed pixels through two animation frames and 500 ms.
Building into a live `.next` directory was also proven to cause 500ing chunks
and full-page fallback navigation. The dependency-free prebuild guard now
fails before Next in 0.6 seconds without touching the build, while its
stopped-server probe adds a 44.1 ms median. Exact-build transitions preserved
SPA state at 1440, 390, and 320 pixels with no failed requests.

### P0.2a Page-first PDF preparation

The durable queue, priority, lease, cancellation, progress, and crash-recovery
contract is specified in [background-jobs-plan.md](../current/background-jobs.md).

Status: **Active**

PDF upload and exact reading use one LegalPDF projection boundary. Upload must
validate the file, count pages, commit the document, and return without waiting
for OCR. The existing serialized projection worker then prepares the immutable
full-document artifact opportunistically: native extraction first and local OCR
only for pages the deterministic classifier marks weak. It never invokes a
remote vision model without an explicit user operation.

An interactive exact-page read preempts background preparation. It extracts
native text for the authoritative physical page and OCRs only that page when
the classifier says it is weak; unrelated pages cannot delay the answer. The
page projection is content-addressed by document, version, source hash, parser
identity, OCR identity, and selected pages. Its evidence receipt remains
rehydratable after the full background projection replaces the current state.
Full-document parsing remains the path for search, sections, footnotes, Table
of Authorities, and whole-document questions.

The one running tool activity changes phase in place (`Inspecting page 5`,
`Running OCR on page 5`, `Reading page 5`) rather than adding duplicate rows.
If grounding correction is needed, already registered evidence IDs remain in
provider context and Beaver directs the provider to reuse them rather than read
the source again. Background failures do not roll back a valid upload; they are
recorded as projection state and retried only by the canonical worker.

Acceptance:

- Upload latency excludes native extraction and OCR; local and cloud use the
  same application and worker contract.
- A page-5 request on an 80-page scanned PDF OCRs page 5 before the remaining
  79 pages and reports that phase through one stable activity ID.
- Targeted and full parsing produce identical page text, line order, page unit,
  evidence hashes, and links for every page in the available legal-PDF corpus;
  no sampled-corpus proxy is accepted.
- Content-addressed targeted results survive restart and are reused without
  OCR; cancellation resumes the preempted full-document job.
- No remote vision/model call occurs during upload or implicit preparation.
- Live ChromeDriver and Luna checks cover digital-born, scanned, out-of-range,
  corrupt, cold, warm, cancelled, and upload-then-immediate-read outcomes.

### P0.3 Account-free local parity

Status: **Complete for the core product**

Account-free local mode and cloud mode now use the same document, Library,
project, chat, workflow, tabular, assistant, and account application services.
Runtime composition selects thin SQLite/filesystem or Postgres/S3 repositories;
ordinary routes and tools contain no paired local/cloud implementation. Local
custom workflows and audit history are durable. Cloud-only identity, sharing,
and contribution administration fail explicitly when unavailable rather than
acquiring a second local product path.

Acceptance:

- No ordinary local navigation ends in a Supabase 503.
- A local user can create a matter, import documents, chat, draft/revise a
  document, restart Beaver, and continue with unchanged versions and citations.
- The automatically enumerated application contract passes unchanged against
  temporary local SQLite/files and real local Supabase/object storage.
- Ordinary routes and tools cannot import a mode flag, SQLite, Supabase, or S3;
  adding a persistence capability fails compilation until both data-port
  encodings implement it.
- Cloud mode also passes its account, authentication, sharing, and
  storage-extension tests; both modes pass the shared audit contract.

### P0.4 Freeze and commit the current baseline

Status: **Partial**

The broad root source checkpoint landed as `02aff487`. It excludes credentials,
AppData, downloaded corpora, caches, generated benchmark/graph output, managed
runtimes, local agent configuration, and the dirty nested PDF-engine worktree.

- Move or ignore the remaining generated probe/runtime artifacts so source
  status is readable without committing or deleting useful experiments.
- Commit intentional nested neutral-repository changes first and update
  `subrepos.lock.json` plus bundles/pins; never stage a dirty gitlink as a root
  shortcut.
- Keep subsequent refactor commits as focused vertical slices without raw
  model traces, credentials, AppData, downloaded corpora, or temporary files.

Acceptance:

- Root and nested status outputs contain only intentional ignored runtime
  artifacts.
- A fresh local clone/check-out has documented bootstrap steps and does not
  fail randomly for `duckdb`, PyMuPDF, Node, or Codex.

## Priority 0 — legal-safe context management and compaction

### P0.5 Independent research and falsifiable hypothesis

Status: **Done** (research only; no production promotion)

The two independent tracks and synthesis are complete. They:

- compared the proposed design with primary long-context/memory research and
  source code from existing systems;
- verified current legal and long-session benchmarks, including the exact
  identity, access terms, and usefulness of the benchmark described as
  “Semantic Legal Bench by Marty Rudolf”; and
- proposed separate ablation experiments before their conclusions were
  reconciled.

Their reports are:

- `context-compaction-research-track-a.md`
- `context-compaction-research-track-b.md`
- `context-compaction-research-synthesis.md`

The synthesis supports testing an immutable event log, exact active-state
projection, optional provider checkpoint, non-authoritative summary, and
event-aware recent tail. It does not show that full history currently fails or
that any compaction candidate is production-ready. No compaction strategy is
promoted merely because a paper or framework reports general-agent gains.

### P0.6 Server-authoritative legal session state

Status: **Research**

Implement the smallest three-layer projection that survives the benchmark:

1. **Exact state ledger**: matter/document versions, accepted instructions,
   defined terms, factual assertions with status, quotes, pinpoints, evidence
   IDs, tool receipts, pending decisions, and artifact hashes.
2. **Lossy task summary**: current objective, completed work, unresolved
   issues, and a short rationale map. It may be regenerated or discarded.
3. **Recent verbatim tail**: the most recent turns and bounded tool outputs.

The browser submits the current turn and optimistic concurrency version. The
backend reconstructs the canonical provider request from durable state rather
than trusting a browser-supplied full transcript.

Required behavior:

- Preserve the complete raw transcript for audit and recovery.
- Keep matters and clients isolated by default; no cross-matter legal facts or
  instructions enter context without an explicit reference.
- Compact on the estimated final assembled request, not raw transcript length.
- Reserve output/tool budget before compaction.
- Use provider continuation/compaction where available, but keep the
  provider-neutral exact ledger authoritative.
- Capture and resume Codex thread/checkpoint state where it is demonstrably
  safer and cheaper than new ephemeral invocations.
- Bound every tool result and store overflow behind durable handles.
- Rebuild a session from raw transcript + exact ledger when a provider session
  expires or becomes inconsistent.

Acceptance:

- Long-session tests show no material loss in quotes, pinpoints, qualifiers,
  defined terms, document versions, unresolved instructions, or tool state.
- Cross-matter leakage is zero in adversarial fixtures.
- Median input tokens and latency beat full-history baseline at equal or better
  legal fidelity.
- A corrupted summary cannot override exact state or source evidence.

### P0.7 Context observability and prompt/tool diet

Status: **Active**

- Log provider/model/effort, assembled input estimate, actual usage, cache
  hits, compaction reason, retained tail, summary version, exact-state size,
  tool schema size, retrieved evidence size, and continuation IDs.
- Use stable prompt prefixes and cache keys where officially supported.
- Measure the current system/developer/tool-schema overhead.
- Group or defer tools only after tool-recall tests demonstrate no material
  legal regression.
- Replace large tool payloads with result handles and deterministic follow-up
  reads.
- Test prompt injection through retrieved opinions, PDFs, journal articles,
  tool receipts, and summaries.

Approved 2026-08-14: the
[current tool runtime](../current/tool-runtime.md) replaces the earlier
address-mode and automatic BM25 schema-selection design.
One executable registry will derive schemas, dispatch, visibility, and
subagent capabilities. A small resident surface plus exact-name specialist
loading will serve every view and provider. Note Up will expose judicial
discussion and rigorously reviewed, pinpoint-checked journal analysis as
separate first-class source roles without ranking scholarship beneath cases.

Implemented 2026-08-14: the canonical engine, registry, resource plane,
store-backed local/cloud composition, Note Up lanes, provider adapters, and
schema budgets pass deterministic and live Luna/Gemini checks. Codex receives
a static registered MCP catalog because its current client does not refresh
`tools/list_changed`; the registry still requires exact `load_tools`
authorization before any specialist executes.

Acceptance:

- A run can explain why compaction occurred and which exact state survived.
- Token reductions can be attributed to a measured component.
- Tool discovery/selection recall remains within the benchmark tolerance.

## Priority 0 — universal document structure in Beaver

### P0.8 Wire the Legal PDF Parser into Library ingestion

Status: **Partial**

Beaver now consumes the engine on demand for local Library and provider PDF
sources. It stores immutable inputs, content-addressed parser artifacts,
diagnostics, evidence receipts, and exact structure queries; unchanged sources
reuse their artifacts. Durable background job state, restart/resume UX,
selective OCR routing, and the full typed PDF-table path remain incomplete.

Work:

- On PDF import, store the source first, then create a durable background parse
  job with `queued`, `parsing`, `ready`, `degraded`, or `failed` state.
- Save one canonical `DocumentStructure`, the neutral PDF artifacts required to
  rehydrate source geometry/tables/images, diagnostics, parser configuration,
  and repair provenance beside the immutable PDF. Do not persist duplicate
  semantic page/paragraph/note graphs or geometry-rich parser working state.
- Parse PDF tables as true structural artifacts: sheet/table, row, cell,
  row/column spans, reading order, source page, and provenance/confidence. Feed
  that typed grid into a compact model-facing representation only after the
  structure is proven. Never promote rows or cells guessed from flattened PDF
  text into deterministic coordinates.
- Reuse that structural source by source hash +
  parser/prompt/model/config version.
- Keep the immutable PDF available if structural parsing fails.
- Expose parse state, diagnostics, and a manual retry/escalation control in the
  Library.
- Feed attachments from TNA/GOV.UK ET/GovInfo and other providers through the
  same adapter when native structure is absent.
- Add a concrete optional weak-hardware OCR provider for scanned/image PDFs;
  route only affected pages.

Acceptance:

- Import returns after safe source storage, not after model repair.
- Restarting Beaver resumes or reports an interrupted parse deterministically.
- An unchanged PDF does not repeat extraction or model calls.
- A raster-only PDF degrades honestly and can be selectively OCRed.
- A PDF table either yields a versioned typed grid that rehydrates to source
  geometry, or reports table structure unavailable; flattened text is not a
  successful table parse.

### P0.9 Exact structure tools

Status: **Partial**

the resource-plane `Read`/`Grep` surface, SourceDoc provider
lookups, and DOCX structure reads already expose bounded pages/ranges, parser
paragraphs/ranges, paired footnotes and propositions, encoded legal sections,
verified section handles, and native DOCX table rows/cells. The remaining work
is one format-neutral contract, complete provider fixture coverage, and removal
of parallel parsers/result shapes under P0.0.

Expose compact tools for:

- one footnote or a bounded footnote range;
- the proposition(s) associated with each note reference;
- page or page range, including `[page n]` markers;
- a real provider/printed numbered paragraph or paragraph range;
- section, subsection, paragraph, subparagraph, clause, subclause, schedule,
  article, and provider-specific encoded variants;
- native DOCX table, row, and cell coordinates without emitting an unbounded
  inventory of unrelated cells;
- native spreadsheet and structurally parsed PDF table, row, and cell
  coordinates through the same format-neutral grid contract;
- surrounding context by structural neighbor count, not arbitrary characters;
  and
- deterministic source/evidence handles suitable for later citation or
  document mutation.

Geometry-backed prose paragraphs remain available as chunk/context boundaries,
but their internal ordinal is not a legal locator. When the source has no real
numbered paragraph stream, address the passage by printed/physical page plus
exact text anchor; do not display a synthetic `para N`.

Every structure query is narrowable at the source's legal level. Decimal
provisions are complete sibling identifiers (`150` and `150.1`); only
parenthetical levels express provision ancestry (`150` -> `150(1)`). Graph
expansion is a separately requested, bounded, non-overlapping union and never
silently widens an exact child lookup.

These tools return only requested units plus stable IDs, version, confidence,
and link metadata. The model does not parse the whole PDF to answer “footnote
62.”

Acceptance:

- Exact lookups are covered by digital-born, degraded-export, restart-numbered
  notes, symbol notes, multi-column, and provider-native structure fixtures.
- Every quoted result can be rehydrated from authoritative source bytes and
  linked without model-authored URL syntax.
- A targeted table/section query exposes only responsive units and executable
  follow-up coordinates, not a near-global outline.
- Model-facing table output defaults to the smallest self-contained projection
  that preserves exact addresses and displayed values. Rich formatting,
  formulas, and geometry are disclosed only when the task requires them; the
  projection is never the canonical table state.

### P0.10 Complete the structural benchmark

Status: **Partial**

Completed corpus foundation:

- `scripts/stage_docx_benchmark_corpus.py` builds a private,
  content-addressed corpus, verifies every hash, rejects lockfiles and
  sensitive/credential-like names, excludes downstream chief/galley/camera/
  final derivatives by default, and keeps all source documents and manifests
  out of git.
- The current canonical local set contains 24 byte-unique, least-edited
  upstream DOCX files (10.76 MiB), with one source per work and no selected
  chief, galley, camera, annotated, ToA/BoA, returned, revised, or final copy.
- The corpus runner parsed 24/24 files in 2.42 seconds, extracting 2,009
  footnotes (1,860 unique) and 1,090 citation signals. The conservative gate
  covered 143 notes (7.12%); recall-first covered all notes; both had zero
  substantive character-conservation failures.
- An 80-row, document-diverse 40-easy/40-hard review queue exists locally, but
  every row remains `provisional`. Coverage and character conservation are
  not boundary accuracy.
- The independently maintained 405-row accepted ALR split gold was rerun:
  conservative produced 144 exact partitions and recall-first 324, with zero
  character loss. See [DOCX benchmark design](../harvey-labs/design/docx-benchmark-design.md).

The 24-document set is a runnable inventory/smoke foundation, not a release
denominator or structure ground truth. Inventory and register every additional
available eligible DOCX before the shared-structure cutover; neither this set
nor the former 69-document agreement sample can stand in for that corpus.

Use the ALR Quote Verifier `.docx` suite as ground truth for corresponding PDF
exports. Do not assume rich exports:

- native tagged/accessible;
- ordinary print/export;
- flattened or font-damaged;
- missing tags/bookmarks;
- rasterized and mixed scanned/digital;
- difficult multi-column/page-marker cases.

Run:

- the frozen 80-page and full 661-page Text-Fidelity corpora;
- the available ALR DOCX/PDF equivalents, not only the existing 19-page smoke
  case;
- deterministic-only, cheap repair, and stronger repair arms;
- warm-cache replay and weak-hardware resource measurements; and
- a diverse, licensed US/Canadian/UK public legal-PDF corpus collected with a
  manifest, checksum, source URL, jurisdiction, document type, and failure
  taxonomy.

Score exact text fidelity, reading order, page boundaries, section hierarchy,
footnote reference/body pairing, proposition pairing, citation recall, runtime,
memory, tokens, and cost.

Acceptance:

- Frozen manifests and scorer versions make every reported number
  reproducible.
- The fail-closed registry in
  `experiments/legal_pdf_corpus/LEGAL_PDF_SILVER_MASTER_PLAN.md` inventories
  and runs every locally available corpus that can exercise PDF, SourceDoc,
  grammar, OCR, or semantic-structure behavior. Unregistered applicable data,
  silent skips, samples standing in for full corpora, and stale-cache receipts
  fail the release gate.
- Model repair must improve a named structural metric without losing text,
  IDs, or source order.
- Complexity increases only for recurring failure classes with held-out wins.

### P0.11 Rebuild the ALR Quote Verifier on the shared engines

Status: **Planned after P0.10 acceptance**

Maintain an independent ALR Quote Verifier branch as a thin consumer of Legal
PDF Parser and the provider-neutral structure engine. It must not copy either
engine or recreate their detector grammar. Decompose the verifier monolith
around intake, structure, quote and proposition resolution, evidence, and
presentation while preserving its useful product behavior.

Add only the Codex app-server account methods needed for managed browser or
device-code `chatgpt` login, `account/read`, logout/cancel, and
`account/rateLimits/read`. Codex owns persistence and token refresh; the
verifier never receives or stores ChatGPT access tokens. Subscription-backed
calls are permitted for the verifier acceptance run; API-key and other metered
auth modes fail closed unless separately authorized. Pin the implementation to
the official [Codex app-server account protocol](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
rather than scraping CLI output or owning OAuth tokens.

Acceptance:

- Every locally available verifier DOCX is inventoried by content hash and run
  through the rebuilt branch with exact denominators and compact receipts.
- One real PDF with footnotes, propositions, and a quotation with an
  independently verifiable source and pinpoint passes end to end, including
  fail-closed disagreement behavior.
- Engine versions are pinned dependencies, so later structure improvements
  reach Beaver and the verifier through dependency updates rather than copied
  patches.
- The branch has no Beaver runtime dependency and Beaver imports none of its
  private modules.

## Priority 1 — provider-neutral legal retrieval and durable sources

### P1.1 Normalize all provider structure

Status: **Part of the active shared-structure port**

Provider acquisition remains provider-specific. A light adapter preserves its
native structure and provenance as canonical evidence; missing structure then
uses the appropriate capability in the same Rust engine. Provider names never
select duplicate implementations of a format-neutral detector. Candidates and
witnesses stay private to the capability that understands them; provider URLs
and locators are attached at the edge after analysis.

The exact port, Beaver invocation, corpus gates, and deletion standard are the
single procedure in [Shared document structure](document-structure.md), not a
separate SourceDoc consolidation.

### P1.2 Durable provider cache and bulk paths

Status: **Active cutover**

- Materialize the canonical `DocumentStructure` during provider installation
  only where the measured lookup path needs an output store. Runtime derives
  SourceDoc and other views from that row; it does not store a second detected
  representation. A miss uses the same in-process Rust function.
- Bind each output store to its provider snapshot identity and engine/schema
  version, preserve resumable bounded transactions, and replace completed
  stores atomically.
- Keep provider databases independent immutable snapshots.
- Retain and test A2AJ/CourtListener bulk import/update.
- Survey official bulk/download options for every integrated provider; add
  only lawful, maintainable paths that improve reliability.
- Let Library entries point to a stable provider/cache record instead of
  copying large bodies.

Acceptance:

- A source already in bulk/cache opens without a network call.
- A provider outage does not invalidate previously verified local evidence.
- Cache corruption is detected and recoverable.

### P1.3 Seamless deterministic pinpoint links

Status: **Partial**

The claim-local receipt, quotation-integrity, rich-footnote, and artifact
handoff work is specified in
[Grounded drafting integrity](../current/grounded-drafting.md). Implement it
through the existing evidence registry and semantic DOCX renderer; do not add a
parallel citation framework or semantic-verification service.

Cross-provider text-fragment gaps and their browser evidence are tracked in
[External pinpoint robustness](external-pinpoint-robustness.md).

- Replace verbose model-authored citation JSON with short evidence handles.
- Hydrate and verify exact quote spans on the server.
- Prefer native provider anchors; otherwise produce verified text fragments.
- Support multiple text directives for disjoint spans in one page/paragraph/
  section.
- Produce local galley-viewer links when an external URL cannot express the
  exact unit.
- Audit provider PDF metadata before exposing a `PDF` action. In particular,
  Federal Court Decisia `document.do` URLs may be landing pages rather than
  direct PDFs; label or replace them only after verifying the returned media
  type and preferred provider URL.
- Attach links automatically to chat output and generated/revised DOCX
  citations.
- Benchmark latency and cache behavior so references appear with no perceptible
  second pass.

Acceptance:

- The model can effectively ask for “this evidence handle,” “section 7.3,” or
  “the sentence just retrieved”; it never hand-builds `#par`, `#sec`, or
  `:~:text=`.
- Link correctness, quote verification, and source version are deterministic.

### P1.4 Retrieval: lexical first, vectors only if earned

Status: **Research**

- Build a held-out exact-passage retrieval suite over bulk provider data and
  `public_endpoint.db`.
- Compare FTS/BM25, TurboVec or another small dense index, and hybrid/reranked
  retrieval at the same candidate and latency budgets.
- Measure Recall@k/nDCG, exact pinpoint hydration, wrong-source rate, index
  time/size, update cost, and weak-hardware latency.
- Keep vector outputs as candidates; authoritative source lookup supplies text
  and links.

Citator/note-up retrieval stays deterministic and scoped before any semantic
treatment product is considered:

- filter citing decisions by normalized court level (`scc`, `appellate`,
  `trial`, or `all`) and optional exact court code;
- rank either newest-first or by auditable discussion density at the same
  scope and budget;
- start discussion density with resolved citation-occurrence count across
  proven aliases, then ablate distinct citing paragraphs, pinpoints, and cheap
  resolvable short-form mentions;
- return component counts and bounded citing passages with evidence receipts;
  never label this heuristic as followed/distinguished/overruled; and
- add an offline temporal-integrity report: quarantine an edge when a known
  citing-decision date is strictly earlier than the known cited-decision date,
  while treating missing dates as unknown rather than wrong.

Acceptance:

- Add the vector dependency only if it produces a meaningful held-out win that
  lexical retrieval cannot match with simpler query expansion/reranking.
- Court filtering and discussion-density ranking beat or tie newest-first on a
  held-out note-up set at equal result and character budgets, or remain an
  optional caller-selected sort rather than the default.
- Temporal-impossibility counts and sampled receipts are zero or every defect
  is quarantined and explained before citator ranking is promoted.

### P1.4a Minimal coding-native legal retrieval

Status: **Minimal one-shot frontier established; context/compiler stack rejected (2026-08-03)**

The consolidated fixed-Sol evidence is recorded in
[Mike one-shot context results](../harvey-labs/results/harvey-lab-mike-one-shot-context-results-2026-08-03.md).
A fresh pinned-Mike control scored 172/225 at 590,911 logical tokens. The plain
two-tool native-work-product arm scored 177/225 at 597,341; a 437-byte
conflict-first attention prompt scored 178/225 at 628,072. The margin between
those candidates is below observed run variance, so the plain arm is the live
candidate and conflict-first remains replication-only. Effort-matched frozen
Mike/xhigh replicates scored 172 and 169, so xhigh alone does not explain the
candidate result.

Every more elaborate context treatment failed to earn its cost. Fact indexing
scored 165/225, two quote-first replicates scored 162 and 170, adaptive review
scored 175, large-context planning scored 174, monotonic review scored 168, and
a preregistered fresh omissions scout scored 177 while consuming 1,181,068
tokens. The scout's exact-excerpt verifier accepted 16 bounded findings and
rejected 5, but its Tax gain and Indenture loss cancelled. Frozen primaries were
177/225 before 570,890 reviewer tokens and 177/225 afterward.

Retire the optional-coordinate schema, research checkpoint, evidence union,
fresh drafting handoff, fact packet, quote ledger, forced compiler correction,
reviewer, planning turn, and automatic context-refresh machinery from the live
candidate. Preserve exact evidence, hashes, versions, pinpoints, and receipts
host-side. Expose legal structure only as an optional navigation or exact-edit
primitive through ordinary tool semantics.

Deterministic assistance must have objectively testable semantics: exact
normalization and source/version/hash receipts, substring and locator checks,
duplicate/terminal guards, arithmetic or date transformations, or exact
version-bound patches after a correction is selected. A verified path proves
that an excerpt exists; it does not prove materiality or entailment. Broad
source-only anchors, divergent-term lists, generic legal lint, and compulsory
repair advice remain outside model context because the landed audits did not
identify the actual omissions.

Acceptance for promotion:

- Preregister a broader paired matrix, emphasizing long discriminating tasks,
  with exact task/source/tool/prompt fingerprints and one fixed judge before
  calls. Compare only true pinned Mike, the retained native surface, and the
  prompt-only conflict-first replicate.
- Hold performer model, effort, provider-reported tier, retrieval settings, and
  judge constant; inspect exact traces before scoring; label Sol criteria as
  provisional derivative evidence rather than human gold.
- Replicate performers so a one-point sampling fluctuation cannot select the
  architecture. Never reuse a control whose receipt lacks the registered
  origin and source-blob proof.
- Match or exceed pinned Mike with fewer logical tokens. Up to 2x tokens is
  acceptable only for a broad, substantial accuracy gain with no task collapse.
- Add no context or deterministic stage without an independently attributable
  score or correctness win that exceeds its token and latency cost.

## Priority 1 — deterministic document and spreadsheet work

### P1.5 Compact evidence handles and citation-linking route

Status: **Partial**

For “link the citations in this document”:

1. deterministically inspect footnote layout and citation boundaries;
2. route directly to the bounded ALR-style splitter + ultra-economy linker
   unless a measured routing classifier saves tokens at equal accuracy;
3. use a dynamically available strong Codex model demonstrated equivalent on
   the benchmark; and
4. write only verified links into a new immutable document version.

Complete the still-pending real ALR DOCX multi-arm benchmark now that real model
calls were authorized. Do not use unsupported `gpt-5.2`; compare current
eligible models and efforts with constants pinned.

The least-edited upstream Ampleman source has 70 exact accepted-gold matches
and a frozen 12-case sample. Luna, Terra, and Sol capability probes pass, but
the six legal-data arms remain unrun because transmitting the selected private
footnotes and propositions to OpenAI through Codex requires a separate,
informed approval. The offline router estimates only 212 tokens saved by
forced hybrid, below its 512-token threshold, so `direct` remains the automatic
route. See [DOCX live-model benchmark](../harvey-labs/results/docx-live-model-benchmark-2026-07-27.md).

Acceptance:

- Zero silent character loss, citation under-splitting, or uncertain OOXML
  mutation.
- Every link has a source/evidence receipt and document-version binding.
- Multiple passages from one authority remain one citation with one ordered,
  deduplicated multi-pinpoint link.

### P1.6 Token-efficient DOCX operations

Status: **Partial**

| Research artifact | Status |
| --- | --- |
| [Deterministic Word actions catalog](../decisions/document-actions.md) | **Complete** — classifies direct, bounded, preview-only, and judgment-dependent Word actions; runtime gaps below remain planned. |

Implemented:

- A conservative `library_fix_docx_supras` operation finds visible
  `supra note N` across Word run boundaries, adds native bookmark/`NOTEREF`
  fields, preserves run properties and unrelated OOXML, creates a new Library
  version only on change, and abstains on restarted numbering, invalid targets,
  tracked changes, hyperlinks, or unsafe field boundaries.
- A Library HTTP action and assistant tool expose the same operation; the
  citation-linker and Table/Book of Authorities workflow are exposed beside it.
- Generated agreement drafts can place explicit fields and clauses in stable,
  tagged Word content controls. Reads include their accepted text; assistant
  tracked edits fail closed at the control boundary.
- DOCX creation now has one model contract and one renderer: bounded semantic
  Markdown for headings, lists, tables, native footnotes, fields, page breaks,
  bookmarks, and verified `[@source]` links. The former `sections[]` path was
  deleted rather than maintained.
- Precedent drafting now reads the exact active DOCX version into bounded,
  structure-preserving HTML with a source hash, then asks the model only for
  legal/formatting judgments before using that same Markdown renderer. The
  byte-copy-and-edit tool and its UI/event plumbing were deleted.
- **Document actions** is a non-modal floating side panel, not a focus-stealing
  dialog. It docks left/right, minimizes to a launcher, and leaves the Library
  interactive. A component test verifies background interaction, docking,
  minimize, and restore.
- Native top-level DOCX table cells have stable
  `table:N/row:N/col:N` handles on the same accepted-text offset plane used by
  tracked edits. Empty cells, `gridBefore`, horizontal/vertical merges, and
  nested-table text are covered without minting phantom addresses.
- `library_delete_and_renumber_docx` atomically deletes one numbered provision,
  closes a proven contiguous sibling gap, and updates resolved internal
  pointers as tracked changes. It refuses ambiguous, unresolved, external,
  already-gapped, and referenced-deleted targets. The contract is deliberately
  delete/close-gap only; insertion/open-gap semantics remain unsupported.
- One local assistant turn creates at most one assistant-edit version per
  document. Later mutations in that turn update it only when earlier tracked
  change IDs remain valid, so accept/reject receipts cannot dangle.
- Generated DOCX drafting now gives the model a compact semantic contract:
  `>` creates a native indented paragraph, `\>` emits a literal greater-than
  sign, and a trailing backslash creates a hard line break. Standard memo
  To/From/Date/Re headers, filenames, heading numbering, citation form, repeat
  forms, and separate source/pinpoint hyperlinks are renderer-owned. Citation
  markers bind only to exact same-turn evidence IDs, and local/cloud Drafting
  Style settings select per-document citation placement without duplicating
  assistant paths.

Deferred deterministic boilerplate (promote only for a concrete document
workflow with a render fixture and measured token reduction):

- Keep Word properties, page numbers, headers/footers, and TOC/TOA fields
  artifact-owned rather than asking the model to spell them out.
- Add narrow structured shells for recurring factum cover/part labels and
  business-letter address, salutation, and closing blocks; do not introduce a
  general template language.
- Populate court, matter, party, contact, signature, and service blocks from
  selected matter/profile data or explicit user inputs, and ask when required
  values are missing instead of inventing them.
- Reuse native fields, bookmarks, content controls, and document metadata for
  cross-references, captions, defined terms, and repeatable provisions instead
  of retransmitting their presentation on every draft.

- Build version-bound find handles so repeated changes do not resend whole
  documents or ambiguous before/after context.
- Add deterministic scoped replace, batch replace, tracked-change insertion,
  bookmark/REF/PAGEREF/SEQ maintenance, and editorial lint primitives.
- Support Word content controls where they reduce repeated model-authored
  structure: stable IDs/tags, bound fields, linked definitions/citations, and
  repeatable sections.
- Preserve unsupported OOXML and reject unsafe run-boundary mutations.
- Port only general-purpose features from the ALR macro audit; leave
  law-review-specific UI/macros behind.

Acceptance:

- Each mutation declares source version, target handles, preconditions, and a
  new version.
- A simple find/replace uses a bounded deterministic operation, not a model
  rewrite.
- An agreement-drafting request returns a durable DOCX artifact by default,
  with editable fields/clauses as native controls and only a short chat handoff.

### P1.7 Token-efficient spreadsheet operations

Status: **Research**

- Add bounded A1/range reads, table metadata, formula inspection, targeted cell
  patches, row/column insertion, and batch operations.
- Preserve formulas, types, styles, comments, validation, and unsupported
  workbook features, or fail closed.
- Never serialize an entire workbook to Markdown when a range answers the
  question.

Acceptance:

- Every edit is version-bound, range-scoped, previewable, and testable on
  formula/style fixtures.

## Priority 1 — Library viewers and durable legal work products

### P1.8 Universal legal galley viewer

Status: **Partial**

The current `LegalSourceViewer` is a useful start, not the requested
Text-Fidelity galley-viewer port.

- Define one renderer contract for cases, legislation, journal articles, and
  uploaded PDFs.
- Reuse the Text-Fidelity viewer's proven navigation/layout behavior and
  Table of Authorities' source rendering without runtime coupling to those
  applications.
- Render pages, sections, nested provisions, prose paragraphs, real numbered
  paragraphs, footnotes,
  propositions, highlights, native/external/local pinpoints, and provenance.
- Library entries remain lightweight pointers to shared bulk/cache/artifacts.
- Open sources in existing or separate tabs without duplicating durable blobs.

Acceptance:

- The same normalized source record renders across providers and uploaded PDFs.
- Opening a pinpoint is fast, stable after restart, and highlights the exact
  quoted unit.

### P1.9 Legal ontology graph artifacts

Status: **Research**

Use the decision in `legal-ontology-graph-repo-evaluation.md`:

- renderer-independent versioned JSON for tests, factors, subfactors,
  interpretations, applications, commentary, exact passages, citations,
  proposals, review state, and saved views;
- deterministic schema validation, quote/link hydration, IDs, hashes, visible
  projection, layout seed, and memo generation;
- model-generated proposals stay separate until accepted;
- lazy `@xyflow/react` + `@dagrejs/dagre` viewer with filters for doctrine,
  interpretation, application examples, and journal commentary; and
- immutable Library revisions plus linked Markdown/DOCX research memos.

Acceptance:

- A user can expand from a legal test to factor/subfactor, then to exact case
  or article passages and further treatment.
- Large graphs meet an explicit node/edge interaction budget.
- The artifact remains usable without React Flow.

### P1.10 Table of Authorities integration and packaging

Status: **Partial**

- **Done:** the local assistant has bounded submit/status tools for owned
  Library Word and PDF versions. It reuses the standalone localhost job API,
  exposes no arbitrary path/command parameter, and returns a job-specific
  Beaver route.
- **Done:** PDF source documents use `legal-pdf-parser`'s canonical
  body/footnote/endnote adapter and can create a Book of Authorities. Inserting
  a table remains an explicit Word-only operation.
- **Done:** detection can explicitly use the neutral Legal PDF Parser's cached
  splitter for incomplete citation units only; deterministic-only remains the
  standalone default and review JSON records fallback telemetry.
- Finish browser/Tk parity gaps using the browser UI as canonical.
- Make jobs durable/resumable.
- Remove anonymous-development-only embedding restrictions where deployment
  security permits.
- Package the same localhost host/static UI as a standalone desktop executable.
- Add dependency/version doctor checks; normal startup must not import optional
  DuckDB/PyArrow.
- Preserve standalone CLI and legacy Tk fallback.

Acceptance:

- Standalone browser host and Beaver tab execute the same job/UI code.
- A clean supported machine can bootstrap or run the packaged build without
  random missing-module failures.

### P1.10a Alberta filing-package builder

Status: **Planned**

Turn final Library documents into reviewable, court-ready filing packages by
reusing the existing document/version, universal-PDF, citation-linking, OCR,
and Table/Book of Authorities machinery. This is a deterministic product, not
an assistant prompt or a second document store.

The first release supports one bounded flow:

1. Select and order the factum or brief, affidavits, exhibits, authorities,
   proposed order, and other final Library versions.
2. Choose a supported Alberta court and package type.
3. Build the required PDFs and receive a concise pass/fail exceptions report.
4. Correct or replace a source version and rebuild without manually repairing
   derived pagination, indexes, bookmarks, or links.

For the selected package profile, deterministically:

- preserve immutable inputs and record their exact versions in the build
  receipt;
- make PDFs searchable, merge only the required sets, create descriptive
  exhibit/document bookmarks, continuous pagination, hyperlinked indexes, and
  open-access authority links;
- validate required separation of documents, page limits, PDF size, filenames,
  covers, margins, fonts, paragraph numbering, indexes, and other mechanically
  testable rules;
- split outputs at the court's file-size limit without breaking navigation;
- produce any required filing checklist from the same validated metadata; and
- distinguish machine-verifiable failures from requirements that still need
  lawyer review.

Start with one current King's Bench civil email/digital-upload profile. Add a
Court of Appeal profile only after the first profile passes fixture-based tests
against the Court's published requirements. Keep the rules as small versioned
data plus shared validators; do not build a general rules engine.

Acceptance:

- Selecting fixture documents produces the expected PDFs, checklist, and
  exceptions report reproducibly in local and cloud modes.
- Reordering, replacing, adding, or removing one input rebuilds pagination,
  bookmarks, indexes, and internal links without manual repair.
- Every reported pass maps to an executable check and a dated official Alberta
  source; subjective requirements are never represented as verified.
- The result remains an export for lawyer review and filing. Beaver does not
  log into CAMS, compose filing email, pay fees, or submit documents.

Product evidence found 2026-08-14:

- [King's Bench digital-upload requirements](https://albertacourts.ca/kb/court-operations-schedules/guidelines-for-documents-filed-by-email-or-digital-upload)
  require searchable PDFs, bookmarks for attachments, practical hyperlinks,
  separate documents, and a 100 MB limit.
- [King's Bench email-filing procedures](https://www.albertacourts.ca/kb/court-operations-schedules/guidelines-for-documents-filed-by-email-or-digital-upload/email-filing-procedures/)
  warn that incorrectly named submissions are returned unfiled.
- The [Court of Appeal electronic-filing direction](https://cams.albertacourts.ca/public-portal/files/practiceDirection.pdf)
  and information sheets add mechanical packaging requirements including
  pagination, bookmarks, covers, separation, and size limits.
- Existing products such as [PdfClerk](https://pdfclerk.com/),
  [TrialView](https://www.trialview.com/dispute-resolution-platform/bundling),
  and [BundlePro](https://www.leaplegalsoftware.com/ca/companion-products/bundlepro/)
  validate demand for local or hosted bundle assembly, indexing, pagination,
  OCR, bookmarks, and hyperlinking.

### P1.11 Curated capability examples

Status: **Planned**

Create a small, redistributable demo Library:

- one Canadian decision, one statute/regulation, one US or UK decision, one
  journal article, one structured digital-born PDF, one degraded PDF, and one
  DOCX citation-linking example;
- prompts demonstrating exact paragraph/section/footnote lookup, automatic
  links, drafting, Table of Authorities, and ontology graph output; and
- expected results plus provenance/license records.

Acceptance:

- A new local user can exercise Beaver's main capabilities without providing
  private documents or external accounts.

## Priority 1 — provider breadth and multimodality

### P1.12 Provider capability registry

Status: **Partial**

- Expose each provider's text/image/tool/stream/reasoning/effort/context/session
  capabilities from one registry.
- Populate model/effort controls dynamically when possible and keep curated
  fallbacks versioned.
- Avoid duplicate display entries across Luna/Codex/provider aliases.
- Distinguish API-key providers from local Codex-auth models without duplicate
  “Codex local” choices.
- Add safe credential diagnostics and provider-specific error messages.
- Give desktop users a normal browser OAuth flow for Beaver's dedicated Codex
  home, with in-product sign-in, account state, retry, and sign-out. Keep device
  codes only for genuinely headless installations.

Acceptance:

- The UI does not advertise unsupported effort/image/tool behavior.
- Adding a model normally changes registry data and adapter tests, not several
  hardcoded UI lists.
- Codex sign-in completes from Beaver and the browser without copying another
  Codex home's credentials or asking a desktop user to relay a device code.

### P1.13 Muse Spark live validation

Status: **Blocked**

The OpenRouter adapter exists, but the configured credential returns
`401 User not found`. Replace/fix the credential, then run harmless text,
reasoning, tool, streaming, and image tests through Beaver. Treat OpenRouter's
current US-only hosted-preview label as a distribution policy to verify, not an
inherent geographic property of the model. Evaluate a direct Meta endpoint
only if an official credential and terms are available.

### P1.14 Real multimodal legal-image tests

Status: **Partial**

- Run actual provider calls on scanned pages, exhibits, tables, stamps,
  signatures, diagrams, and mixed text/image PDFs.
- Compare full-page vision against deterministic crop/OCR/structure routing.
- Store image provenance and avoid sending unrelated pages.
- Measure tokens, latency, extraction fidelity, and hallucinated visual facts.

Acceptance:

- Vision is invoked only for images/pages that require it.
- Quoted visual text is grounded in an OCR/region artifact with page and box.

### P1.15 Role-aware onboarding and settings

Status: **Deferred**

Do not build this until Beaver has enough genuinely distinct litigator and
solicitor capabilities for a preset to change the product meaningfully.

- On first use, offer an optional account-free Beaver profile that asks what kind
  of legal work the user does and explains what the answer changes.
- Provide editable presets rather than permanent roles. A litigator preset can
  foreground Table of Authorities and case-research workflows; later solicitor
  presets should be based on implemented transactional workflows, not guesses.
- Add a normal Settings area where the same choices, defaults, providers,
  privacy controls, and local/cloud behavior can be reviewed or changed.
- Store local profiles under the shared AppData contract and keep cloud profile
  compatibility without requiring an account.
- Allow skipping onboarding and changing or resetting the profile at any time.

Acceptance:

- Onboarding is introduced only after at least two evidence-backed role presets
  produce materially different useful navigation or defaults.
- Presets never hide capabilities, hardcode a professional identity, or make
  account creation mandatory.

## Priority 2 — legal benchmarks and deployment gates

### P2.1 Benchmark inventory and licensing

Status: **Research**

Verify exact versions, licenses, access rules, leakage risk, jurisdictions, and
task fit for:

- the user-identified “Semantic Legal Bench by Marty Rudolf”;
- COLIEE;
- LegalBench and LegalBench-RAG;
- Canadian benchmarks such as 2CANLegalRAGBench if available under usable
  terms;
- US citation/retrieval/drafting benchmarks;
- Harvey's public Legal Agent Benchmark materials; and
- internal Beaver fixtures for exact evidence retention, document mutation, and
  long-running matters.

Do not claim comparison with Harvey's product unless the exact same hidden
system and evaluation conditions are available. Public LAB reproduction can
compare published methods, not private product performance.

### P2.2 Full-history vs compact-memory factorial

Status: **Planned**

Minimum controlled arms:

| Arm | Context | Directive |
| --- | --- | --- |
| A | Full history | Current Beaver prompt |
| B | Full history | Legal-safe concise/Caveman-lite |
| C | Exact ledger + summary + recent tail | Current Beaver prompt |
| D | Exact ledger + summary + recent tail | Legal-safe concise/Caveman-lite |

Add ablations from the independent research synthesis:

- no exact ledger;
- no recent verbatim tail;
- summary-only;
- provider-native continuation only;
- different compaction thresholds/reserve budgets;
- no durable tool receipts; and
- lexical versus optional semantic retrieval of prior evidence.

Hold model, effort, provider, tools, source corpus, prompt version, output
budget, and judge rubric constant.

Hard legal gates:

- exact quote and pinpoint fidelity;
- qualifiers, negation, exceptions, dates, defined terms, and party identity;
- conflicting authorities/evidence;
- accepted versus proposed edits;
- document/source version;
- pending user instruction;
- deterministic tool result and citation provenance;
- cross-matter isolation; and
- recovery after restart/provider-session loss.

Secondary metrics:

- task quality and human/blind legal score;
- input/output/cached tokens and dollar cost;
- latency and compaction frequency;
- tool-call count, wrong-tool rate, and source rehydration count; and
- summary drift over 40–80+ turns.

### P2.3 Caveman directive as an independent treatment

Status: **Research**

Do not enable an upstream “Caveman” prompt globally. First pin the exact
repository/version/license and test:

- upstream directive unchanged;
- a legal-safe variant that removes pleasantries/repetition but preserves
  qualifiers, quotes, citations, defined terms, uncertainty, and audit
  explanation; and
- no concise directive.

Adopt only the smallest phrasing that reduces output tokens without damaging
legal gates.

### Deferred experiment — legal-move ledger

Status: **Parked**

Do not implement or add this to the system prompt. The hypothesis is that a
small durable ledger of roles such as rule, fact, application,
counterargument, and conclusion could support genre-specific drafting and
compaction. Revisit only after the Markdown/DOCX path and structural benchmark
are complete, and only as an isolated same-model A/B against simpler
work-product instructions. This experiment is not a release gate.

## Priority 2 — release and safety work

### P2.4 Prompt injection and untrusted-document boundaries

Status: **Planned**

- Treat retrieved PDFs, opinions, legislation, journal articles, DOCX fields,
  OCR, metadata, and summaries as untrusted data.
- Mark source boundaries in model input.
- Prevent source text from authorizing tools, changing system instructions, or
  crossing matter boundaries.
- Add adversarial fixtures and verify that compaction does not promote an
  injected instruction into the durable exact ledger.

### P2.5 Cloud/local parity matrix

Status: **Partial**

Parity becomes an executable application contract under P0.0, not a checklist
that feature authors keep synchronized by hand. Instantiate the same Library,
projects, chats, workflows, tabular, document-version, legal-source, evidence,
pagination, and download behavior suites over temporary SQLite/files and real
local Supabase/object storage. Cloud-only authentication, account, sharing,
audit, and key-administration cases remain an explicit extension of that
matrix. Schema changes update both compiler-required data-port encodings in one
commit; local files never become cloud credentials.

### P2.6 Release evidence

Status: **Planned**

For each release record:

- exact commits for root and neutral subrepos;
- Node/Python/Codex/provider versions;
- clean install/bootstrap result;
- unit/integration/build/lint results;
- startup and browser smoke results;
- benchmark versions and medians;
- known blocked credentials/datasets; and
- migration/rollback notes.

### P2.7 Accessibility and assistive-technology gates

Status: **Planned**

Apply the current W3C WCAG 2.2 Level AA criteria throughout Beaver, the embedded
Table of Authorities workflow, Library viewers, document/action panels, and
durable graph artifacts:

- preserve semantic landmarks, headings, labels, names, descriptions, status
  announcements, and logical reading order;
- make every workflow operable by keyboard with visible, unobscured focus and
  predictable focus return from dialogs and dockable panels;
- meet contrast, target-size, zoom, 320-CSS-pixel reflow, text-spacing,
  reduced-motion, high-contrast, and non-colour-only communication needs;
- expose accessible alternatives for charts, legal ontology graphs, PDF/DOCX
  page viewers, citation highlights, progress, errors, and drag/reorder actions;
- keep account-free onboarding and authentication free of cognitive tests or
  redundant re-entry barriers; and
- run fast automated checks in normal development, then manually test critical
  paths with keyboard-only use, browser zoom/reflow, Windows high contrast,
  and at least NVDA plus one other screen-reader/browser combination.

Acceptance:

- Automated accessibility checks have no serious or critical violations on
  each primary route, with documented exceptions rather than ignored rules.
- A human can complete Library import/retrieval, assistant use, provider and
  effort selection, Table of Authorities import/review/build/download, and
  Settings using keyboard and a screen reader.
- Accessibility claims are not based on automation alone; W3C notes that tools
  cannot evaluate every accessibility requirement.

## Explicit non-goals

- No Beaver runtime dependency on ALR Quote Verifier. Its required independent
  rebuild is P0.11, not a module imported into Beaver.
- No graph database for the first ontology implementation.
- No vector database until a held-out retrieval win justifies it.
- No lossy summary as a legal source or replacement for raw history.
- No global Caveman directive before independent testing.
- No removal of cloud/Supabase compatibility.
- No reduction of useful warmup merely to make a build metric look better.
- No full-document model parsing when a deterministic exact lookup can answer.
- No second maintained Table of Authorities UI.
- No direct court login, fee payment, email submission, or CAMS automation in
  the first filing-package release.
- No durable copied case/article blob where a versioned pointer to bulk/cache
  data is sufficient.

## Execution sequence

1. **Make the contraction harness trustworthy**: freeze source/performance
   metrics, fix parallel SQLite cleanup, parameterize one application contract
   over both data-port adapters, and make generated artifacts stay out of
   source status.
2. **Canonicalize composition and durable work**: one runtime factory and
   persistence contract, local metadata database/blob store, shared
   document/version operations, and thin document/Library routes.
3. **Canonicalize assistant execution**: one turn runner, tool registry, event
   contract, and subagent path for local/cloud/project/tabular surfaces.
4. **Canonicalize product resources**: shared project, workflow, tabular, and
   chat behavior with mechanical SQLite/Supabase persistence encodings and the
   same automatically enumerated tests.
5. **Canonicalize document intelligence**: land the one-model/three-command
   legal-document stack above, finish SourceDoc/grid projections and one
   raw-preserving DOCX session, and delete each superseded bridge as callers
   move.
6. **Replace the browser runtime outright**: convert the complete route and
   deep-link inventory to Vite/React Router, serve it from the Express origin,
   retain bearer authentication, and delete Next/OpenNext, API-base/CORS
   topology, server-component rules, and their tests/configuration in the same
   slice.
7. **Close the contraction release**: reach **70,000 or fewer nonblank
   production lines**, converge frontend event/resource state, audit
   dependencies/experiments, publish performance receipts, and pass every
   local/cloud/release gate.
8. **Resume product backlog on the smaller architecture**: complete PDF job/OCR
   UX, evidence/viewer/DOCX/spreadsheet work, and provider breadth without
   recreating mode or assistant paths.
9. **Keep the consolidated documentation current**: the
   [documentation catalog](../README.md) separates shipping contracts, roadmap,
   experiments, and decisions; all Harvey Labs study material has one indexed
   folder.
10. **Benchmark before promoting context changes**: use the completed research,
   full-history control, exact legal-state gates, provider continuation, and
   isolation tests; promote only an earned candidate.
11. **Complete durable work products and release breadth**: ontology artifacts,
   Table of Authorities packaging, the first Alberta filing-package profile,
   curated examples, multimodal validation, cloud deployment evidence,
   accessibility, and measured retrieval additions.

## Requirement traceability

The consolidated backlog deliberately retains these user priorities:

- no accounts for local use, local storage first, cloud compatibility retained;
- one compiler-enforced local/cloud domain contract and automatically shared
  behavior suite, so ordinary feature work is implemented once;
- a substantially smaller codebase—at or below current upstream Mike's
  production footprint—without dropping Beaver capabilities or disguising
  moves as deletion;
- dynamic Codex models and full reasoning-effort range with a separate UI
  control and local Codex authentication;
- DeepSeek and Muse Spark provider support;
- sessions/caching/compaction comparable to Codex/OpenCode and official OpenAI
  guidance, evaluated rather than assumed;
- legal-specific auto-compaction that preserves exact evidence and reduces
  token use;
- Canadian/American legal benchmarks, Harvey-public-method comparison, and an
  independent Caveman treatment;
- deterministic work wherever a model is currently hand-rolling URLs,
  citations, document edits, spreadsheet reads, or repetitive structure;
- exact footnote/proposition/page/section/subsection/paragraph/subparagraph
  lookup and automatic native/text-fragment links;
- native provider structure first, reconstructed structure where absent, and
  lawful bulk data paths;
- `public_endpoint.db`, journal pinpoint links, optional vector retrieval, and
  A2AJ/CourtListener/TNA/GOV.UK/GovInfo support;
- a neutral weak-hardware legal PDF engine, selective Codex repair, degraded
  PDF exports, ALR DOCX ground truth, real model calls, and diverse legal-PDF
  testing;
- ALR independence with selective tested ports, not brittle coupling;
- one shared legal-data contract and reliable runtime dependencies;
- Table of Authorities as both a Beaver category and standalone GUI/CLI with one
  maintained browser UI;
- an Alberta filing-package builder that turns selected final Library versions
  into searchable, bookmarked, paginated, linked, size-bounded court PDFs plus
  a deterministic exceptions report, without filing them;
- a performant universal galley viewer using pointers to shared artifacts;
- multimodal image processing;
- durable legal-test/factor/application/commentary graphs and linked research
  memos;
- Beaver branding, maple leaf/red visual identity, visible assistant,
  non-duplicated models, and usable icons;
- optional role-aware onboarding plus an editable Settings area, deferred until
  litigator and solicitor presets can reflect real implemented capabilities;
- WCAG 2.2 AA as a cross-cutting release gate, including keyboard, reflow,
  contrast, reduced-motion, and manual screen-reader testing;
- reliable startup, working Library import, responsive UI, and dramatically
  shorter measured builds without harmful warmup cuts;
- curated example documents; and
- local git commits and reproducible release evidence.

## Detailed appendices

- [Canonicalization and contraction](contraction.md)
- [Scalable collections](collections.md)
- [Background PDF preparation](../current/background-jobs.md)
- [Standalone legal PDF parser](../../legal-pdf-parser/README.md)
- [Shared legal data and tool UI](shared-legal-data.md)
- [ALR independence decision](../decisions/alr-independence.md)
- [Session compaction/context efficiency](../decisions/session-context.md)
- [Pinpoint retrieval and vectors](../decisions/retrieval.md)
- [Deterministic/durable work audit](../decisions/durable-work.md)
- [Document mutation and content controls](../decisions/document-mutation.md)
- [ALR macro portability audit](../decisions/alr-macro-portability.md)
- [Legal ontology graph evaluation](../decisions/legal-ontology-graph.md)
- [Muse provider status](../decisions/muse-provider.md)
