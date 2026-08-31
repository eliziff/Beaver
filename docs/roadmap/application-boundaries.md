# Application boundaries and change amplification

Status: active implementation plan

Date: 2026-08-29

This is the concrete whole-application maintainability plan. Its goal is not a
new architecture. It finishes the architecture Beaver already chose: one
application program, local/cloud composition at the edge, deep domain
operations, thin routes, and frontend clients grouped by the resource they
serve.

Success means an ordinary feature normally changes its owning operation, one
adapter only when stored data changes, its domain client or view, and one
behavior test. It should not require synchronized edits to deployment branches,
global route modules, several event representations, or a 930-line API grab bag.

## Non-goals

- No general contracts framework, OpenAPI/code generation, plugin runtime,
  service container, event bus, repository layer in the browser, or new
  dependency.
- No shared Zod package. The backend currently uses Zod 3 and the frontend Zod
  4; runtime decoding remains at each trust boundary.
- No compatibility barrels, legacy aliases, dual routes, migrations, or
  transition flags. Move one complete vertical slice and delete its old path.
- No splitting merely because a file is large. A move must establish one owner
  for independently changing behavior or delete duplicated knowledge.
- No rewrite of `documentApplication`, `ChatApplication`, the tabular
  application, the turn engine, `directoryResource`, or the Word adapter. They
  are foundations to finish routing through.

## Reference shape

Use the existing pair below as the boring example:

- `backend/src/lib/tabular/application.ts` owns input contracts, product rules,
  jobs, result shaping, and repository use.
- `backend/src/routes/tabular.ts` authenticates, parses, calls one operation,
  and writes JSON or a download.

Do not create a base application class or common router builder from it.

## Current seams

| Area | Existing owner worth keeping | Remaining amplification |
| --- | --- | --- |
| Composition | `backend/src/runtime.ts` | Applications are constructed lazily, but several repositories, jobs, routes, and settings still fall back to globals. |
| User/profile/settings | `userApplication.ts`, `userPreferences.ts` | Complete: the route owns HTTP/MFA/OAuth mechanics; runtime injects preferences, credentials, optional cloud administration, deletion, exports, and connectors. |
| Documents/Library | `documentApplication.ts`, `libraryStore.ts`, `documentProjectionService.ts` | Routes still own projection, archive, evidence, deterministic-action, and PDF-job decisions. |
| Projects | `projectStore.ts` | Mostly routed correctly; retain it and move only duplicated ownership or document policy. |
| Workflows | `workflowRepository.ts`, `systemWorkflows.ts`, `routes/workflows.ts` | No deployment branch or duplicated backend consumer. The route is long but cohesive; keep it until another consumer needs one of its rules. |
| Chat | `chatApplication.ts`, `chatStore.ts`, `turnEngine.ts` | Route, queue, worker, transcript, and store still pass or inspect partly untyped public events and repeat some turn preflight. |
| Tabular | `tabular/application.ts` | Good shape; model settings, jobs, and audit still have global/deployment leaks. |
| Legal sources | provider registry, `legalSourceStore.ts` | `routes/legalLibrary.ts` performs provider resolution, native-structure decisions, viewer shaping, PDF work, and persistence orchestration. |
| Authorities | `authoritiesWorkspaceApplication.ts` | Durable drafts, source resolution, attachments, and builds use the work-product and document operations. |
| Frontend transport | `frontend/src/app/lib/beaverApi.ts` | 930 lines, 134 exports, and 62 production importers combine transport and every resource family. |
| Frontend resource types | `frontend/src/app/components/shared/types.ts` | 398 lines and 65 production importers mix wire resources, assistant/UI state, and citation presentation. |
| Assistant frontend | `assistantStream.ts`, `assistantSession.ts`, `useAssistantChat.ts` | One real reducer exists, but raw protocol schemas and normalized UI state are mixed and overlap types elsewhere. |

## Phase 0 — close the current baseline

Status: complete (2026-08-29)

Before structural movement, finish the already-started upstream adaptations and
obtain one buildable baseline for profile/onboarding, HttpOnly authentication,
OpenCode Go, model/reasoning persistence, tabular agents, directory upload,
Word client tools, and the thin Authorities application.

Do not broaden those features while closing the baseline. Fix compilation and
public behavior, run focused tests, backend/frontend TypeScript builds, and
`npm run check:source-boundaries`, then begin the boundary cuts below.

The semantic upstream cursor and dispositions remain in
[`docs/decisions/upstream-mike.md`](../decisions/upstream-mike.md). It is a
ledger, not another backlog.

## Phase 1 — make composition real, starting with Account

### 1.1 Bind data ports at construction

Keep `backend/src/runtime.ts` as the composition root. Do not add an umbrella
`DataPorts` interface, service container, token registry, or second runtime.
Bind one repository or deployment capability while moving one complete
vertical slice: update all callers, delete its singleton fallback, and keep the
build green. Add a factory only when a real local/cloud composition or focused
test needs it. Preferences are the first completed example.

### 1.2 Extract the Account application

Status: complete (2026-08-29)

`backend/src/lib/userApplication.ts` now owns the account operation extracted
from the former route-local `AccountApplication`; `routes/user.ts` retains the
profile schemas, auth/MFA, OAuth return, status codes, and download headers.

The operation receives plain dependencies:

- `UserPreferencesRepository`;
- a credential accessor with local environment and cloud user-key adapters;
- optional cloud account administration for MFA, user lookup, deletion, and
  privacy exports;
- existing resource deletion/export operations;
- connectors and audit as injected capabilities.

Then:

- replace the singleton `userRouter` with `createUserRouter(userApplication)`;
- keep trusted-origin, MFA middleware, cookies, status codes, HTML OAuth return,
  headers, and download streaming in routes;
- remove imports of `runtime`, `isLocalRuntime`, Supabase, relational adapters,
  cleanup, and export builders from `routes/user.ts`;
- make `backend/src/lib/userSettings.ts` a pure resolver over preferences and
  credentials, or delete it into `userApplication.ts` if it has no independent
  caller;
- inject model settings into chat-title, tabular, and the models operation;
- expose feature preferences, including Authorities, in the profile DTO; and
- make backend profile defaults authoritative. The browser must not fabricate a
  competing profile after a failed request.

Cloud-only account operations may be absent and return an explicit unsupported
result. That is capability composition, not a local/cloud feature branch.

### Phase 1 gate

- `routes/user.ts` contains no mode, runtime, database, or Supabase import.
- The same preference behavior test runs over SQLite and Postgres repository
  factories; cloud-only administration has focused adapter tests.
- `routes/models.ts`, chat, and tabular obtain settings through the injected
  operation.
- Remove `routes/user` and `lib/userSettings` from the deployment allowlists in
  `scripts/check-source-boundaries.mjs` when their imports disappear.
- The Account cut is first-party-production-net-negative. The wider contraction
  target remains at most 68,400 production lines from the 69,783 baseline, with
  67,700 as the stretch target. Test lines are reported separately and cannot
  offset production growth.

## Phase 2 — fix resource ownership where it reduces amplification

### 2.1 Workflows

Status: extend the existing owner in place; no application-layer extraction.

`routes/workflows.ts` is the only backend consumer of its presentation,
sharing, catalogue, and export rules. Wrapping those rules in a
`workflowApplication.ts` would move code without removing a branch, duplicate,
or dependency. Keep the route, repository, and optional collaboration adapter
as they are. A long cohesive route is cheaper than a one-consumer service.

Make that route/catalogue the one discovery owner for assistant instructions,
tabular-result variants, deterministic document stages, and explicit
work-product launchers. The catalogue is a projection, not a new persistence
root: instruction definitions remain in the workflow repository; Authorities
and Court Records remain in the work-product repository; runs remain in their
existing job stores. Use one closed launcher discriminator and an explicit
switch rather than a registry or generic runtime.

Each catalogue definition has one ID, one canonical category, applicable
General/Solicitor/Litigator audiences, and optional result variants. Replace
the assistant/tabular/system navigation taxonomy, `General Transactions`, and
duplicate written/table definitions outright. Contextual launch points bind a
resource to the same definition rather than manufacturing an alias workflow.
One `GET /api/workflows?audience=&q=` response returns system and user-created
definitions together. There is no separate system endpoint or client merge.

The checked-in system catalog remains an offline snapshot of the pinned
`mike-workflows` Git link, with its provenance recorded in the upstream ledger
and guardrails. Do not add a runtime downloader. If a future catalog refresh
needs repeatable transformation, add the smallest deterministic `--check`
command then and share only the archive encoder it actually reuses.

### 2.2 Documents and Library

Extend `createDocumentApplication`; do not add a second document service.

- Make its document/version presenters exported and exactly typed instead of
  returning `Record<string, unknown>` intersections.
- Add focused operations for spreadsheet projection, evidence
  verification/rehydration, multi-document archive preparation, and shared
  download targets.
- Route supra inspection/fix and PDF reprocessing through Library/document
  operations with the existing job queue injected.
- Preserve `documentProjectionService.ts` as the only cross-format read host.

`documentRoutes.ts` and `library.ts` keep multipart parsing, ETags, HTTP range
or stream handling, HTML escaping, and response headers. They stop deciding
document ownership, compiler choice, job policy, or public DTO shape.

`projectStore.ts` already owns project/document rules. Leave it alone unless a
specific route path duplicates one of those rules.

### 2.3 Legal sources

Add one `backend/src/lib/legalSourceApplication.ts` composed from the existing
provider registry, `legalSourceStore.ts`, `documentProjectionService.ts`, and
provider PDF bridge.

It owns coverage, search, resolve/save, viewer payloads, PDF status, and delete
operations. `routes/legalLibrary.ts` keeps query parsing, conditional HTTP,
status codes, and response headers. It no longer imports provider adapters or
`structureNative` directly.

### Phase 2 gate

- Workflow behavior remains single-owned, with no local/cloud branch or copied
  presentation/export rule.
- Document/Library routes contain HTTP mechanics but no provider/compiler/job
  selection.
- Public resource presenters have exact types and one backend owner.
- Existing route and application behavior tests pass without tests asserting
  internal call choreography.

## Phase 3 — type the assistant path without inventing a framework

Keep provider-internal events separate. Define one backend public assistant
event union used by:

- `turnEngine.ts` and `EventSink.emit`;
- `chatApplication.ts` persistence;
- `chatTranscript.ts` public projection;
- `chatStore.ts` assistant content;
- `chatTurnQueue.ts` and `chatTurnWorker.ts`; and
- SSE framing in `routes/chat.ts`.

Validate raw durable-job JSON once when it enters that boundary. Replace string
whitelists and `unknown[]` only along this public path.

Keep `frontend/src/app/lib/assistantStream.ts` as the bounded SSE reader. Split
`assistantSession.ts` only along its real seam:

- `assistantProtocol.ts` owns raw Zod schemas, inferred wire types, limits, and
  `parseAssistantProtocolEvent`;
- `assistantSession.ts` owns normalized presentation state and its reducer.

Use a small set of backend-emitted JSON fixtures that the frontend parser must
accept. Do not share Zod runtime code or create a repo-wide contracts package.

After the event union is stable:

- make one chat preflight operation serve both enqueue and the durable worker;
- let `createChatRouter` receive the route-facing chat operations and typed
  stream while retaining HTTP/SSE framing; and
- keep `useAssistantChat`, the reducer, `ChatHistoryContext`, and provider event
  adapters singular.

## Phase 4 — partition the frontend API by real domains

First extract transport only to `frontend/src/app/api/client.ts`:

- `BeaverApiError`, `apiFetch`, JSON/blob/multipart/stream helpers, `Page`, and
  `pagePath`;
- make `authApi.ts` reuse the same error/request path; and
- update `frontend/scripts/transport-boundary.test.mjs` rather than replacing
  the existing boundary check.

Then move one complete endpoint family at a time, update every caller, and
delete its old declarations from `beaverApi.ts` in the same slice:

1. `api/chat.ts`;
2. `api/documents.ts` (including `directoryResource` and named download
   operations);
3. `api/tabular.ts`;
4. `api/workflows.ts`;
5. `api/account.ts`;
6. `api/projects.ts`;
7. `api/legalSources.ts`;
8. small `models`, `audit`, and `authorities` modules where warranted.

Use direct imports. Add no `api/index.ts` barrel and no compatibility re-exports.
Delete `beaverApi.ts` when the final family moves.

Move browser resource types with their domain clients as each slice moves:

- documents and projects with their clients;
- `ColumnConfig`, review, and cell DTOs with tabular;
- workflow DTOs with workflows, importing `ColumnConfig`;
- profile, key, feature, and model DTOs with account; and
- citation presentation helpers to a presentation module, not an API contract.

Delete those declarations from `components/shared/types.ts`. Do not import
backend persistence records into the frontend.

Preserve these existing primitives:

- `directoryResource`, `usePagedDirectory`, and `useDocumentFile`;
- one `useAssistantChat` and one reducer;
- one router and the thin Word adapter;
- the current Authorities launch route as a parity baseline until the
  work-product cutover (the iframe itself is not a durable primitive); and
- presentation components that already receive behavior through callbacks.

Remove raw endpoint construction from `EventBlocks.tsx` and
`WorkflowDetailPage.tsx` by adding named client operations. Replace the hidden
`beaver:chat-project-moved` window event with an explicit context operation or
callback.

### Phase 4 gate

- No production import of `beaverApi.ts` or `components/shared/types.ts` remains;
  both files are deleted.
- Each client module contains one resource family plus its exact browser DTOs.
- Runtime validation remains at config, auth, and assistant stream trust
  boundaries.
- The transport boundary test, focused component tests, frontend TypeScript,
  and production build pass.

## Phase 5 — close process gateways and feature composition

### Pin and native-contract truth

Before changing another cross-language consumer, make the checked-out engine
combination mechanically knowable:

- reconcile `subrepos.lock.json`, the root Git links, available bundles, and
  checked-out HEADs, including the current OpenLegalData mismatch;
- update `scripts/measure-source.mjs` and
  `scripts/legal-structure-guardrails.json` rather than adding a parallel pin
  checker; include `legal-structure`, both PDF Inspector Cargo-lock pins, and
  the current grammar corpus denominators;
- add one small `nativeContract()` export to
  `native/legal-structure-node/src/lib.rs` containing the boundary version,
  enabled features, `legal-structure` identity, PDF parser/Inspector identity,
  and public schema versions;
- validate that object once in `backend/src/lib/structureNative.ts` before
  returning the addon; and
- type the actual Rust request variants in TypeScript and add one Unicode/UTF-16
  fixture that exercises revision/fingerprint, bounded lookup, PDF summary, and
  the reported identities.

The standalone parser's pinned structure revision and Beaver's locally linked
revision must be advanced together: gate `legal-structure`, update and gate
`legal-pdf-parser`, then advance Beaver's parser/addon pins. The root check must
reject a combination different from the one the parser corpus tested. No schema
generator is needed.

### Authorities

The [durable legal work-products plan](legal-work-products.md) is implemented:
standalone and Beaver route through the same TypeScript work-product
application. Beaver saves immutable generated files through `DocumentStore`,
and feature code receives persistence through the composition root. The shared
Rust citation, legal-structure, and PDF primitives remain the implementation;
the former iframe, stdio gateway, Python browser/server/job/project state, and
managed Python product runtime are removed with no compatibility protocol.

### Other language boundaries

- Keep `backend/src/lib/structureNative.ts` as the one Node declaration/loader
  for the N-API addon. It may describe crossing values but owns no legal
  detector or semantic mirror.
- Keep `legal-pdf-parser` and `legal-structure` pinned by Git links and the
  existing guardrail receipts. Do not add a second pin file or JSON bridge.
- Replace the one-off `backend/scripts/legal-structure-jsonl.ts` Python consumer
  with the existing direct `legal-structure/python` operation, then delete that
  unversioned bridge.
- Use one validated, versioned process envelope and fixture set per actual
  Python/subprocess boundary. Do not generate SDKs.
- The Library and Office.js Word executors share document-operation receipts as
  specified in the document-capabilities spoke; that is not a generic plugin
  protocol.

### Optional built-in features

Keep `FeaturePreferences` in `backend/src/lib/userPreferences.ts` as an explicit
typed object stored by `relationalUserPreferencesRepository.ts`. Adding a
built-in feature means one default plus explicit launch-point checks in the
profile/UI, Workflows catalogue, contextual workflow launcher, tool loading,
and its application operation.

Do not add a feature registry, lifecycle, discovery protocol, or UI schema.
Disabling a feature hides launch points and rejects new work; it never deletes
prior documents or receipts. Authorities is the first complete slice.

## Verification and stopping rule

For each vertical cut:

1. trace every caller;
2. move the behavior to its existing owner or the one missing operation;
3. update every caller;
4. delete the displaced route/global/type path;
5. run the smallest behavior test and TypeScript check; and
6. run `npm run check:source-boundaries`.

Run `npm run measure:source` before and after the cut. Count first-party
production and tests separately; pruning duplicate or choreography-only tests
is worthwhile but does not satisfy the production contraction gate.

At phase checkpoints run the affected backend/frontend test suites and builds.
Reserve the complete release checks for a complete candidate. Never run the
full sweep without the required explicit token.

Stop this refactor when:

- deployment selection is confined to bootstrap/composition and auth/account
  adapters;
- User, Legal Sources, Tabular, Authorities, Documents, and Chat have one
  route-facing application owner; Workflow keeps its single cohesive route;
- public assistant events are typed end to end and decoded once in the browser;
- frontend API/resource declarations are domain-local with no global barrel;
- local/cloud behavior tests exercise the same application operations; and
- routine product work no longer requires editing parallel mode paths or
  several copies of one contract.

Do not continue rearranging modules after those conditions hold. Further
refactors require an observed feature change that still fans out unnecessarily.
