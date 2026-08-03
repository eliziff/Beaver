# Beaver master plan

Status: canonical implementation plan
Last reconciled: 2026-07-26

This is the single source of truth for unfinished Beaver work. Earlier
planning files remain as design records and technical appendices; their status
lists are not authoritative where they differ from this file.

The plan consolidates the user's requests without turning every experiment into
a permanent subsystem. The default is a small deterministic implementation,
measured against the current Beaver baseline, with model calls reserved for
ambiguity that cannot be resolved reliably in code.

## Status key

- **Done**: implemented and verified in the current worktree.
- **Partial**: a useful implementation exists, but the requested end-to-end
  behavior or validation is incomplete.
- **Research**: investigated and documented; runtime behavior is unchanged.
- **Blocked**: implementation exists but an external credential, license, or
  dataset is unavailable.
- **Planned**: not implemented.

## Fixed architecture decisions

These decisions are not open backlog items:

1. Beaver supports an account-free local mode. Cloud/Supabase/R2
   compatibility remains available; local mode is additive, not a fork that
   deletes cloud support.
2. Provider downloads, bulk databases, and shared source caches live under the
   versioned `OpenLegalData` contract, normally
   `%LOCALAPPDATA%\OpenLegalProducts\LegalData`.
3. SQLite is the lookup/runtime format. DuckDB, PyArrow, and Parquet readers
   are optional import-time dependencies.
4. ALR Quote Verifier remains an independent product. Beaver does not import its
   private modules or require its checkout. Small algorithms and fixtures may
   be ported into neutral packages with parity tests.
5. `universal-legal-pdf-engine` is the neutral PDF structure package. Beaver,
   Table of Authorities Maker, ALR, and future applications consume thin
   adapters.
6. Exact evidence, document versions, source locators, hashes, and tool
   receipts are durable state. A prose session summary is disposable context
   and is never legal authority.
7. Exact lexical/pinpoint lookup hydrates authoritative source text. Dense
   vectors are an optional candidate-generation layer, not a source of truth.
8. Model choice and reasoning effort are capability-driven and dynamically
   enumerated where a provider exposes a catalog. Values such as `max` are not
   hardcoded away.
9. The browser UI is the maintained Table of Authorities UI used both
   standalone and inside Beaver. The Tk UI is a compatibility fallback, not a
   second product to redesign.
10. Legal ontology artifacts use renderer-independent JSON. A viewer is a
    replaceable projection, not the data model.
11. Accessibility is a cross-cutting product constraint. New and changed
    browser workflows target WCAG 2.2 Level AA and use native HTML before
    custom ARIA widgets.
12. Beaver remains a modular monolith with small provider/process boundaries.
    Extensibility comes from stable SQLite/JSON/CLI contracts and thin adapters,
    not speculative services, duplicate UIs, or one-implementation interfaces.

## Implemented baseline

The following work is complete enough to build upon and is not repeated as
backlog:

| Area | Current baseline |
| --- | --- |
| Local identity | Anonymous account-free startup, Library storage, and atomic durable chat transcripts under shared AppData |
| Assistant | Local Library tools work without the unavailable `mike_runtime` connector |
| Codex | Local Codex authentication, dynamic model catalog, separate reasoning-effort control, and bounded Beaver tool bridge |
| Providers | OpenAI, Claude, Gemini, Codex, DeepSeek, and an OpenRouter/Muse adapter |
| Legal lookup | A2AJ, CourtListener, TNA Find Case Law, GOV.UK ET, GovInfo, and journal article lookup surfaces |
| Pinpoints | Deterministic native anchors/text fragments, including multi-text directives, are appended without asking the model to construct URLs |
| Shared data | `OpenLegalData` SQLite/bulk contract and AppData layout; A2AJ and CourtListener bulk paths |
| Journal data | `public_endpoint.db` page/structure access and a contentless FTS5 sidecar |
| PDF core | Standalone deterministic digital-born parser, footnote/proposition artifacts, optional r=1 Codex repair, cache, diagnostics, and adapters |
| DOCX citations | Bounded deterministic citation splitting and hyperlink insertion with a Codex worker only for unresolved splits |
| Legal Library | Lightweight A2AJ/journal pointers and a structured source viewer |
| Table of Authorities | Shared data path, dependency bootstrap, browser UI, standalone host, and a Beaver sibling route |
| UI | Beaver name, maple leaf identity, red accents, flat text-presentation symbols, visible model control, and separate effort control |

The baseline still needs a clean local commit. “Implemented” here describes the
worktree, not release readiness.

## Priority 0 — correctness, reliability, and measured performance

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
  effort selection, first assistant message, and Table of Authorities launch
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

### P0.3 Account-free local parity

Status: **Partial**

Anonymous local mode currently covers Library and chat but not all project,
tabular, workflow, drafting, and mutation paths.

Work:

- Define which cloud entities have a local equivalent and store them under
  `apps/mike`, versioned and atomically written.
- Add local projects/project chats or explicitly merge the concept into
  Library matters; do not silently return empty project lists.
- Provide local drafting/revision, tabular review, and workflow behavior or
  hide a cloud-only surface with a clear explanation.
- Retain cloud adapters and test that local additions do not break them.

Acceptance:

- No ordinary local navigation ends in a Supabase 503.
- A local user can create a matter, import documents, chat, draft/revise a
  document, restart Beaver, and continue with unchanged versions and citations.
- Cloud mode passes its existing authentication/storage tests.

### P0.4 Freeze and commit the current baseline

Status: **Planned**

- Ignore Python bytecode and generated benchmark/runtime artifacts.
- Commit nested neutral repositories first, then record their exact local git
  identities in the root.
- Decide explicitly whether the nested repositories become true submodules or
  remain documented local gitlinks; do not leave ambiguous untracked
  directories.
- Create focused local commits without raw model traces, credentials, AppData,
  downloaded corpora, or temporary PDFs.

Acceptance:

- Root and nested status outputs contain only intentional ignored runtime
  artifacts.
- A fresh local clone/check-out has documented bootstrap steps and does not
  fail randomly for `duckdb`, PyMuPDF, Node, or Codex.

## Priority 0 — legal-safe context management and compaction

### P0.5 Independent research and falsifiable hypothesis

Status: **Research in progress**

Two agents are independently:

- comparing the proposed design with primary long-context/memory research and
  source code from existing systems;
- verifying current legal and long-session benchmarks, including the exact
  identity, access terms, and usefulness of the benchmark described as
  “Semantic Legal Bench by Marty Rudolf”; and
- proposing separate ablation experiments before their conclusions are
  reconciled.

Their reports will be:

- `context-compaction-research-track-a.md`
- `context-compaction-research-track-b.md`
- `context-compaction-research-synthesis.md`

No compaction strategy is promoted merely because a paper or framework reports
general-agent gains.

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

Status: **Research**

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

Implemented pre-live (2026-07-31): the address-mode tool surface now uses
one-hop task domains, keeps only navigation/basic mutation tools resident,
refuses guessed hidden calls, and refreshes schemas between tool-loop
iterations across provider adapters. Domain discovery returns names and
guidance, not duplicated schemas. With the full research catalogue enabled,
the serialized initial schema is 15,975 bytes versus 43,649 bytes for the
complete surface (63.4% smaller). This is an offline schema-size measurement,
not a tool-recall or legal-correctness result; the frozen live tasks remain the
gate for those claims.

Acceptance:

- A run can explain why compaction occurred and which exact state survived.
- Token reductions can be attributed to a measured component.
- Tool discovery/selection recall remains within the benchmark tolerance.

## Priority 0 — universal document structure in Beaver

### P0.8 Wire the universal PDF engine into Library ingestion

Status: **Partial**

The engine exists but Beaver does not consume it.

Work:

- On PDF import, store the source first, then create a durable background parse
  job with `queued`, `parsing`, `ready`, `degraded`, or `failed` state.
- Save a compact versioned page, paragraph, section, footnote/proposition,
  diagnostics, parser configuration, and repair source beside the immutable
  PDF. Do not persist geometry-rich parser working state.
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

Status: **Planned**

Expose compact tools for:

- one footnote or a bounded footnote range;
- the proposition(s) associated with each note reference;
- page or page range, including `[page n]` markers;
- paragraph or paragraph range;
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
  character loss. See [DOCX benchmark design](docx-benchmark-design.md).

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
- Model repair must improve a named structural metric without losing text,
  IDs, or source order.
- Complexity increases only for recurring failure classes with held-out wins.

## Priority 1 — provider-neutral legal retrieval and durable sources

### P1.1 Normalize all provider structure

Status: **Partial**

- Prefer provider-supplied sections, subsections, paragraphs, subparagraphs,
  pages, neutral citations, and anchors.
- Build stable structure where the provider omits it, using the proven
  A2AJ/ALR heuristics and universal PDF artifacts.
- Preserve distinct locator kinds even where a provider encodes them in one
  string.
- Test SCC/Ontario `#par`/`#sec`, A2AJ, CourtListener, TNA, GOV.UK ET,
  GovInfo, legislation, and journal article variants using a cross-provider
  fixture matrix.
- Record whether each locator is native, hybrid, heuristic, or model-repaired.

Acceptance:

- The model can request a section/paragraph/page by normalized locator without
  provider-specific URL logic.
- A wrong inferred locator fails closed or is labeled approximate.

#### P1.1a Execution: the SourceDoc consolidation (adopted 2026-07-27)

P1.1 is executed as one consolidation rather than per-provider patches.
Three audits (provider structure, link/anchor compatibility, performance —
2026-07-27, live-probed) traced thirteen structure defects, four hot-path
pathologies, and six duplication clusters to a single cause: no canonical
representation of a fetched source. Providers each grew a pipeline; consumers
re-derive structure from raw strings per call (measured: up to 21
full-document tokenizations per quote, ~62 s worst-case on a 256-handle DOCX
evidence resolve).

The design: one immutable, content-hashed artifact per fetched source.

```ts
type SourceDoc = {
  provider: "a2aj" | "courtlistener" | "tna" | "govinfo" | "govuk-et" | "journal" | "local-pdf";
  id: string; url: string | null;
  revision: string;            // content sha256 — cache key and staleness key
  text: string;                // ONE canonical rendition; no second exists
  tokens: WordSpan[];          // tokenized exactly once
  blocks: Block[];             // { kind, label, start, end, anchor?, origin: native|heuristic }
  index: Map<string, number>;  // normalized locator -> block
};
```

Providers become compilers into SourceDoc (~150–300 lines each: A2AJ
markdown, Harvard XML + star-pagination, Akoma Ntoso eIds, PDF artifacts,
journal rows). Everything else becomes queries over it: locator lookup is an
index hit, quote verification scans prebuilt tokens, pinpoint URLs come from
a host/anchor table (the Decisia predicate landed 2026-07-27) plus token-built
text fragments, one label formatter, one content-addressed cache sized in
blocks. Evidence-handle wire formats (mike-evidence:v1 family) are unchanged;
they verify against `revision + block + text hash`.

Stages, each gated on parity (byte-identical lookups and URLs against the
old path over the live-probed fixture corpus) before the old code is deleted:

1. **Gate first**: cross-provider fixture matrix from the audits' live
   probes (the P1.1 acceptance test that never existed). Includes the real
   federal A2AJ markdown shape (`**231** (1) …`) that the current
   `SECTION_MARK_RE` misses — today the entire laws-lois corpus has zero
   structure index.
2. SourceDoc core + A2AJ compiler. The compiler subsumes the audit's fix
   list: federal emphasis markers, truncation signalling on a2aj_fetch,
   locator ranges instead of bare counts, not_found vs unavailable, honest
   page-locator advertising.
3. Cut consumers over one at a time — lookup tools, pinpoint links, DOCX
   evidence resolution — deleting the old path per provider as its gate
   passes.
4. CourtListener (unify the divergent text renditions), TNA/GovInfo/GOV.UK
   ET/journals, local PDF.

Expected effect: the ~5,600-line provider/pinpoint/evidence stack contracts
to roughly 3,000 lines while the defect classes (divergent renditions,
duplicated quote gates, per-call retokenization) become impossible by
construction. Link-heavy answers drop from ~230 ms to ~35 ms of CPU
(measured on the tokenization-hoist prototype); worst-case evidence resolves
from ~62 s to seconds.

Explicitly not in scope: renaming persisted formats, changing evidence
handle wire shapes, adding dependencies, or building structure for
providers Beaver does not ship.

### P1.2 Durable provider cache and bulk paths

Status: **Partial**

- Add shared read-through caches with schema version, source checksum/ETag,
  fetch time, license/provenance, retry metadata, and atomic replacement.
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

- Replace verbose model-authored citation JSON with short evidence handles.
- Hydrate and verify exact quote spans on the server.
- Prefer native provider anchors; otherwise produce verified text fragments.
- Support multiple text directives for disjoint spans in one page/paragraph/
  section.
- Produce local galley-viewer links when an external URL cannot express the
  exact unit.
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

Status: **Four-way ablation complete; broader validation pending (2026-08-03)**

The fixed-Sol three-task result is recorded in
[Mike-plus-Grep four-way result](harvey-lab-mike-grep-four-way-results-2026-08-03.md).
No tested candidate won. Simple Mike-plus-Grep used 46.9% of upstream logical
tokens but scored 143/217 versus 150/217. Optional section/page fields were
never used by the two legal arms. The guided arm scored 153/217 but used 1.438x
tokens, below the preregistered decisive-quality threshold. The reconstructed
V5 handoff/checkpoint strategy scored 127/217 at 1.698x tokens.

Retire the optional-coordinate schema and the bundled research checkpoint,
evidence-union, fresh drafting handoff, forced compiler correction, reviewer,
and automatic context-refresh machinery from the candidate path. Preserve
exact evidence, hashes, versions, pinpoints, and receipts host-side, but expose
them on demand through ordinary tools instead of replaying them into context.

The next ablation starts from pinned upstream Mike and keeps one continuous
agent trajectory. It compares:

- upstream Mike;
- the measured Mike-plus-Grep efficiency frontier;
- pinned upstream Mike with only successful document generation made terminal,
  isolating the cost of its otherwise pointless post-generation replay; and
- discovery-first legal structure behind ordinary Grep/Read semantics, where
  the host returns verified locator metadata and executable paths after a
  match rather than asking the model to guess a legal coordinate.

Deterministic assistance must either apply a provably safe, version/hash-bound
fix with a receipt or emit a short, objective, actionable diagnostic. Broad
source-only anchor dumps, speculative term-drift lists, and compulsory repair
passes are not model context. Keep independent telemetry for every diagnostic
class so a non-contributing class can be removed.

Acceptance:

- Preregister nine diverse visible-development tasks, exact fingerprints, and
  one fixed judge before new model calls; reuse old cells only when every
  eligibility fingerprint matches.
- Hold Luna/high and the provider-reported default tier constant, inspect tool
  and schema traces before scoring, and treat scores as provisional derivative
  labels rather than human gold.
- Match or exceed pinned upstream accuracy with fewer logical tokens. Up to
  1.5x tokens is acceptable only for a broad, decisive quality gain with no
  task collapse.
- Attribute wins separately to terminal generation, continuous deliberation,
  host-resolved structure, and each deterministic diagnostic. Do not promote a
  bundle whose individual contributors have not earned their context, token,
  and latency cost.

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
route. See [DOCX live-model benchmark](docx-live-model-benchmark-2026-07-27.md).

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
| [Deterministic Word actions catalog](deterministic-word-actions-catalog.md) | **Complete** — classifies direct, bounded, preview-only, and judgment-dependent Word actions; runtime gaps below remain planned. |

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
- Render pages, sections, nested provisions, paragraphs, footnotes,
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
- **Done:** PDF source documents use `universal-legal-pdf-engine`'s canonical
  body/footnote/endnote adapter and can create a Book of Authorities. Inserting
  a table remains an explicit Word-only operation.
- **Done:** detection can explicitly use the neutral universal engine's cached
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

Acceptance:

- The UI does not advertise unsupported effort/image/tool behavior.
- Adding a model normally changes registry data and adapter tests, not several
  hardcoded UI lists.

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

Maintain a checked matrix for authentication, Library, projects, chats,
provider keys, document versions, legal sources, Table of Authorities, graph
artifacts, and downloads across anonymous local and cloud modes. Migrations
must be forward-safe and local files must never become cloud credentials.

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

- No runtime dependency on ALR Quote Verifier and no obligation to fork it.
- No graph database for the first ontology implementation.
- No vector database until a held-out retrieval win justifies it.
- No lossy summary as a legal source or replacement for raw history.
- No global Caveman directive before independent testing.
- No removal of Supabase/R2/cloud compatibility.
- No reduction of useful warmup merely to make a build metric look better.
- No full-document model parsing when a deterministic exact lookup can answer.
- No second maintained Table of Authorities UI.
- No durable copied case/article blob where a versioned pointer to bulk/cache
  data is sufficient.

## Execution sequence

1. **Preserve the baseline**: ignores, nested repo commits, root local commits,
   launcher/doctor, and one end-to-end local smoke flow.
2. **Finish the evidence layer**: Beaver PDF ingestion, exact structure tools,
   provider caches/locators, and compact evidence handles.
3. **Benchmark before changing memory**: independent synthesis, instrumentation,
   full-history baseline, compaction prototype, legal hard gates, and
   Caveman-separated factorial.
4. **Deploy context management behind a flag**: server-authoritative state,
   provider continuation, recovery, and isolation tests.
5. **Make document work deterministic**: DOCX linking benchmark, version-bound
   mutation primitives, content controls, and bounded spreadsheet operations.
6. **Complete durable legal work products**: universal viewer, ontology graph,
   Table of Authorities parity/packaging, and curated examples.
7. **Optimize measured bottlenecks**: frontend/runtime/build profiles and
   vector retrieval only where benchmarks justify them.
8. **Validate provider breadth/cloud parity and accessibility**: Muse
   credential, real multimodal calls, provider registry, migrations, WCAG
   gates, and release evidence.

## Requirement traceability

The consolidated backlog deliberately retains these user priorities:

- no accounts for local use, local storage first, cloud compatibility retained;
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

- [Beaver document intelligence](beaver-document-intelligence-plan.md)
- [Universal legal PDF engine](universal-legal-pdf-engine-plan.md)
- [Shared legal data and tool UI](shared-legal-data-and-tool-ui-plan.md)
- [ALR independence decision](alr-independence-and-shared-data-plan.md)
- [Session compaction/context efficiency](session-compaction-and-context-efficiency.md)
- [Pinpoint retrieval and vectors](pinpoint-retrieval-and-vector-embeddings.md)
- [Deterministic/durable work audit](deterministic-durable-work-audit.md)
- [Document mutation and content controls](document-mutation-token-efficiency-and-content-controls.md)
- [ALR macro portability audit](alr-macro-portability-audit.md)
- [Legal ontology graph evaluation](legal-ontology-graph-repo-evaluation.md)
- [Muse provider status](meta-muse-spark-provider.md)
