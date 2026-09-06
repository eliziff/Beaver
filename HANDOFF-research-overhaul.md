# Handoff — research sets / Sources workspace / Tabular Review overhaul (2026-09-06)

Session ran out of usage mid-orchestration. Nothing is committed. All work is
uncommitted in the working tree. Plan (approved by Eli, source of truth):
`C:\Users\elias\.claude\plans\https-chatgpt-com-s-cx-6a9d80087ff081919-zippy-badger.md`.

> Session-2 note (2026-09-06, Eli-directed): another session stashed this
> tree as `stash@{0}` ("local work before PR merges 1-4") to merge PRs 1–4,
> then completed the merges (HEAD `5219d2152`, stash popped, merge clean).
> Session 2 touched nothing in the repo; it verified Phase E truly
> unstarted, identified backend failure #2 (below), and collected the
> appendix at the bottom. This file is the only thing session 2 commits.

## State by phase

| Phase | Scope | Status |
|---|---|---|
| A | Backend research core (one-write highlight, note item, deterministic import `tabular/researchImport.ts`, `table()` rewrite, column→labels bridge, ontology + membership routes, schema v16 `library_labels_id`) | Done, tests green in its files |
| B | Backend tabular/chat (design endpoint `POST /tabular-review/design`, receipts `query_ids` + prior preload, propose semantics in `researchTableTool.ts` / `tabularContext.ts`) | Done, tests green |
| C | Frontend Sources workspace (`ResearchTree.tsx`, `ResearchPens.tsx`, `useSourceReader.ts`, highlight controller in `SourcesWorkspace.tsx`, Ctrl/⌘+Shift+H, `ResearchFileBar` rewrite, Organize composer deleted, `Insert citation`) | Done, 278 tests green, tsc clean |
| D | Frontend tabular (`ChoiceCards`, `ColumnList`, `ImportResearchSet`, `TableProposalReview`, `NewTRModal` steps + DesignBox, Chat/Sources dock in `TabularReviewView`, `Labels from this column`, `AddDocumentsModal` Sources tab, `FileDirectory` hides research docs) | Done, 85 tests green, tsc clean |
| E | Library integration (see brief below) | **Not started in code.** The Opus subagent was launched, read code only, and was stopped before making any Write/Edit call (verified: zero edits in its transcript; `git status` shows none of its files modified). Relaunch with the brief below. |
| F | Scripts, docs, gates, commits | Not started |

Combined C + D verified before E launched: `npx tsc --noEmit` clean;
`node scripts/check-typescript-surface.mjs` → `productionDead: []`,
`productionPrivateOnly: []`.

## Backend test run (last thing done)

`npm test` in `backend/`: 2 failed / 1105 passed.
Known failure: `src/lib/__tests__/relationalDatabase.test.ts:37` expects
`user_version 15`; Phase A bumped `LOCAL_SCHEMA_VERSION` to 16 → update the
assertion to 16. The second failing file is `src/lib/authoritiesImport.test.ts`
(1 failed) — FOREIGN, DO NOT TOUCH: another session rewrote it (renamed test
"coalesces same-decision reporters…", changed `authorityOrder`/`kind`
expectations). Leave it for its owner; if still red at gate time, record as
pre-existing/foreign. (A later full-suite run showing more failures is
invalid unless the tree is exactly the popped A–D state — one such run was
polluted by the mid-run stash/merge swap.)

## Cross-phase glue already applied by the orchestrator

- `backend/src/routes/chatEvidenceDurability.test.ts:160` and
  `backend/src/lib/__tests__/localAssistantTools.test.ts:243`: added
  `projects` / `library` / `preferences` deps to the app fixture.
- `components/shared/DocumentSidePanel.removal.test.tsx`: Phase C retargeted
  two assertions from `[data-label-layer]` to `[data-label-dot]`.

## Contracts (for E / F)

- `useSourcesWorkspace().highlight = { pen, setPen, armed, arm, registerReader(capture|null), run(): "saved"|"armed"|"none" }`;
  `HighlightCapture = { reference, locator: PassageLocator, quote }` exported from `components/legal/SourcesWorkspace.tsx`;
  pen persisted at `beaver.research.pen.v1:<fileId>`.
- Routes: `GET/POST /api/source-workspaces/ontology` (`project_id` / `{projectId}`),
  `GET /api/source-workspaces/membership?project_id=&document_ids=` (≤200),
  `POST /api/source-workspaces/:id/column-labels {reviewId, columnIndex}`,
  `POST /api/source-workspaces/:id/table {rows?, labelId?, …}` → `TabularReview`.
- Frontend API: `openWorkspaceTable` (`lib/api/researchFiles.ts`),
  `proposeColumnLabels`, `designTabularReview` (`lib/api/tabular.ts`),
  `tabularReviewPath(review)` (`tabularReviewRoute.ts`).
- ARIA (C): `Highlight` button `aria-pressed`; `role="group" aria-label="Pens"`;
  `role="searchbox" aria-label="Filter"`; `role="tree" aria-label="Labels and sources"`
  (preview `"Proposed labels"`); rows `"<Label>, N sources"` / `"Unsorted, N sources"`;
  search action `Highlight N as <pen>`, menu `aria-label="Label sources"`; memo toolbar `Insert citation`.
- ARIA (D): dock `aside aria-label="Assistant dock"`, tablist `Assistant panels`, tabs `Chat`/`Sources`,
  body `aria-label="Research collection"`; column menu `"<column> actions"` → `Labels from this column`;
  design textarea `aria-label="Describe the review"` + `Propose design`; import fieldset `Rows` with
  `Sources`/`Passages` `aria-pressed`, select `Pen`, primary `Create`; proposal region `aria-label="Proposed columns"`,
  `Accept changes` / `Keep existing`; Documents modal toggle Documents|Sources, list `aria-label="Sources"`.

## Remaining work (Phase F, in order)

1. Finish/verify E (brief below + session-2 appendix); fix
   `relationalDatabase.test.ts` version assertion; confirm the only other
   backend failure is still the foreign `authoritiesImport.test.ts`.
2. `scripts/test-tabular-review-browser.py`: Organize section (lines 102–133) is dead —
   replace with chat-driven proposal flow, Sources dock tab, Import shows `Labels`/`Note`
   headers; drop the unarranged branch. `scripts/test-sources-dock-browser.py`: highlight
   via `Highlight` button + Ctrl+Shift+H, tree assertions, `Pens`, no Search-target menu,
   Library page dock + `Label` row action.
3. Docs: `docs/current/behavior-contracts.md#sources-workspace`,
   `docs/roadmap/research-sets.md:21`.
4. Gates: backend `npm test`, frontend `npm test`, both builds,
   `.\scripts\mike.ps1 start` (isolated `MIKE_LOCAL_DATA_DIR`) + `smoke -WithAssistantDock`
   with screenshot inspection, both browser scripts, end-to-end flow from the plan,
   `node scripts/measure-source.mjs --json` vs baseline 95,506 (backend 51,606 / frontend 43,900).
5. Commit per phase with pathspecs: backend A+B; frontend C+D; E; F. NEVER stage
   other sessions' files: `backend/scripts/build_citator_graph.py`,
   `backend/src/lib/__tests__/caselawCitator.test.ts`, `backend/src/lib/__tests__/jobQueue.test.ts`,
   `backend/src/lib/authoritiesImport.test.ts`, `backend/src/lib/jobQueue.ts`,
   `frontend/src/app/hooks/useAssistantChat*.ts`, `frontend/src/app/lib/api/chat.ts`,
   submodules `legal-structure` / `legal-pdf-parser`, `research/fca-appellate-quash-motions/README.md`
   deletion, `authorities-handoff.zip`, anything under `experiments/`. The PR 1–4
   merge added more foreign files (authorities editor/host, `shared/pdf-annotations.*`,
   `scripts/test-authorities-highlights-browser.py`, `docs/authorities-highlight-editor.md`,
   …) — re-derive with `git status` before staging; when in doubt stage only
   the plan's phase Dirs. No push unless asked.
6. Final report to Eli with the line count.

## Phase E brief (relaunch as an Opus subagent; nothing of it exists yet)

Files: new `lib/api/ontology.ts` (`getOntologyWorkspace(projectId?)`,
`ensureOntologyWorkspace(projectId?)`, `getWorkspaceMembership(projectId?, ids)`),
new `hooks/useOntologyWorkspace.ts` (`{ id, ensure() }` from
`project.metadata.labelsResearchFileId` or `profile.libraryLabelsId`; add
`libraryLabelsId` to the frontend `UserProfile` type — it is missing),
`components/documents/DocTable.tsx` (one membership call per visible page;
`LabelDots` cell = stacked dots + names + muted "in N workspaces" only when N>0;
row actions `Label` (ensure ontology → add `{provider:"library",kind:"document",id,versionId}`
source → `ResearchLabelEditor` with `prepare`, mirror `LegalSourceViewer.tsx`) and
`Add to workspace…` (research-set picker → `source` action); toolbar filter by
label/workspace, hidden when no labels), `components/library/LibraryWorkspace.tsx` +
`components/projects/ProjectDocumentsView.tsx` (wrap in `SourcesWorkspace fileId={ontologyId}`
+ `ResearchWorkspaceHost`, pattern `LegalLibrary.tsx:85-100,600`),
`components/shared/DocumentSidePanel.tsx` (~547: `Highlight` button `aria-label="Highlight"`
`aria-pressed`, new `shared/useLibraryReaderCapture.ts` registering
`highlight.registerReader`; armed → `data-highlighter` + crosshair; pointer-up with
selection → `run()`; click `[data-legal-block]` while armed → whole block; Escape disarms;
saved passages as quotes), `views/PdfView.tsx` (page wrappers
`data-legal-block data-locator-kind="page" data-locator-value=<page label>`; confirm
label vs `backend/src/routes/documentsEvidence.test.ts:34-36`), `views/DocxView.tsx` +
`TextView.tsx` (root `data-legal-block data-locator-kind="document" data-locator-value="document"`).
Iconography: dots / lucide `Tag`, never `FolderSvgIcon`. Budget ≈ +190 net lines.
Tests: `DocTable.interaction.test.tsx` (labels shown; Label creates the ontology once
and adds the source), `DocumentSidePanel` (Highlight saves a PDF page selection with the
current pen in one request), `PdfView.test.tsx` (locator attributes).
Gates: `npx tsc --noEmit`, vitest on touched dirs, `node scripts/check-typescript-surface.mjs`.

## Working rules that applied

Opus 5 subagents for all delegated work (usage triage); pathspec-only staging;
no per-token API spend; no test-coverage criterion; replace designs outright,
no shims; Bash heredoc `\n` escape trap (use Write/Edit); smoke isolation only
via `MIKE_LOCAL_DATA_DIR`.

## Session-2 appendix (verified by reading code, complements the E brief)

- Backend E support is DONE, no backend work remains: `routes/sourceWorkspaces.ts`
  `GET/POST /ontology` (:43-50), `GET /membership` (:51-56),
  `POST /:id/column-labels` (:112-115), `POST /:id/table` with `rows`/`labelId`
  (:105-111); `sourceWorkspaceApplication.ts` `ontology()` (:396-415, race-safe),
  `membership()` (:418-448), `columnLabels()` (:349-381).
  `GET /user/profile` already returns `libraryLabelsId`
  (`userApplication.ts:63-75`; asserted in `researchViews.test.ts:195`).
- `lib/api/ontology.ts` sketch (match `researchFiles.ts` style — `segment`
  for path ids, `pagePath` for query; add URL-shape tests mirroring
  `researchFiles.test.ts`):
  `getOntologyWorkspace(projectId?)` → `GET /source-workspaces/ontology[?project_id=]`
  (returns `ResearchFile | null`); `ensureOntologyWorkspace(projectId?)` →
  `POST /source-workspaces/ontology {projectId}`; `getWorkspaceMembership(ids, projectId?)`
  → `GET /source-workspaces/membership?...` returning
  `Record<docId, { workspaces: [{id,title,sourceId}], labels: [{id,name,color,workspaceId}] }>`.
- `hooks/useOntologyWorkspace.ts`: `{ ontologyId, loading, ensure() }`; load via
  GET on mount/project change (pointer resolved server-side from
  `project.metadata.labelsResearchFileId` / `preferences.libraryLabelsId`);
  `ensure()` POSTs. Type additions: `Project.metadata?: { labelsResearchFileId?: string | null }`
  (`lib/api/projects.ts`), `UserProfile.libraryLabelsId: string | null`
  (`lib/api/account.ts`).
- DocTable is rendered by `LibraryWorkspace.tsx:188` and
  `ProjectDocumentsView.tsx:52`; row actions at `DocTable.tsx:~1118`.
  Capture pattern to mirror: `LegalSourceViewer.tsx:377-401`
  (`registerReader`, `wholeBlock`, armed pointer-up / block-click / Escape);
  source-prepare shape `LegalSourceViewer.tsx:400-410`;
  dock-host pattern `LegalLibrary.tsx:224-228,602-603`.
- DocTable must render inside `<SourcesWorkspace fileId={ontologyId}>`
  (nest-safe per `SourcesWorkspace.tsx:205-208`) to reuse `mutations`;
  membership fetch keyed on sorted visible ids, swallow errors to null.
- Reader/viewer constraint (`backend/src/lib/AGENTS.md`, Document projection
  boundary): `documentProjectionService.ts` is the only cross-format read API;
  no new hash/cache/store; `documentProjectionPdf.ts` is private; after
  touching PdfView run `npm run check:source-boundaries`.
- Suggested E/F pathspecs: E =
  `frontend/src/app/lib/api/ontology.ts frontend/src/app/hooks/useOntologyWorkspace.ts frontend/src/app/lib/api/projects.ts frontend/src/app/lib/api/account.ts frontend/src/app/components/documents/DocTable*.tsx frontend/src/app/components/library/LibraryWorkspace*.tsx frontend/src/app/components/projects/ProjectDocumentsView*.tsx frontend/src/app/components/shared/DocumentSidePanel.tsx frontend/src/app/components/shared/views/PdfView*.tsx frontend/src/app/components/shared/views/DocxView*.tsx frontend/src/app/components/shared/views/TextView.tsx* frontend/src/app/components/shared/useLibraryReaderCapture.*`;
  F = `scripts/test-tabular-review-browser.py scripts/test-sources-dock-browser.py docs/current/behavior-contracts.md docs/roadmap/research-sets.md`.
  Line budget: baseline 95,506 (backend 51,606 / frontend 43,900).
