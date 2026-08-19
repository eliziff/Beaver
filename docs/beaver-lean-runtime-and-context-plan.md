# Beaver lean runtime and context plan

This is the single execution plan for frontend reduction, the static-shell
experiment, session compaction, caching, and the measurements that decide
whether either approach ships. `beaver-master-plan.md` remains the priority
and acceptance-gate authority; the other linked notes are evidence and design
detail, not competing work queues.

## North star

Beaver is a local-first modular monolith that feels instant on weak hardware:
one UI implementation, one resource/event path, one document model, and one
provider-neutral context contract. Local SQLite/AppData is canonical. Cloud and
Supabase remain supported as lazy persistence/auth/storage adapters, not as a
second application. Delete code before adding abstractions.

## Hard constraints

- Keep account-free local mode, cloud/Supabase mode, Hansard, legal evidence,
  pinpoints, hashes, receipts, and document-version semantics.
- Do not import Supabase, R2, heavy viewers, Authorities, graph, or tabular
  code into a route that does not use it.
- Keep useful warmup when it improves first interaction; a smaller build is not
  a win if first token, legal lookup, upload, or warmed navigation regresses.
- Do not preserve superseded compatibility paths or build a generic repository,
  cache service, desktop wrapper, or second backend without a proven caller.
- Exact legal state is durable and authoritative; summaries, provider sessions,
  embeddings, and caches are replaceable projections.

## Decisions from the existing research

### Frontend architecture

First finish measured in-place reductions. In parallel, a disposable static
React/Vite shell may be built as a clean-room experiment. It replaces Next only
if it achieves all gates below on the same machine and fixtures. A failed slice
is deleted; Beaver must not carry two permanent UIs.

The experiment keeps the existing REST/SSE API, runtime API configuration,
SQLite/AppData contract, cloud adapters, and legal viewers. It uses native
browser routing, forms, dialogs, popovers, and CSS where sufficient; one
resource cache; one SSE reducer; and bounded route chunks for heavy viewers.

### Session context and compaction

The control is full history. The candidate is a provider-neutral projection:

1. exact matter/document ledger (versions, instructions, defined terms,
   assertions and status, quotes, pinpoints, evidence IDs, receipts, pending
   decisions, and artifact hashes);
2. replaceable short task summary (objective, completed work, unresolved
   issues, rationale); and
3. bounded recent verbatim tail plus only the evidence needed for this turn.

Compact against the estimated assembled request, reserve output/tool headroom,
and record what was retained or omitted. Provider-native continuation or
compaction is an optional transport optimization, never the legal source of
truth. The research fixture's initial amortization rule is four remaining
responses; re-measure before changing it. Do not use a prose summary as the
sole store for legally material facts.

### Caching

Compaction and caching are separate. Add Beaver-owned, content-addressed local
caches first: parsed document, chunks, embeddings, retrieval result, citation
validation, and rendered preview. Keys include source/config/model/index
versions. Every hit, miss, avoided call, invalidation, and elapsed time is
observable. Add one provider prompt-cache adapter only after the assembler and
prefix boundary are stable.

## Execution order

### 1. Measure the control

Use one trace format for build, bundle, startup, route, first-token, legal
lookup, upload/view, layout shift, and context experiments. Pin commit,
dependency lockfile, provider/model/effort, prompt/config hash, fixture/source
hashes, retrieved IDs, token counts, cache fields, latency, retries, output and
artifact hashes. Keep raw outputs and never claim a development fixture is
unseen.

### 2. Continue strict in-place cuts

- Remove dead helpers, duplicate formatters/icons, inert CSS utilities, and
  unused route/client boundaries.
- Keep one shared document/viewer selection path and one resource/event reducer.
- Keep growing collections searchable and incrementally rendered, never in
  dropdowns.
- Preserve stable first-frame geometry, bounded human-scale widths, Escape
  behavior, and zero horizontal shell scrolling.
- Delete any tranche that increases production JS/CSS, authored source,
  startup, or representative interaction latency without a larger measured
  risk reduction.

### 3. Build the static-shell spike

Port only Assistant and Library first, then Authorities, Projects, and Tabular
Review, then viewers and automations. Keep the existing client as rollback
until every slice passes. Do not remove Next/OpenNext or add a desktop wrapper
until the full gates pass.

### 4. Add legal context machinery behind one switch

Create the append-only event log, exact matter-state schema, prompt manifest,
bounded retrieval-tail assembler, and provider-neutral continuation IDs. Keep
full history as the default while the candidate is benchmarked. Bound tool
results behind durable handles and isolate matters/clients by default.

### 5. Add caches and provider optimizations

Implement local content-addressed caches and invalidation tests. Then add
prompt-prefix caching for the provider Beaver uses most. Add more providers
only after the first adapter produces a measured cost or latency win.

## Ship gates

### In-place changes

- Full backend/frontend tests and production builds pass.
- Local and cloud paths remain available; normal local startup does not import
  cloud-only SDKs.
- No regression in first assistant token, Library open/upload/view, legal-source
  lookup, warmed Authorities, or document fidelity.
- Wide, narrow, 200% zoom, and 320 CSS-pixel filmstrips show zero shell
  overflow, clipped controls, pop-in, or interaction-induced bounding-box
  movement.
- Before/after measurements use the same machine, command, fixture, and cache
  state.

### Static-shell replacement

The spike must show at least 40% fewer authored UI lines, 30% less production
JavaScript, and 50% faster clean builds, with no first-token, warmed-navigation,
upload/view, accessibility, layout-shift, or local/cloud regression. Otherwise
delete it and keep the in-place implementation.

### Context/compaction promotion

Against the same model and settings, the candidate must preserve every exact
state invariant (newer instruction, current document version, citation/quote/
locator, disputed fact status, jurisdiction, and law-as-of date), show no
material LongMemEval or legal-benchmark loss, and reduce input tokens by an
initial 25% target without unacceptable latency or review-cost regression.

## Explicit non-goals

- No new general evaluation platform, composite score, custom legal model, or
  large test corpus before existing suites and traces are exhausted.
- No Redis/separate cache service while local storage is adequate.
- No migration of neutral PDF algorithms into Beaver-specific code; keep the
  universal PDF engine contract independent.
- No compatibility shims for zero-user legacy paths.

## Evidence and detailed notes

- [Codebase compaction](codebase-compaction-plan.md)
- [Static shell experiment](static-shell-rewrite-plan.md)
- [Session compaction audit](session-compaction-and-context-efficiency.md)
- [Compaction research synthesis](context-compaction-research-synthesis.md)
- [Minimal context/cache evaluation](beaver-minimal-evaluation-context-plan.md)
