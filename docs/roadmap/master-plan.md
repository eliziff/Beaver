# Beaver master plan

Status: canonical hub for unfinished product work

Last reconciled: 2026-08-30

This is the only backlog authority. It records priority, status, and release
gates. Detailed execution belongs only in the active spoke plans linked below.
Current behavior belongs in `docs/current/`; durable reasoning belongs in
`docs/decisions/`. When a spoke is complete, move any lasting contract to the
current documentation and delete the spoke. Git retains the old plan.

## How to use this hub

- Add an item here only when Beaver has actually decided to build or evaluate it.
- Give a current workstream one spoke only when this hub is too small to execute
  it safely.
- A spoke may refine implementation order and tests but may not create a second
  product backlog.
- Mark completed work in the implementation commit, update the current contract,
  and remove its planning prose.
- The default implementation is deterministic, local-first, and small. A model
  is used only where judgment is necessary or a measured model lane wins.
- Beaver has no users. Replace obsolete designs outright; do not add migrations,
  compatibility paths, dual reads, or transition flags.

## Fixed architecture decisions

These are constraints, not backlog:

1. Account-free local mode and cloud/Supabase are two compositions of one
   application. Feature code never selects a deployment adapter.
2. Beaver is a modular monolith: one Vite/React application, one Express
   application/runtime, one assistant engine/tool registry, and one relational
   repository contract.
3. Local uses SQLite/filesystem/environment credentials. Cloud adds identity,
   Postgres/private object storage, sharing, MFA, audit, and account
   administration through injected adapters.
4. Immutable document versions, source hashes, exact locators, evidence,
   mutation manifests, and receipts are durable. Model prose is not authority.
5. `legal-structure` owns provider-neutral legal structure and citation
   grammars. `legal-pdf-parser` owns PDF extraction, geometry, OCR routing, and
   PDF witnesses. Beaver keeps no parallel TypeScript structure engine.
6. `documentProjectionService.ts` is the sole cross-format read host.
   Raw-preserving DOCX sessions, opaque native documents, PDF artifacts, and
   spreadsheet grids remain authoritative format objects.
7. Chat, subagents, and tabular review use the same turn, agent, job,
   cancellation, event, evidence, and persistence machinery.
8. Providers share one neutral search/resolve/read plane. Provider-native facts
   and lawful bulk data remain authoritative; vectors may propose candidates but
   never become sources.
9. Authorities has one maintained browser UI and engine used standalone and in
   Beaver. The Court Record Builder follows the same one-core/one-UI
   rule with thin local-file and Library adapters.
10. Optional built-in features are explicit static composition plus typed user
    preferences. There is no plugin runtime, registry, marketplace, UI schema,
    or lifecycle protocol.
11. The Word task pane is another route in the one frontend and uses the normal
    backend session, chat, tools, jobs, and document operations.
12. Accessibility is a product constraint. New and changed browser work targets
    WCAG 2.2 AA and native HTML before custom widgets.
13. Public subrepositories are pinned by Git links; `subrepos.lock.json` and
    guardrail receipts must agree with those pins. PDF Inspector remains one
    synchronized branch in `legal-pdf-parser`.
14. Workflows is the sole user-facing catalogue for repeatable legal work.
    General/Solicitor/Litigator/All are audience filters over one deduplicated
    set of coherent jobs. Assistant, tabular, deterministic-operation, and
    work-product launchers keep their existing execution owners; stages such as
    proofreading, citation linking, note-up, and quote-support review do not
    become duplicate catalogue features.

The concise current module map is
[Beaver architecture](../current/architecture.md).

## Current production baseline

The following exists and should be reused rather than rebuilt:

- one static Vite/React Router client served from the Express origin;
- anonymous local identity plus cloud cookie authentication and MFA;
- durable profiles/preferences, onboarding, model/reasoning choices, API keys,
  Library, projects, workflows, chats, document versions, and tabular reviews;
- one store-backed assistant turn engine, exact-name tool registry, durable turn
  queue, steering, interruption, compaction, read subagents, and client tools;
- Codex subscription auth plus OpenAI, Claude, Gemini, DeepSeek, OpenRouter,
  OpenCode Go, and local Ollama-style provider paths;
- provider-neutral legal lookup, durable evidence, deterministic native and
  text-fragment links, and a structured source viewer;
- deterministic PDF parsing with selective OCR and immutable projection
  artifacts;
- raw-preserving DOCX generation/editing/version primitives and a thin Word
  task pane;
- bounded cursor collections with SQLite search and the same local/cloud
  resource semantics;
- ordinary durable agents for tabular generation;
- the Authorities browser workspace, standalone host, private Beaver process
  channel, and Library submission operation; and
- source, boundary, grammar, focused behavior, build, and smoke checks.

`npm run measure:source` is the source-size authority. The pre-boundary-refactor
baseline was 69,783 first-party production lines. Phase 1 has a hard acceptance
target of at most 68,400 lines (about 2% contraction) and a practical stretch
target of 67,700 (about 3%). Tests are reported separately: deleting a test
cannot pay for production growth. Each vertical cut should be production-net-
negative unless a measured capability gain justifies its cost, and the phase
must meet the aggregate target without moving maintained behavior out of the
counted application roots.

## Active execution order

### 0. Close and verify the current upstream adaptation

Status: **complete (2026-08-29)**

Profile/onboarding, cookie authentication, OpenCode Go, model/reasoning
persistence, tabular agents, directory upload, Word client tools, and the
Authorities preference are adapted. All non-Word upstream items through Mike
PR #383 are recorded as `have` or `skip`; the remaining Word review items are
part of the document-capabilities spoke.

Gate:

- focused behavior tests pass;
- backend and frontend TypeScript/build checks pass;
- source boundaries pass; and
- no migration or compatibility machinery is introduced.

The semantic sync record is the
[Mike upstream review ledger](../decisions/upstream-mike.md).

### 1. Finish application boundaries and reduce change amplification

Status: **active**

Plan: [Application boundaries and change amplification](application-boundaries.md)

Work from the existing tabular route/application shape. The first cut extracts
Account/preferences/model settings from `routes/user.ts`, binds local/cloud
ports in the composition root, and removes deployment imports from feature
routes. **That Account cut is complete.** Next finish Document/Library and
Legal Source ownership, type the public assistant event path, partition the
frontend API by domain, and close the remaining process gateways. Do not invest
in hardening the current Python Authorities gateway: the durable-work-product
cutover below replaces that product path. Leave the cohesive Workflow route
alone until a second backend consumer needs its rules.

Gate:

- routine changes normally touch one operation, one adapter only when storage
  changes, one domain client/view, and one behavior test;
- routes do not import runtime, mode, relational, Supabase, provider, compiler,
  or job adapters except at explicit auth/bootstrap/process edges;
- local/cloud application behavior runs through the same operations; and
- no framework, generated SDK, compatibility barrel, or speculative interface
  is added; and
- first-party production is at most 68,400 lines, with 67,700 as the stretch
  target; test deletion is tracked separately and never offsets production.

### 2. Complete the shared legal-structure cutover

Status: **active**

Plan: [Shared document structure](document-structure.md)

Finish the literal Rust ports and direct consumers, preserve provider-native
facts, gate the actual engine combination Beaver ships, and delete every
parallel TypeScript semantic model or bridge. Reconcile the
`legal-structure`, `legal-pdf-parser`, PDF Inspector, grammar, guardrail, and
root Git-link identities so a clean checkout exercises the same engine that
passed the corpus gates.

Gate:

- instrument, digital-born PDF, full PDF lifecycle, provider, and registered
  capability corpora pass their distinct fidelity gates;
- the N-API boundary reports and validates its exact engine/schema identities;
- no live consumer uses a second structure representation; and
- production ingestion/query speed and memory do not regress.

### 3. Make document work and legal workflows first-rate

Status: **active after the safe handle kernel; independent structure work may
proceed in parallel**

Plan:
[Document capabilities, legal workflows, and portable features](document-capabilities.md)

The sequence inside the spoke is authoritative:

1. close the upstream Word prototype and establish the benchmark baseline;
2. replace text-as-locator editing with version/session-bound inspect, preview,
   apply, and review receipts;
3. implement the same compact operation language in the Library DOCX and live
   Office.js executors;
4. finish the Rust citation-occurrence record and automatic linking;
5. build deterministic quote verification with within-authority rescue, then
   optional adversarial proposition-support agents; and
6. expand formatting/OOXML breadth only in response to benchmark failures.

The ordinary citation-link default is the citation core plus separately linked
pinpoints. Users may instead link the observed style of cause and may disable
pinpoint links. A quote sharpens a link only when it verifies inside the stated
pinpoint; Verification may rescue a match elsewhere in the same authority but
linking may not.

Gate:

- exact targets, stale-receipt rejection, tracked review, idempotence, mutation
  manifests, and untouched-part preservation;
- token efficiency on simple edits and broad technical formatting coverage
  through capability loading rather than a huge tool schema;
- accepted occurrence/link/quote/support gold with scores kept separate; and
- no Word-only backend, model loop, store, cloud path, or second office suite.

### 4. Ship durable Court Records and Authorities work products

Status: **active; shared handle/persistence seams follow the boundary work,
while source/profile/UI work may proceed now**

Plan: [Durable legal work products](legal-work-products.md)

Turn the Court Records MVP and the existing Authorities product into two saved,
resumable work products over one small TypeScript model. Preserve the working
Authorities workflow and the existing Rust citation/PDF owners; replace only
the Python/iframe product shell and duplicate product state. Standalone and
Beaver use the same core and UI through local-file or Library adapters.
Inside Beaver, both are canonical entries under Workflows → Court and hearing
materials; their focused workspaces and standalone shells remain distinct.

The first release is exact for Alberta Court of King's Bench, Alberta Court of
Appeal, Federal Court, and Federal Court of Appeal records within the declared
profile inventory. It supports repeatable parties and intervenors, explicit
document slots, local file handles, latest-or-pinned Library versions, nested
draft outputs, deterministic refresh/build receipts, direct citation receipts,
and a user-initiated CanLII PDF handoff without automated CanLII retrieval. The
profile/source schema must admit BC later without another architecture.

Gate:

- every release profile has official-source provenance, real-document visual
  fixtures, exact structure/render tests, and a live Chrome workflow;
- drafts survive restart, expose missing/changed inputs, and rebuild exact
  dependency snapshots without a watcher or workflow graph;
- grounded citation receipts reach Authorities without reparsing document text;
- Authorities retains current behavior and has no Python product dependency;
- the standalone runtime remains compact, local-only, and usable offline; and
- the UI passes responsive screenshot, keyboard, screen-reader, WCAG contrast,
  load-time, and full end-to-end proof.

## Backlog after the active spokes

These items are approved, but they do not receive separate planning files until
they become current.

### Runtime and release reliability

- Complete page-first PDF preparation: upload returns before OCR, requested
  pages outrank background work, progress has stable activity IDs, and usable
  partial results survive failure.
- Exercise one application behavior suite over local SQLite/files and a clean
  local Supabase/object-storage deployment. Keep cloud-only account
  administration as an explicit extension.
- Reconcile subrepository Git links, locks, Cargo pins, native identities, and
  clean-checkout bootstrap. Authorities must use tracked parser bindings rather
  than sibling-source or ignored-package discovery.
- Make system-workflow generation reproducible from the pinned
  `mike-workflows` revision and validate exported workflow archives with the
  same format.
- Record release commits, runtime versions, bootstrap, tests/builds, browser
  smoke, benchmark versions/medians, and known external blocks.

### Legal sources, retrieval, and viewers

- Finish durable provider PDF/cache paths and exact locator/text-fragment
  fallbacks without model-authored URLs.
- Complete the universal legal galley viewer over shared artifacts and exact
  evidence.
- Expand provider breadth only through the existing search/resolve/read
  contract and provider fixtures.
- Improve lexical and working-set retrieval first. Add vectors only after a
  held-out legal retrieval win that includes latency, memory, and maintenance
  cost.
- Preserve journal, legislation, Hansard, Canadian, American, UK, and GovInfo
  source paths and their native structure.

### Legal knowledge artifacts

- Keep the reference-only [Research set contract](research-sets.md) on
  the stable WorkProduct, legal-source, and evidence primitives. Keep labels,
  queries, chat promotion receipts, and portable Markdown memos lightweight;
  do not create another document or source store.
- Add renderer-independent legal test/factor/application/commentary graph
  artifacts and linked research memos only after the underlying extraction and
  evidence contract is stable.
- Add curated example documents after the corresponding product paths are
  release-ready.

### Safety, accessibility, and measured research

- Treat retrieved documents, OCR, fields, metadata, and summaries as untrusted
  data that cannot authorize tools or alter system instructions.
- Verify keyboard operation, visible focus, 320-pixel reflow, contrast, text
  spacing, reduced motion, high contrast, status announcements, and manual
  screen-reader completion of primary workflows.
- Compare context/compaction changes against a full-history control while
  preserving exact evidence, provider continuation, and isolation.
- Evaluate attribute-first grounding, alternative prompt directives, dense
  retrieval, multimodal providers, and external document engines only through
  bounded comparisons. No production promotion or metered run is implied.
- Muse Spark remains blocked until a real provider contract and credentials
  exist. Role presets remain deferred until implemented capabilities make them
  materially useful.

## Release gates

Use the smallest focused check during each vertical slice. A complete release
candidate runs:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
npm run check:source-boundaries
npm run check:grammar
node docs/scripts/check-docs.mjs
.\scripts\mike.ps1 smoke
```

Corpus-scale legal-structure or PDF changes also run their applicable fidelity
gates. Word/document changes run the deterministic preservation and benchmark
lanes specified by the document-capabilities spoke.

The complete full sweep is never inferred from this plan and requires its
explicit authorization token.

## Explicit non-goals

- no account requirement for local use;
- no removal of cloud/Supabase support;
- no second local/cloud feature implementation;
- no plugin system, marketplace, microservices split, browser repository layer,
  or generated contract ecosystem;
- no second assistant, agent, tabular, Authorities, Affidavit Builder, or Word
  product stack;
- no raw OOXML, XPath, UNO, COM, Office.js object, or arbitrary XML patch exposed
  as a model tool;
- no graph database for the first ontology work;
- no vector database before a measured win;
- no summary used as legal authority;
- no full-document model parse where deterministic exact lookup suffices; and
- no court login, payment, email submission, or filing automation in the first
  filing-package release.
