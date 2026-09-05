# Application boundaries and change amplification

Status/order/gates: [master plan](master-plan.md). Finish the chosen architecture:
ordinary work touches its operation, an adapter only for storage changes, a domain
client/view and a behavior test. Follow the existing tabular application/thin-route
shape. Do not split cohesive code merely for size.

## Remaining cuts

1. Bind repositories, model settings, credentials, jobs and audit in `runtime.ts`;
   remove singleton fallbacks and update all callers per vertical cut. Account is
   the completed example: routes retain HTTP/MFA/OAuth/cookies/downloads; backend
   profile defaults are authoritative even after request failure. Optional cloud
   administration may report unsupported. No umbrella ports/container/runtime.
2. Extend document application/Library/projection owners for exact typed presenters,
   spreadsheet reads, evidence verification/rehydration, archives/download targets,
   supra repair and queued PDF reprocessing. Routes keep multipart, ETags/ranges,
   streaming, escaping and headers—not ownership/compiler/job policy. Preserve
   projectStore unless duplicated policy requires change. See [storage](document-versioning.md).
3. One Legal Source application over registry/store/projection/PDF bridge owns
   coverage/search/resolve/save, viewer shaping, PDF status and delete; legalLibrary
   routes retain HTTP, not provider/native-structure calls.
4. One public backend assistant event union spans engine/sink, persistence,
   transcript/store, queue/worker and SSE. Keep provider events distinct, validate
   durable-job JSON at entry. Retain bounded assistantStream; separate raw protocol
   schemas/limits/parser from normalized assistantSession reducer. Backend JSON
   fixtures must parse in frontend. No shared Zod runtime (v3/v4) or contract package.
   Then unify enqueue/worker preflight and inject route operations; retain one
   assistant hook/reducer/history context and provider adapters.
5. Extract only transport/error/JSON/blob/multipart/stream/pagination helpers to
   `api/client.ts`, reused by auth. Move entire endpoint families plus browser DTOs
   to chat/documents/tabular/workflows/account/projects/legalSources and justified
   smaller domains. Update all imports, delete beaverApi and displaced shared/types
   declarations. No barrels, compatibility exports or frontend persistence records.
   Keep citation presentation separate. Replace raw EventBlocks/WorkflowDetailPage
   URLs with named operations and hidden project-moved window events with explicit
   callbacks/context. Preserve directoryResource, usePagedDirectory/useDocumentFile,
   one router/Word adapter and callback-driven presentation.

## Workflows and features

Keep the cohesive Workflow route until a second backend consumer needs its rules.
The [catalogue](document-capabilities.md#product-vocabulary-and-workflow-catalogue)
projects existing definitions/drafts/jobs, not another persistence root. One
`GET /api/workflows?audience=&q=` includes system/user definitions, no separate
system fetch/client merge. Closed launcher union/switch; contextual canonical IDs,
not aliases. Keep pinned offline mike-workflows; deterministic refresh/`--check`
only when needed, reusing archive encoding rather than runtime downloading.

Explicit typed feature preferences gate profile/UI, catalogue/contextual entry,
tools and application operations. Disabling rejects new work, never deletes old
files/receipts. No feature registry or portable-feature lifecycle.

## Native/process truth

- Reconcile Git links, locks, bundles and checked-out HEADs (including OpenLegalData)
  through existing source measurement/structure guardrails, not another checker.
- One nativeContract reports boundary/features/structure/parser/Inspector/schema
  identities; validate once in structureNative. Type actual crossing variants and
  exercise Unicode/UTF-16 revision/fingerprint, lookup, PDF summary and identities.
- Gate structure, advance/gate parser's exact structure pin, then Beaver parser/
  addon together, including both Inspector Cargo locks and corpus denominators.
  Reject combinations different from those corpus-tested.
- Native loader owns no detector/semantic mirror. Rust/Python use direct bindings;
  delete the one-off JSONL bridge. Actual subprocess edges get one validated
  versioned envelope/fixture set, no generated SDK.
- [Work products](legal-work-products.md) replace Authorities iframe/stdio/Python
  browser/server/job/project runtime. Preserve shared Rust citation/PDF owners;
  do not harden the displaced gateway. Word executors share document receipts,
  not a generic plugin protocol.

## Completion

Trace callers, move policy once, update consumers, delete displaced paths, then
focused behavior/TypeScript/boundary checks. Retain explicit auth/bootstrap/process
exceptions, remove obsolete allowlists. Preserve transport boundary tests and
SQLite/Postgres common behavior. Measure production/tests/experiments separately
under the master budget; test outcomes, not internal choreography.

Stop when deployment is edge-only, domains singular, events typed end-to-end,
API contracts domain-local and routine changes no longer fan out across parallel
paths. Further rearrangement requires an observed problem.
