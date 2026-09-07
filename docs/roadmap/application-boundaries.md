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
2. Extend document application/Library/projection owners for archive policy and
   supra repair. Exact document presenters, spreadsheet reads, evidence
   verification/rehydration, download targets and queued PDF reprocessing now use
   those owners; directory and tabular consumers share batched document metadata.
   Routes keep multipart, ETags/ranges, streaming, escaping and headers—not
   ownership/compiler/job policy. Preserve projectStore unless duplicated policy
   requires change. See [storage](document-versioning.md).
3. Unify enqueue/worker preflight and inject route operations. Retain the typed
   backend event owner, bounded assistantStream, separate assistantProtocol
   boundary, normalized assistantSession reducer and shared JSON contract fixtures.
   Keep provider events distinct and validate durable-job JSON at entry. No shared
   Zod runtime (v3/v4) or contract package; retain one assistant hook/reducer/history
   context and provider adapters.

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
- [Authorities](../current/authorities.md) now uses the shared TypeScript application
  in standalone and Beaver hosts. Do not recreate or harden the displaced
  iframe/stdio/Python product gateway. Preserve Rust citation/PDF owners and close
  the remaining [work-product parity and host gates](legal-work-products.md).
  Word executors share document receipts, not a generic plugin protocol.

## Completion

Trace callers, move policy once, update consumers, delete displaced paths, then
focused behavior/TypeScript/boundary checks. Retain explicit auth/bootstrap/process
exceptions, remove obsolete allowlists. Preserve transport boundary tests and
SQLite/Postgres common behavior. Measure production/tests/experiments separately
under the master budget; test outcomes, not internal choreography.

Stop when deployment is edge-only, domains singular, events typed end-to-end,
API contracts domain-local and routine changes no longer fan out across parallel
paths. Further rearrangement requires an observed problem.
