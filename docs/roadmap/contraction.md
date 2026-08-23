# Beaver canonicalization and contraction plan

Status: adopted execution plan

Baseline: `02aff487` (`2026-08-13`)

Upstream comparison: `origin/main` at `3382734d`

Authority: this document governs the contraction refactor; the
[Beaver master plan](master-plan.md) remains the product-priority and
release authority.

## 2026-08-18 delivered checkpoint

The first canonicalization wave is integrated and release-verified at
**109,001 nonblank production lines**: 75,600 in `backend/src` and 33,401 in
`frontend/src`. This is **9,189 fewer lines** than the 118,190-line baseline.
The count excludes tests, experiments, generated files, benchmarks, and pinned
subrepositories.

Delivered in this wave: one MCP-shaped tool runtime, one chat application
boundary for local and cloud persistence, one legal-source registry, one local
application SQLite owner, one tabular application boundary, native Claude/Codex
MCP transport, canonical LLM entrypoints, and one authenticated-encryption
primitive. Old paths were deleted without compatibility shims.

All exact release checks pass. A bounded live Luna matrix also exercised the
real HTTP, provider, MCP, legal-read, artifact-write/edit, and in-memory compare
paths. The remaining tranches below are further contraction work, not blockers
for this delivered wave.

## 2026-08-18 clean-room reset

The final ceiling is now **70,000 nonblank production lines**. Upstream Mike is
a comparison point, not an architectural authority: inherited duplication is
in scope. The implementation rule is stricter than the earlier tranche plan:

- product behavior exists once in an application operation;
- SQLite and Supabase/Postgres modules contain persistence mechanics only;
- local/cloud selection happens once at composition and is never exposed to a
  route, tool, component, or application operation;
- there are no legacy exports, aliases, dual reads, compatibility DTOs,
  fallback implementations, or transitional modules; and
- each replacement converts every caller and deletes the displaced system in
  the same change.

The working-tree receipt when this reset was adopted was **96,512** lines, so
the remaining contraction requirement was **16,512** lines. Legal skeleton,
grammar, document-fidelity, and exact-evidence kernels remain protected by the
corpus and byte-fidelity rules below; the target must be met by removing
architecture, not degrading output.

### Migration effort is not a design constraint

Beaver has no users, so the cost of converting the repository is never a reason
to preserve a worse architecture. Approved replacements may change every
caller, route, schema, fixture, and deployment file required to make the new
design the only design. Implementation proceeds as one vertical replacement:

- define the smallest final contract;
- convert every production caller and both persistence encodings to it;
- convert or deliberately discard unsupported development data with an
  explicit, repository-local one-shot command when preserving that data is
  useful;
- prove the final public behavior and protected fidelity contracts; and
- delete the displaced code, tests, dependency, configuration, and converter
  before the replacement closes.

No migration framework, deprecation period, legacy import, runtime feature
flag, compatibility DTO, dual read/write, or fallback implementation may remain
in production. Git is the rollback mechanism. The only exception begins after
Beaver publishes its first supported persistent-data version; before that
release, current schemas and fixtures are rewritten in place.

### One static application origin

Replace the Next/OpenNext frontend runtime only through a capability-complete,
parity-gated conversion to a Vite-built React application, one explicit React
Router table, and one hardened public Express boundary. This is server
consolidation, not blind deletion. Next was a reasonable upstream choice and
must remain until every live responsibility it currently owns has an explicit,
tested destination.

Express is the application origin. In local mode it serves the compiled static
assets and the history fallback alongside `/api`; in cloud deployment the same
origin may cache those immutable assets at any CDN while routing `/api` to
horizontally scalable Express instances. Physical deployment may differ, but
the browser sees one origin and application code contains no API-base or CORS
topology branches.

The replacement must:

- inventory and convert every current route, redirect, deep link, loading/error
  state, authentication callback, and lazy bundle before deleting Next;
- retain Supabase bearer authentication initially rather than inventing a
  cookie/session/CSRF system in the same refactor;
- remove `next`, `@opennextjs/cloudflare`, `eslint-config-next`, Next scripts,
  configuration, generated types, rewrites, and server/client component rules;
- remove normal-operation CORS and `NEXT_PUBLIC_API_BASE_URL`; use relative API
  paths from the one origin;
- keep static assets provider-neutral: Express, Cloudflare, S3, or another CDN
  may serve identical build output;
- preserve keyboard/focus semantics, route-level code splitting, direct URL
  reloads, abortable streams, and every current screen; and
- land no dual frontend, redirect shim, compatibility router, or fallback Next
  build. Every route and caller moves in the same replacement; Git is the
  rollback mechanism.

Promotion requires a mechanically complete current-route inventory, frontend
unit/type/build gates, ChromeDriver navigation of every route and representative
deep links, local smoke, cloud static/API routing smoke, CSP verification, and
proof that the built browser bundle contains no server credential. Expected
net contraction: **2,000–4,000 production lines** plus removal of the Next and
OpenNext dependency trees.

#### Why Mike's frontend server existed

Mike's public history contains no architecture decision record for Next. Its
first public repository import (`d9690965`) already included Next, OpenNext,
Express, Supabase, and S3-compatible storage. Next was nevertheless a sensible
default: it supplied file-system and nested routing, dynamic paths, client
navigation and prefetch, route splitting, metadata, fonts/images, redirects,
rewrites, error/loading conventions, and a production build. OpenNext made that
build deployable to Cloudflare Workers. The refactor must preserve those useful
responsibilities rather than treating their framework as proof that they are
unnecessary.

The replacement decision rests on an audit of upstream Mike `8c678e65` and the
current Beaver tree:

- upstream contains 138 explicitly client-side App Router files;
- there are no frontend route handlers, Server Actions, `"use server"`, Next
  middleware, request cookies/headers, server-session authorization, or
  request-time database reads;
- Next is not a BFF that aggregates or authorizes Express operations;
- the browser obtains Supabase authentication and calls Express with a bearer
  token and separately configured public API base; and
- Next's live work is routing/navigation, static metadata/assets, client bundle
  construction, redirects/rewrites, and deployment.

Next remains justified if the complete inventory discovers live request-time
rendering, server-only data/secrets, an HttpOnly-cookie BFF, frontend
authorization, per-request personalization, ISR/edge HTML, or an image
transformation service. Discovery of one of those is a stop condition: design
its explicit destination before deleting Next. No such capability is currently
present.

#### Final browser/server topology

```text
browser
  |-- /assets/*  -> immutable Vite output (Express or CDN cache)
  |-- app paths  -> index.html history fallback
  `-- /api/*     -> stateless Express -> operations -> data ports
                                            |-- SQLite/files
                                            `-- Postgres/S3
```

In local mode one Express process serves the compiled assets and API. In cloud
deployment a reverse proxy or CDN may answer immutable asset requests and route
`/api` to horizontally scalable Express instances under the same hostname.
That physical optimization is deployment configuration, not a second product
runtime. The identical Vite output must work from Express, Cloudflare, S3, R2,
or another ordinary static cache.

React remains for chat streaming, document work, tables, selections, uploads,
and multi-panel workflows. It is a browser UI library, not an application
server. React Router owns one explicit route manifest. Native HTML and CSS own
ordinary controls and layout. PDF.js, ExcelJS, DOCX rendering, and other heavy
capabilities load only from routes that use them. Do not add a global state
framework, CSS-in-JS, animation framework, component megasuite, or JavaScript
layout engine during this replacement.

#### Enterprise responsibilities transferred to Express

Next cannot be removed until the final Express boundary proves all live server
responsibilities:

- hashed assets receive immutable cache headers; `index.html` does not;
- the history fallback applies only to eligible `GET`/`HEAD` navigations after
  API, health, download, and real-file routes, so unknown API/asset paths never
  become successful HTML;
- every retained redirect and rewrite, including document display/evidence and
  any live sitemap behavior, has an explicit route;
- API authentication and resource authorization remain authoritative;
- bounded bodies, rate limits, cancellation, request IDs, safe errors, SSE,
  uploads/downloads, MIME, ranges, and content disposition remain correct;
- one tested policy owns CSP, HSTS on HTTPS, frame restrictions,
  `X-Content-Type-Options`, referrer policy, and permissions policy;
- service-role/signing/provider/storage credentials, private environment data,
  filesystem paths, and source maps stay out of public assets/responses;
- forwarded scheme/IP values are trusted only from configured proxies; and
- cloud instances remain stateless above data ports. Durable turn/retry state
  cannot exist only in the process holding an SSE connection.

Supabase bearer authentication remains during this tranche. An HttpOnly-cookie
session/CSRF redesign would be a separate trust-boundary change and must not be
smuggled into the frontend-runtime replacement.

#### Mandatory capability ledger

Freeze a machine-readable ledger before implementation. Every row ends as
**preserved**, **replaced**, or **deleted as proven dead**. An unexplained row
blocks Next deletion.

| Existing responsibility | Canonical destination | Proof |
| --- | --- | --- |
| pages, layouts, route groups, dynamic parameters | one React Router manifest and nested shells | every route works through client navigation and direct reload |
| `next/navigation` and `next/link` | React Router | back/forward, queries, hashes, replace, and guarded redirects |
| root/account redirects and not-found handling | router or explicit Express response | correct destination and externally visible status/location |
| rewrites and stable document/evidence URLs | explicit Express routes | auth, headers, stream/range behavior, and URL parity |
| metadata, icons, manifest, Open Graph/Twitter | static HTML/public assets | built HTML contains the approved complete metadata |
| `next/font` | checked-in licensed WOFF2 and `@font-face` | no build network fetch and stable primary-screen metrics |
| `next/image` | dimensioned native images | no broken asset, layout shift, or material byte regression |
| `next/dynamic` and route splitting | lazy/dynamic Vite imports | heavy viewers/editors absent from unrelated entry chunks |
| loading/error/global-error files | route loading and error boundaries | recoverable/fatal failures and retry work |
| build environment validation | one strict public-config schema | missing values fail; secret-shaped values are rejected |
| OpenNext build/preview/deploy | provider-neutral `dist/` routing | local/cloud serve byte-identical assets and deep links |
| Next response/cache behavior | Express/proxy policy | deployed cache, compression, CSP, MIME, and fallback tests |

The inventory includes all URL constructors, authentication callbacks, loading
and error states, static/dynamic paths, redirects, deep links emitted into DOCX
or evidence receipts, and routes reachable only through projects, workflows,
tabular reviews, Settings, or Table of Authorities. A filename scan alone is
not complete.

#### Replacement and promotion

1. Freeze the ledger, build manifest, response headers, cold/warm timings,
   memory, and bundle sizes.
2. Convert every route and Next navigation/image/font/dynamic import at its
   caller; add no compatibility wrappers.
3. Move retained redirects, rewrites, static serving, and deep-link fallback to
   Express with HTTP/security tests.
4. Make browser API calls relative to one origin, then delete the public API
   base and normal-operation CORS.
5. Convert local, container, and cloud deployment to the same static artifact
   and `/api` contract.
6. Delete Next/OpenNext, their scripts/config/types/directives, and obsolete
   tests in the same slice. No static-Next fallback or alternate router remains.

Temporary coexistence is permitted only in the uncommitted implementation
worktree. No checkpoint, release, or final commit may contain two runnable
frontends.

Promotion additionally requires ChromeDriver to exercise every route by client
transition and clean reload at supported laptop/desktop widths; auth and
cross-owner failures to disclose nothing; local/cloud routing smoke; deployed
security/cache/MIME/fallback checks; a secret/source-map bundle scan; route
chunk proof for heavy dependencies; and measured startup, paint, navigation,
and memory against the frozen Next build. A material regression must be fixed
or justified by a concrete correctness/security improvement. Line reduction is
a result, not permission to weaken this ledger.

## Outcome

Keep Beaver's current capabilities while replacing parallel implementations
with one small modular-monolith architecture. The finished application must be
easier to change, faster or neutral on every measured hot path, and smaller
than the current upstream Mike application despite Beaver's additional legal,
local, document, and provider features.

This is not a formatting pass. Success requires all of the following:

- account-free local mode and cloud/Supabase mode execute the same domain
  behavior;
- one assistant turn engine, one tool registry, and one assistant event
  contract serve normal chat, project chat, read subagents, and tabular chat;
- each document version has one immutable source and a small set of canonical
  projections rather than a new parser in every feature;
- DOCX operations share one package/session and accepted-text index while
  preserving untouched OOXML;
- routes contain HTTP work, domain functions contain behavior, and local or
  cloud adapters contain persistence work;
- a new provider, tool, document operation, or storage-backed feature has one
  obvious implementation and test path; and
- authored backend plus frontend production source falls from **118,190**
  lines to **70,000 or fewer**.

The hard ceiling is a deliverable, not an invitation to code-golf. If a line
does not disappear because its responsibility remains genuinely unique, the
refactor must find duplication elsewhere. Features, safety checks, comments,
types, and tests are not expendable substitutes for architectural deletion.

## Measured starting point

The baseline counts authored files under `backend/src` and `frontend/src`.
Production excludes tests, specs, declarations, generated output, experiments,
benchmarks, and pinned subrepositories. Frontend CSS is included because it is
authored production source.

| Tree at baseline | Files | Lines |
| --- | ---: | ---: |
| Beaver backend production | 177 | 84,053 |
| Beaver frontend production | 203 | 34,137 |
| **Beaver production total** | **380** | **118,190** |
| Beaver backend tests/helpers | 181 | 59,869 |
| Beaver frontend tests/helpers | 85 | 12,215 |
| **Beaver production + tests** | **646** | **190,274** |
| Upstream Mike backend production | 76 | 39,748 |
| Upstream Mike frontend production | 193 | 51,951 |
| **Upstream Mike production total** | **269** | **91,699** |

### Live execution receipt — 2026-08-18

The current uncommitted integration tree measures **80,034 nonblank authored
production lines**. This is 38,156 fewer than the frozen Beaver baseline,
11,665 fewer than pinned upstream Mike, and 10,034 above the final ceiling.
The receipt uses `node scripts/measure-source.mjs` and the same exclusions as
the baseline; moving prototypes to experiments or changing formatting does not
count as contraction.

| Current tree | Files | Lines |
| --- | ---: | ---: |
| Backend production | 194 | 55,622 |
| Frontend production | 194 | 24,412 |
| **Production total** | **388** | **80,034** |
| Backend tests/helpers | 180 | 54,038 |
| Frontend tests/helpers | 83 | 12,281 |
| **Production + tests** | **651** | **146,353** |

Completed and focused-verified architecture in this tree includes:

- one Vite/React Router browser application and one same-origin Express
  boundary, with Next, OpenNext, Wrangler, normal-operation CORS, and public
  API-base configuration removed;
- one application operation layer over thin SQLite/Postgres and filesystem/S3
  adapters for documents, projects, chats, tabular work, and account behavior;
- one MCP-shaped tool registry and assistant execution boundary, native
  Claude/Codex MCP transport, and one provider loop used recursively by read
  agents;
- one legal-source registry with direct A2AJ, CourtListener, journal, TNA,
  GOV.UK Employment Tribunal, and GovInfo adapters rather than provider-family
  facades;
- one bounded DOCX session/index, one local application database, one document
  projection authority, and typed evidence receipts;
- the official MCP TypeScript SDK as the connector transport and OAuth
  orchestrator, replacing Beaver's duplicate protocol machinery;
- PostalMime as the bounded RFC 5322/MIME parser, replacing 188 lines of
  handwritten MIME state while retaining Beaver's size, nesting, charset,
  attachment, and safe-text limits;
- one compact, strictly validated workflow HTTP boundary, 321 lines smaller
  than the displaced route and without raw database-error disclosure; and
- zero known production dependency vulnerabilities after in-range updates to
  `fast-uri`, `hono`, and `ip-address` (`npm audit --omit=dev`).

Focused verification currently passing includes the backend and frontend
production builds, Vite route/build guards, assistant/registry contracts,
provider and evidence contracts, MCP/auth contracts, DOCX fidelity suites,
workflow local behavior, MIME unit and end-to-end projection behavior, and the
Express static/security boundary. These receipts are intermediate: the full
release matrix and corpus-scale grammar gates remain mandatory before the
single final commit.

Chat/runtime contraction and the standalone grammar corpus have since closed:
the chat tree is 2,513 lines smaller than `HEAD`, and the complete 64-entry,
252-vector grammar is wired into Beaver, the PDF parser, and Table of
Authorities with the full output corpora byte-identical. Three isolated
tranches remain in progress: readable frontend component convergence,
ordinary resource/application cleanup, and replacement of Beaver's duplicate
PDF artifact lookup with the engine-owned contract. Their code is included in
subsequent live line counts; their final receipts are not claimed until their
gates finish.

The comparison is deliberately unfavorable to Beaver in one respect: Beaver's
frontend is already 17,814 lines smaller than upstream, while its backend is
44,305 lines larger. From the frozen baseline, the 70,000-line harness requires
48,190 net production lines of real contraction. Upstream is a comparison, not
a stopping point; both inherited frontend code and Beaver backend architecture
remain in scope. The live receipt is remeasured after each coherent slice.

The largest current production concentrations are evidence of responsibilities
that accumulated together, not file-size offenses by themselves:

| Current area | Lines | Observed duplication pressure |
| --- | ---: | --- |
| `lib/chat` | 19,156 | local and cloud tools, schemas, dispatch, subagents, evidence, and streaming |
| routes | 12,036 | persistence, authorization, domain rules, response shaping, and mode branches |
| `lib/llm` | 5,576 | legitimate provider transports plus repeated orchestration assumptions |
| `lib/docx` | 2,024 | useful shared primitives not yet used by every DOCX path |
| `localAssistantTools.ts` | 5,859 | schemas, dispatch, document reads, edits, PDF lookup, state, and result rendering |
| `routes/chat.ts` | 3,140 | a second assistant engine mixed with local and cloud persistence |
| `routes/tabular.ts` | 2,309 | a third model/tool loop mixed with two storage modes and extraction |
| `sourceDocA2AJ.ts` | 1,862 | mature structure recovery that should be compiled once and queried everywhere |
| `docxCompareVersions.ts` | 1,686 | unique comparison logic plus repeated package/XML mechanics |
| `docxTrackedChanges.ts` | 1,482 | unique edit logic plus repeated package/XML mechanics |
| `localDocumentStore.ts` | 1,451 | metadata, blobs, versions, folders, legal pointers, and database lifecycle |
| local/provider PDF bridge and lookup | 4,537 | source acquisition, artifacts, state, rehydration, and query behavior overlap |

At the checkpoint, backend and frontend production builds pass. Frontend has
310 passing Vitest tests plus three build-guard tests. The full backend suite
exposed three 20-second timeouts and locked temporary SQLite files in two test
files; those same 16 tests pass serially. Raising the timeout is specifically
forbidden. The harness must remove shared singleton/handle contention and make
the full parallel suite deterministic.

## Grand theory

Beaver's excess size is multiplicative, not the simple cost of extra features.
A capability is often re-expressed once per storage mode, assistant surface,
provider, file format, and route. Adding one legal feature can consequently
touch a local dispatcher, a cloud dispatcher, a normal-chat loop, a read-agent
loop, a tabular loop, an HTTP route, and several document readers.

The ordinary correction is:

> Define behavior once, select concrete I/O once at the composition root, and
> preserve source-specific information at the edges.

The target is not a generic framework. It is a handful of plain function
bundles around responsibilities Beaver already has twice. An abstraction may
land only in the same commit that converts its real callers and deletes the
superseded implementations.

## Non-negotiable constraints

1. **No feature cull.** Keep local projects/matters, Library, chat, workflows,
   tabular review, legal sources, CourtListener/A2AJ/public providers, exact
   evidence, DOCX work, spreadsheets, presentations, Table of Authorities,
   MCP, current model providers, and Claude-P.
2. **One product, two persistence deployments.** Local SQLite/files and
   cloud Supabase/R2 are adapters to the same behavior, not separate apps.
3. **Cloud remains lazy.** Normal local startup must not import, initialize,
   contact, or require Supabase, R2, or cloud-only account machinery.
4. **No legacy architecture.** Beaver has no users whose private compatibility
   paths must survive. Update all callers and schemas atomically; do not add
   dual reads, old DTOs, mode shims, or deprecated tool names.
5. **No silent data destruction.** There is one accepted schema version.
   Existing mismatched data is left untouched and startup fails with the exact
   mismatch; the application never auto-deletes or guesses a migration.
6. **Exact legal state remains exact.** Source bytes, versions, evidence
   passages, locators, hashes, mutation receipts, and raw transcripts remain
   durable. Caches and prose summaries remain replaceable.
7. **Preserve native information.** Provider structure wins over recovery.
   Raw DOCX parts and immutable PDF bytes remain authoritative. A compact
   projection cannot overwrite its source.
8. **No metric tricks.** Moving code to a subrepository or experiment is
   reported as a move, not deletion. Removing comments, types, or whitespace
   does not count. Generated code is reported separately. Whole-maintained-
   source totals accompany app-only totals when a subrepository changes.
9. **No speculative infrastructure.** No ORM, dependency-injection container,
   repository hierarchy, event bus, Redis, service split, cache service, or
   new runtime dependency without a measured need the standard library cannot
   meet.
10. **Experiments remain experiments.** Useful graph/visualization and model
    probes stay available under an experiment root with their own entry point
    and tests; production never imports them. Claude-P is production and stays
    in the provider layer.
11. **Respect repository boundaries.** `legal-pdf-parser` owns neutral
    PDF parsing/artifacts, `OpenLegalData` owns shared corpus contracts, and
    `AuthoritiesHelper` owns authority-building behavior. Beaver keeps
    thin application adapters, as pinned by `subrepos.lock.json`.
12. **No metered evaluation by default.** The refactor harness uses fake
    provider transports and recorded lawful fixtures. Live model/API calls
    require separate authorization.

## Target architecture

```text
HTTP/SSE request
    |
    v
thin Express route ---- AuthContext
    |
    v
domain operation <---- RuntimeServices = createRuntime(DataPorts)
    |                                             |
    |                         +-------------------+------------------+
    |                         |                                      |
    |                 local DataPorts                        cloud DataPorts
    |               SQLite + blob directory                   Supabase + R2
    |
    +-- document projections
    |      +-- SourceDoc (linear text and legal locators)
    |      +-- Grid (native spreadsheet/table coordinates)
    |      +-- DocxSession (raw OOXML package and accepted-text index)
    |      +-- PDF artifact (neutral engine contract)
    |
    +-- assistant turn
           +-- provider-neutral transport
           +-- one ToolRegistry -> the same domain operations
           +-- one AssistantEvent stream -> persistence + frontend reducer
```

There are four boundaries, each with a concrete reason to exist:

- **composition** chooses local or cloud implementations once;
- **domain operations** own behavior shared by HTTP routes and assistant tools;
- **document projections** prevent each feature from reparsing source bytes;
  and
- **wire adapters** translate Express, SSE, provider APIs, SQLite, Supabase,
  R2, and subprocesses without owning product rules.

No other layer is presumed necessary.

## 1. Composition and persistence

### Plain runtime construction

Replace module singletons and repeated `isAnonymousLocalMode()` branches with
one `createApp(runtime)` construction. A single `createRuntime(dataPorts)`
factory builds all domain operations. Local and cloud modules provide only the
small persistence/blob/auth process ports that genuinely differ; they do not
build competing domain-service objects. The result is a plain object of
concrete functions used by the application. There is no container, decorator,
reflection, or class hierarchy.

Routes receive the required function groups when created. A route may import a
pure formatter or validator, but it may not import SQLite, Supabase, R2, a
provider SDK, or a global store directly.

Cloud-only account, audit, MFA, and connector administration may remain
separate lazy route modules because local mode has no corresponding behavior.
Ordinary documents, projects, chats, workflows, and tabular reviews do not get
mode-specific routers.

### Parity by construction, not memory

Local/cloud parity must feel like maintaining one application because it is
one application. The only legal mode branch is the composition root that
selects `DataPorts` and passes them to `createRuntime`. Everything downstream
receives the same `AuthContext`, calls the same domain operation, returns the
same DTO, emits the same event, and runs the same test.

The enforcement is mechanical:

1. `createLocalDataPorts()` and `createCloudDataPorts()` must both satisfy
   the same concrete TypeScript persistence contract and both feed the one
   `createRuntime()` factory. Adding required storage capability breaks the
   build until both encodings provide it; domain behavior is never
   reimplemented.
2. A single exported `appContract(createDataPorts)` test suite constructs the
   same runtime and application for temporary SQLite and real local Supabase.
   There are no separately authored “local version” and “cloud version”
   behavior tests to remember.
3. Routes and tools receive domain functions, not a `mode` flag. A boundary
   check rejects `isAnonymousLocalMode`, Supabase imports, or SQLite imports
   outside the composition and adapter modules.
4. Domain code owns validation, authorization decisions, normalization,
   pagination plans, version rules, event formation, and response DTOs.
   Adapters receive already-decided typed reads/writes and may not reinterpret
   product rules.
5. The landed cursor/order specification is shared input to both persistence
   adapters. Search/sort/filter/cursor behavior is never independently invented
   in route branches.
6. CI enumerates every registered data-port constructor automatically. A new
   adapter or contract case joins the matrix once; feature authors cannot
   forget to run it in one mode.

This deliberately stops short of inventing an ORM or a database emulator.
SQLite and Postgres still need small, honest persistence mappings because they
are different databases. Those mappings are the only duplicated mechanics,
are compiler-enforced, and are exercised by the same contract. Most new
features—tools, validation, orchestration, document operations, UI, and
provider work—never touch either mapping. A storage-shape change is one domain
change followed by two obvious mechanical encodings, with no second behavior
design.

### One local metadata database

Use Node's existing `node:sqlite` runtime for one Beaver metadata database.
Keep domain tables separate, but share connection lifecycle, schema version,
transactions, busy policy, foreign keys, WAL configuration, prepared statement
helpers, and test cleanup. Large source bytes remain files; SQLite stores
identity, relationships, hashes, state, and small JSON only.

Consolidate the current local document, matter/knowledge, tabular, and chat
metadata stores. Replace file-backed anonymous chat records with append-only
chat/event rows and optimistic transcript versions. This removes torn JSON
writes, directory scans, singleton caches, and several independent lifecycle
paths.

The shared A2AJ, CourtListener, journal, and other provider/corpus databases
remain separate read-only snapshots under `OpenLegalData`. “One local database”
means one Beaver application-metadata database, not one giant file containing
external corpora or parser artifacts.

#### Current implementation tranche (2026-08-17)

Converge documents, chats, and projects first. One `localMetadataDatabase`
owns the production `DatabaseSync`, WAL/busy/foreign-key policy, transaction
queue, schema installation, and close/reopen lifecycle. The first current
schema contains:

- Library folders, documents, versions, legal-source pointers, and filename
  search;
- chats, ordered messages/events, deletion state, and optimistic transcript
  versions; and
- matters/projects, document membership, knowledge nodes/edges/evidence, and
  source labels.

Document and generated-file bytes remain immutable files. Provider corpora,
provider caches, PDF artifacts, and the tabular database do not join this
tranche. They have different lifecycle or fidelity constraints and are not
pre-emptively generalized.

Replace the anonymous-chat JSON directory and process cache with chat/message
rows. Point `localDocumentStore` and `LegalKnowledgeGraphStore` at the same
owned connection and delete their independent open/attach/close/schema
machinery. Production has one connection; tests may construct an isolated
temporary owner explicitly. Existing public store ports remain the local/cloud
boundary, not wrappers around the old stores.

There is no migration or dual-read path: Beaver has no users. Startup creates
the one current schema, and incompatible old development files are outside the
supported state contract. Blob deletion, chat deletion hooks, provider-session
cleanup, optimistic transcript conflicts, matter membership, and exact
pagination/order behavior remain capabilities and must be covered before the
old paths are removed.

Use immutable, hash-bearing blobs for uploaded/generated document versions.
Each version owns a unique key containing its scope, version ID, and SHA-256;
two metadata rows never share a deletable key. Parse artifacts may still dedupe
by content hash. One tiny blob contract is sufficient:

```ts
type BlobStore = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
};
```

The shared version service calculates and verifies the key/hash, then calls the
port. Local implements it with atomic files; cloud implements it with R2/S3.
Product code refers to version IDs and blob keys, never absolute paths or
buckets. Unique ownership keeps ordinary deletion simple and prevents one
version from deleting bytes still referenced by another.

### One current schema

Because Beaver has no users, squash local metadata and fresh cloud setup to
one documented schema version instead of preserving the deleted migration
history. Startup verifies both application and storage schema versions before
serving dependent routes. Schema mismatch is an explicit error, never a
best-effort read.

Once the first supported public data version ships, future migrations begin
from this baseline. Until then, every schema change updates local setup, cloud
setup, fixtures, and adapter contract tests in the same commit.

### Query and pagination semantics

Keep the landed cursor contract. A domain page request owns normalized search,
scope, sort, limit, and decoded cursor values. SQLite and Postgres perform
indexed keyset queries and return the same ordered DTOs. Shared contract tests
run the same cases against both adapters, including equal sort values, deleted
rows, Unicode names, empty searches, and cursor/filter mismatches.

Do not build a general query language. If repeated keyset predicates still
drift, add one small order-spec helper that generates the predicate and cursor
from the same column list; it must replace the duplicated predicates in its
landing commit.

## 2. One assistant engine

`streamChatWithTools` remains the provider-neutral transport. Build one
`runAssistantTurn` around it and delete the independent turn engines currently
in `lib/chat/streaming.ts`, `routes/chat.ts`, and `routes/tabular.ts`.

The runner owns only orchestration:

- assembled system and conversation input;
- provider callbacks and abort handling;
- bounded tool rounds;
- tool-call/result pairing;
- read-subagent admission and recursion;
- the per-turn read/edit/evidence state;
- content, reasoning, tool, mutation, citation, and completion events; and
- final legal-output/evidence gates.

Authentication, transcript storage, titles, project access, and HTTP response
setup remain outside it. Document reads, edits, searches, workflows, and legal
lookups are domain operations invoked through tools, not runner branches.

Normal chat, project chat, tabular chat, and read subagents configure the same
runner with a prompt, tool set, policy, and state budget. A read subagent calls
the same runner recursively with an allowed registry view and an explicit
depth/admission limit; it does not carry a second copy of tool execution.

Provider continuation IDs remain transport metadata. The durable transcript
and event ledger remain authoritative, so changing provider or losing a
continuation does not change product behavior.

## 3. One tool registry

Replace parallel schema arrays and switch/if dispatchers with a `Map` of small
definitions:

```ts
type ToolDefinition = {
  schema: OpenAIToolSchema;
  run(call: NormalizedToolCall, context: ToolContext): Promise<NormalizedToolResult>;
};
```

Each domain owns the schema and handler for its tools in the same module.
Registry assembly checks duplicate names and advertises only definitions whose
required capability exists. Deferred/one-hop tool discovery reads this same
registry; there is no second catalog to synchronize.

`ToolContext` contains the turn state and concrete domain operations a handler
actually needs. It must not become a bag of every service. Split a context only
when the compiler and real call sites show distinct requirements.

Adding a tool should normally require:

1. one definition beside the domain operation;
2. one behavior test using a tiny context; and
3. registration in its domain export.

It must not require edits to local and cloud dispatchers, normal and subagent
dispatchers, or a central tool-name switch.

## 4. Canonical document work

The adversarial correction to “one document model” is important: one universal
AST would erase information and grow optional fields. Beaver needs one
authoritative representation **per semantic shape**, all keyed to the same
immutable version.

### Immutable version source

A document version record identifies its exact bytes, SHA-256, media type,
filename, created time, and parent version. Mutations always create or update
the explicitly defined turn version and emit a receipt bound to the source and
result hashes.

### `SourceDoc`: linear text and legal locators

Keep and finish the existing `SourceDoc`. Provider, PDF, DOCX accepted text,
plain text, presentation text, and email paths yield one immutable linear text
plus paragraph/page/section/footnote blocks where those coordinates exist.
Native coordinates are preserved first; recovery runs only for missing
structure. Token and locator indexes are built once per revision.

Source-specific compilers are evidence adapters, not independent structure
detectors. They decode or fetch text, anchors, trustworthy native blocks,
excluded ranges, and provenance. One provider-neutral semantic structure
engine reconciles that evidence into document-wide paragraphs, numbered
units, headings, sections, notes, relations, and sequence state before the
result reaches SourceDoc or a geometry-preserving LegalDocument projection.
The engine must preserve the existing measured SourceDoc sequence contract:
root ordinary ladders at 1, accept only valid successors, recover gaps only
from direct surrounding evidence, reject competing late ladders, and reuse
provider-native structure wherever it exists.

Legal PDF Parser remains responsible for physical PDF evidence—glyphs, spans,
lines, boxes, flow proposals, spatial regions, tables, and images—but must not
maintain a second final semantic spine. Packaging may be a shared library or a
persistent versioned sidecar; separately maintained Rust and TypeScript
implementations and per-document process spawning are forbidden. Rust is a
candidate for the computational engine only after exact provider-fixture,
native-PDF-corpus, throughput, memory, and deployment differentials.

The engine must also keep two meanings of “paragraph” separate. A
geometry/provider-backed prose paragraph is an anchored segmentation unit for
reflow, chunking, retrieval, and context windows. Its internal one-based ID is
not a legal label. Only a printed/provider enumerator accepted by the
document-wide sequence grammar becomes a numbered legal paragraph or
provision. Unnumbered prose is addressed by printed/physical page plus exact
text anchor, not exposed as synthetic `para N`. Reuse Text-Fidelity's existing
PAGE-XML/BLLA break primitive—page/flow-local large gaps,
sentence-plus-indent, guarded block-start indents, and continuity
suppression—inside the shared engine rather than treating one spatial region
as one paragraph.

Do not force spreadsheet cells, OOXML run properties, PDF geometry, or provider
response metadata into `SourceDoc`. Store the small source-specific metadata
needed to rehydrate a URL or native coordinate beside the compiled source.

### `Grid`: tables and spreadsheets

Keep a typed grid for sheet/table, row, cell, spans, displayed value, formula
where available, and source coordinates. Markdown is a bounded model-facing
projection, never the canonical state. PDF tables use this shape only when the
neutral engine proved native/geometry-backed cells.

### Shared document operations

HTTP routes, assistant tools, tabular review, evidence resolution, and viewers
reuse a short set of operations:

- get a version and its immutable bytes;
- compile or load a projection;
- read a bounded structural/text/grid scope;
- search a projection;
- create/replace a version with a durable receipt; and
- resolve a version-bound evidence handle.

Delete format extraction from `routes/tabular.ts`, `documentOps.ts`, and local
tool branches once these operations serve their callers.

## 5. One DOCX package/session

DOCX is not safely normalized into a generic document AST. The robust compact
design keeps raw parts and shares mechanics:

- load and bounds-check the ZIP once;
- parse `word/document.xml` once for the accepted body view;
- build one paragraph/run/offset index used by read, find, edit, compare,
  structure, citation, and evidence operations;
- load stories, relationships, styles, numbering, comments, notes, or headers
  lazily from the same package only when requested; and
- write only the targeted parts, retaining untouched ZIP entries and unknown
  OOXML.

An immutable `DocxSession` belongs to one input hash. A mutation returns bytes;
subsequent operations open a session for the new hash. A turn-scoped cache may
reuse sessions, but correctness cannot depend on a cache hit.

Consolidate existing ZIP lookup, XML parser/builder, body traversal, accepted
text, run flattening, relationships, tracked-ID allocation, and atomic output
helpers under `lib/docx`. Preserve the unique algorithms for compare versions,
tracked edits, redline projection, deterministic cleanup, numbering, stories,
and pathology checks. The goal is shared mechanics, not one giant DOCX file.

DOCX gates compare before/after archives and require:

- untouched entries byte-identical;
- untouched XML subtrees semantically and textually preserved;
- accepted and redline projections correct;
- field, hyperlink, bookmark, table, footnote/endnote, numbering, content
  control, comments, and tracked-change fixtures retained;
- malformed and oversized packages rejected within existing bounds; and
- numeric-looking `w:t` values remain strings through every parse/write path.

## 6. Providers, evidence, PDF, and caches

Provider modules fetch and compile; consumers query `SourceDoc` and evidence
services. A provider may keep its request/response types, rate limits, and URL
rules, but it may not grow its own quote matcher, locator query engine, cache
envelope, or assistant result format.

CourtListener uses native provider paragraphs, footnotes/endnotes, and reporter
coordinates when present. Recovery is limited to absent coordinates and uses
the existing mature spine/ladder logic. A2AJ, TNA, GovInfo, GOV.UK ET, journals,
and local PDF follow the same native-first compiler rule.

### One host-agnostic legal-source core

Use one dependency-light TypeScript core for provider selection and source
normalization. It exports plain data and three operations:

```ts
searchSources(query) -> SourceHit[]
resolveSource(reference) -> LegalSource
readPassage(reference) -> SourcePassage
```

The core knows provider keys, discriminated source references, ambiguity/not-
found results, and normalized source/passage shapes. It does not import Beaver
tools, MCP, Express, Supabase, SQLite, the frontend, or provider SDKs. A small
function registry supplies provider-specific search/resolve/read operations;
providers keep their native request types, rate limits, fetch code, and exact
coordinates. This makes the core directly reusable by another TypeScript host
without pretending it is a separately deployed service or adding a package
boundary solely for optics.

Beaver bindings turn `SourcePassage` into the existing `SourceDoc` and
`LegalEvidenceReceipt`, persist provider artifacts where needed, and apply the
one citation presenter. Chat `search_sources -> Read`, DOCX citation linking,
and the Legal Library route must consume these same operations. Delete the
CourtListener, public-source, A2AJ, Hansard, DOCX-linker, and route-specific
resolver/result facades as their last callers move; do not retain aliases.

The cross-surface contract fixture runs A2AJ, CourtListener, TNA, GovUK
Employment Tribunal, GovInfo, journals, and Hansard through chat, DOCX, and
Legal Library. Each surface must select the same provider/source and preserve
the same canonical URL, passage URL, source hash, native locator, ambiguity
decision, and evidence text. A2AJ passage search remains an opt-in provider
capability and is not deleted or hidden by the common core.

Use one tiny content-addressed artifact helper for JSON-safe derived data. Its
key includes source hash, artifact kind, compiler version, and material options.
Writes are atomic and concurrent misses are single-flight. Unreadable or
version-mismatched artifacts are misses; a hit and a cold compile must produce
equivalent results. This helper replaces repeated path/hash/temp-file code but
does not hide different parser behavior behind a cache framework.

`legal-pdf-parser` remains the only owner of neutral PDF parsing,
page/paragraph/footnote/table artifacts, and parser diagnostics. Beaver owns
source acquisition, job state, artifact selection, evidence binding, and UI.
If neutral logic moves into the engine, report application lines removed and
whole-maintained-source lines separately.

The provision graph/visualization work remains available as an experiment. If
production has no caller, move its source, tests, and Cytoscape/Dagre runtime
requirements to an experiment boundary; do not delete the experiment or load
its dependencies in ordinary production.

## 7. Thin routes and one frontend event/resource path

An Express route should normally do five things: authenticate, parse/validate,
call one domain operation, translate a known error, and send a response. It
must not contain SQL chains, filesystem layout, document parsing, provider
loops, or assistant orchestration.

Keep one stable API DTO per resource for both modes. The frontend must not know
which persistence adapter served it. Continue the landed `usePagedQuery` and
`usePagedDirectory` direction, deleting component-specific fetch/cache/list
state when each caller moves.

All assistant surfaces consume one typed `AssistantEvent` reducer. Tabular may
render a specialized view of those events, but it may not implement another
SSE parser, buffering state machine, or mutation/citation reconciliation path.

This backend contraction does not wait for a clean-room frontend rewrite. The
static-shell and graph viewers may continue as experiments. Only measured
in-place frontend deletions and changes unlocked by the canonical API/event
contracts are in the critical path.

## Testing architecture

### Construction instead of global mocks

Tests call `createApp(testRuntime)` or a domain function with small in-memory or
temporary adapters. Provider behavior uses a deterministic fake
`streamChatWithTools` transport that emits registered content/tool sequences.
Module mocking is reserved for process boundaries that cannot be passed as a
function.

Every resource contract is a reusable suite. The same project, document,
workflow, tabular, chat, pagination, and evidence cases run against:

| Lane | Adapter | Purpose |
| --- | --- | --- |
| fast | temporary SQLite + temporary blob root | every change; exact domain and route behavior |
| fast | pure fake assistant/provider | tool rounds, aborts, subagents, events, receipts, no network |
| integration | local Supabase/Postgres and object-store fixture | real cloud query/RLS/schema behavior; no chain-mock illusion |
| fixture | recorded provider/DOCX/PDF/XLSX inputs | native structure, projection, fidelity, and error behavior |
| release | production builds plus Beaver smoke | assembled local product and Table of Authorities |

Cloud tests must cover owner/shared/foreign access, not merely successful
queries. Local tests must use unique database handles and close every handle,
watcher, stream, and subprocess. Fix the current parallel timeouts by removing
shared environment/singleton state and proving cleanup; do not serialize the
whole suite unless a real external resource is inherently singular.

### Behavior inventory before deletion

Before replacing a path, freeze the durable behavior that callers rely on:

- HTTP status and structured payload, not incidental wording;
- ordering, search, cursor, and access rules;
- SSE event ordering and terminal behavior;
- one turn-version per document and correct edit receipts;
- accepted DOCX text and untouched OOXML;
- evidence rehydration from exact source/version/hash;
- provider locator and pinpoint results; and
- restart durability and schema mismatch behavior.

Tests that only assert a module, branch, CSS class, or implementation exists
may be replaced by the shared behavior contract. Deleting duplicate tests is
allowed only when a named shared test covers the same observable invariant.

## Measurement harness

### Source accounting

Add one checked-in measurement command that emits JSON and a human table for:

- backend/frontend production lines and files;
- backend/frontend test lines and files;
- experiments, generated source, and each pinned subrepository separately;
- runtime and development dependency counts;
- largest modules and directory totals; and
- comparison with the pinned upstream ref.

Every refactor commit records the prior and new totals. A vertical slice must
be net-negative in production source when it finishes. Temporary additions may
exist within a slice, not as a merged scaffold with the old implementation
still alive. The final production-plus-test total must also be lower than
190,274 without weakening behavior coverage.

### Performance cases

Record cold and warm values on the same machine, exact commit, dependency lock,
fixture, and cache state. Use alternating runs and report median plus p95 where
the sample permits it.

1. process start to `/health`, imported module count, and RSS;
2. first Library, Projects, Workflows, and Tabular page at 100, 10,000, and
   100,000 metadata rows;
3. first SSE event and completed fake-provider assistant turn with zero, one,
   and ten tool calls;
4. first and repeated SourceDoc compile/query for representative small, large,
   and very large legal sources;
5. DOCX read, find, tracked edit, compare, and repeated operations on one
   version;
6. PDF artifact cold parse, warm rehydrate, and exact structure lookup;
7. frontend clean build, production JS/CSS, primary-route navigation, and
   assistant first-frame/first-event handling; and
8. memory after repeated document/version/tool operations to catch unbounded
   caches or leaked database handles.

A slice does not ship with a statistically credible regression in its affected
case. Smaller source or faster build does not excuse slower first use. A new
cache must show bounded memory, a cold-equivalence test, and a real warm win.

## Approved next contraction tranches (2026-08-17)

The following six tranches are approved execution work after the current tool,
legal-source, chat, and local-metadata replacement lands. They preserve
capability; experiment moves, formatting, generated output, and test deletion
do not count toward their production-line targets.

### Canonical subsystem entrypoints and primitives

Make the implementation path visible in code instead of maintaining a global
function catalog. For each touched subsystem, expose one small public
entrypoint, keep canonical operations beside their owning domain, convert live
callers, and delete superseded facades and same-semantics helpers. Use the
existing TypeScript/ESLint test infrastructure to reject imports of private
subsystem paths from outside that subsystem. A short colocated README may name
the entrypoint and operations, but must not duplicate signatures or become a
second registry. Consolidated validation must retain the strictest URL, path,
authorization, size, abort, hash, and atomicity rules. Target: **at least 500
fewer production lines**, stretch **1,000**, without touching fidelity kernels
or counting experiment moves.

### Canonical document projection service

Compile each immutable document version once into only the projections its
format supports: `SourceDoc`, spreadsheet `Grid`, `DocxSession`, or the neutral
PDF artifact. Assistant reads, Library, tabular review, citation linking, and
PDF lookup consume those projections rather than running their own extraction
or cache path. The version id, source hash, compiler version, and material
options form the cache identity. Enforce compressed/input/output size limits,
ZIP-bomb limits, atomic cache writes, and cold/hit equivalence. Target:
**1,200–2,000 fewer production lines**.

### One OpenAI-compatible provider transport

OpenAI, OpenRouter, DeepSeek, and compatible Ollama endpoints share one bounded
stream decoder, tool-call accumulator, usage normalizer, cancellation path,
and safe error boundary. Each provider retains only its actual request fields,
authentication, endpoint selection, and response deviations. Codex app-server
and Claude native MCP remain separate transports. Bound event and argument
sizes, never log secrets or untrusted bodies, and preserve provider-specific
continuation and accounting tests. Target: **700–1,200 fewer production
lines**.

### One DOCX package session

Tracked editing, comparison, semantic-Markdown rendering, metadata, citations,
and advanced editing share one package loader, story enumerator, relationship
manager, accepted-text index, revision-attribute emitter, and targeted save
primitive. Comparison and editing algorithms remain distinct. Promotion
requires the corpus/pathology suite, accepted/redline views, package-part
archive diffs, and proof that untouched OOXML stays byte-identical where the
operation does not own it. Target: **800–1,400 fewer production lines**.

### One typed assistant-event contract

Replace remaining `unknown[]`, structural event detection, and frontend event
re-parsing with the canonical discriminated `AssistantEvent` union from tool
executor through persistence and rendering. Reject malformed events at the one
host boundary; do not add a parallel validation/event hierarchy. Target:
**150–300 fewer production lines**.

### One hardened download response

Document, export, PDF, and artifact routes share one response helper for safe
filenames, RFC-compliant `Content-Disposition`, MIME selection, cache policy,
range handling, abort cleanup, and bounded streaming. It must reject CR/LF and
control characters, prevent content-type confusion, and never resolve an
untrusted filesystem path. Target: **100–220 fewer production lines**.

### One pagination and cursor boundary

Library, projects, workflows, chats, and tabular lists use the existing keyset
cursor primitive for limit parsing, filter normalization, cursor binding, and
page DTO formation. SQLite and Supabase retain their concrete indexed SQL, but
do not independently design ordering or cursor semantics. Shared contract tests
cover equal sort keys, filter mismatch, deletion between pages, Unicode, and
owner/share scope. Target: **180–350 fewer production lines**.

Execution order is canonical subsystem entrypoints, document projections,
provider transport, DOCX session, then the three small tranches. Each tranche
updates all live callers and deletes its superseded path in the same commit;
no compatibility aliases or dual reads remain.

## Execution phases and line budgets

Targets are cumulative, overlap-aware production totals. They are guardrails
against “cleaner but larger” refactors, not permission to delete unique code.

### Phase 0 — make the harness trustworthy

Deliver:

- checked-in source/dependency/performance measurement commands;
- the shared test runtime and fake provider transport;
- deterministic closure of SQLite/files/streams so the current full backend
  suite passes at its existing timeout with normal parallelism;
- a route/tool/event/durable-state behavior inventory; and
- an ignored/out-of-tree home for generated probes and benchmark output.

Production target: **no increase from 118,190**. Harness/test code may grow in
this phase, but duplicate helpers must begin disappearing and it does not count
toward the production reduction.

### Phase 1 — composition root, local database, blobs, and documents

Convert document/Library behavior first to prove the runtime function-bundle
boundary. Establish one local metadata connection/schema, one local blob
store, cloud document/blob adapters, route factories, and the shared document
version operations. Convert callers and delete the paired local/cloud document
and Library routes plus superseded store lifecycle code.

Cumulative production target: **113,500 or fewer**.

### Phase 2 — assistant turn and tool registry

Land one `runAssistantTurn`, one `AssistantEvent` contract, and one registry.
Convert local normal/project chat, cloud chat, and read subagents in vertical
slices. Delete `runLLMStream`, `runToolCalls`, parallel schema catalogs, and
the corresponding orchestration/dispatch sections of `routes/chat.ts` and
`localAssistantTools.ts`. Preserve deferred tool discovery and Claude-P.

Cumulative production target: **104,500 or fewer**.

### Phase 3 — projects, workflows, tabular, and chat persistence

Move product rules from routes into shared domain operations. Complete the one
SQLite schema and event ledger. Give local and cloud concrete adapters and run
the shared contract suites. Convert tabular model work to the assistant runner
and shared document projection. Delete route-level mode branches and duplicate
extract/stream/query paths.

Cumulative production target: **97,500 or fewer**.

### Phase 4 — SourceDoc and shared document projections

Finish the provider/upload compilers, one version projection cache, one bounded
read/search service, one grid projection, and one evidence resolver. Convert
HTTP, assistant, tabular, citation, and viewer callers; delete repeated text
extraction, tokenization, locator, quote, and cache code.

The legal skeleton is a fidelity kernel, not an ordinary representation seam.
Do not rewrite, subdivide, or replace its structural algorithms in tranches.
A representation-only change is admissible only when it is incapable by
construction of changing the emitted structure or when a single end-to-end
differential proves byte-identical output over the entire available corpus.
Any proposed output difference is a product change: inspect the affected
documents directly and accept only strict improvements; proxy scores and
representative samples are not evidence of equivalence.

“Entire available corpus” is fail-closed: the legal-PDF master plan's corpus
registry discovers every locally present applicable PDF, provider capture,
structure truth set, OCR/layout held-out set, grammar corpus, and cross-format
legal fixture. Every SourceDoc provider/mode also needs a real frozen baseline;
synthetic objects, mocks, invariant-only checks, silent skips, and historical
summaries without runnable source bytes cannot establish parity. The release
receipt accounts for every registered document/page/row and hashes the exact
baseline/candidate inputs, binaries, outputs, caches, and serializer.

Converge legal citation, reference, pinpoint, and footnote grammars onto one
complete authored grammar corpus. Every shipping runtime must load that corpus
or a mechanically verified packaged copy; handwritten runtime shadows and
warning-only drift checks are forbidden. The gate inventories every shipping
grammar consumer, runs every table vector in each runtime, fails on missing or
extra entries and byte drift, and differentially compares match spans against
the displaced implementations before those implementations are deleted.

Current state: `legal-structure/data/grammar-corpus.json` has 72
entries and 296 vectors, and its Legal PDF Parser and Authorities Helper copies
are byte-identical. Rust deterministic splitting, backend TypeScript citation
scanning, and Authorities Helper consume the corpus. The eight US full/short
reporter, journal, and law families are a runtime-free snapshot of pinned
eyecite 2.7.8/reporters-db 3.2.66 sources, guarded by exact-span catalogue,
provider-census, full-text precision, public-consumer, and 37,000-input latency
checks. Eyecite remains an authoring/differential oracle, not a second shipping
resolver, grammar runtime, or citation AST. Continue the remaining typed
citation/pinpoint-span wiring inside the shared structure engine.

Cumulative production target: **93,500 or fewer**.

### Phase 5 — DOCX package/session

Land the shared immutable session and accepted-text/run index by converting one
real operation at a time. Consolidate common ZIP/XML/story/numbering/relation
mechanics, then delete each old parser/walker as its last caller moves. Retain
and strengthen fidelity fixtures.

Cumulative production target: **89,500 or fewer**, already below the pinned
upstream ceiling.

### Phase 6 — providers, evidence, PDF, artifacts, and experiments

Reduce provider modules to fetch/decode/evidence adapters, converge evidence
and cache envelopes, keep physical PDF extraction in its pinned parser, and
route provider and PDF semantic inference through the one shared structure
engine. Move no-caller graph visualization code to a runnable experiment and
remove production dependencies whose only caller moved or disappeared.

Cumulative production target: **87,500 or fewer**.

### Phase 7 — frontend convergence and final contraction

Delete component-specific resource and SSE state now made redundant by the
canonical contracts. Audit remaining large/backend modules for a second
implementation rather than splitting them. Run the full local/cloud,
fidelity, security, performance, and release matrix.

Final design target: **70,000 or fewer production lines** and a lower total
authored production-plus-test count than the 190,274-line baseline.

If a phase misses its cumulative target, the next phase begins by publishing
the exact shortfall and ranked remaining duplication. The refactor does not
declare victory at the upstream ceiling if the design target remains reachable
without feature loss.

## Expected deletion sources

These are overlapping estimates, so only the measured net total is binding.

| Source of deletion | Expected net reduction |
| --- | ---: |
| parallel assistant loops, subagent execution, tool catalogs, and dispatch | 8,000–10,000 |
| mode branches and duplicate document/project/workflow/tabular/chat route behavior | 6,000–8,000 |
| repeated document extraction, search, SourceDoc, evidence, and cache mechanics | 4,000–6,000 |
| repeated DOCX package/XML/body/run machinery | 4,000–5,500 |
| provider/PDF bridge/result/cache duplication | 2,500–4,000 |
| frontend SSE/resource/list state | 1,500–3,000 |
| production-only experiments, dead dependencies, and duplicate test helpers | 1,000–2,000 |

## Adversarial review

### “One model” can become a lossy mega-model

**Risk:** forcing DOCX, PDF geometry, and spreadsheets into `SourceDoc` loses
run properties, cells, formulas, or page coordinates.

**Control:** keep the immutable source plus three narrow projections:
`SourceDoc`, `Grid`, and `DocxSession`; consume the neutral PDF artifact
directly where geometry matters. Share version identity, not optional fields.

### A service boundary can become enterprise scaffolding

**Risk:** generic repositories, unit-of-work objects, and dozens of one-method
interfaces add more code than they remove.

**Control:** plain function bundles only where local and cloud already provide
two implementations. No interface lands without converting both real callers
and deleting their branches in the same commit.

### One SQLite database can become a synchronous bottleneck

**Risk:** `DatabaseSync` work can block Node if queries scan or transactions
cover file/model work.

**Control:** metadata-only transactions, prepared statements, WAL, foreign
keys, keyset indexes, no large blobs, and the 100k-row/repeated-operation
benchmarks. Add a worker boundary only if measurements identify DB CPU as the
bottleneck; do not pre-build one.

### One assistant runner can hide product-specific policy

**Risk:** chat, tabular, and read agents have different prompts, tools, and
terminal rules, and an over-general loop may encode them as flags.

**Control:** the runner owns mechanics; explicit small policy functions own
allowed tools, terminal mutation behavior, evidence requirements, and budgets.
A configuration option must have at least two real callers or stay in its
caller.

### A registry can advertise tools without executable handlers

**Risk:** schema and handler availability drift, especially for deferred tools
or local/cloud capabilities.

**Control:** schema and handler are one definition; startup rejects duplicate
names; tests execute every advertised definition with a minimal valid/invalid
case; tool discovery reads the registry itself.

### Route unification can weaken authorization

**Risk:** removing cloud-specific query chains can lose RLS, sharing, or matter
scope checks.

**Control:** authorization is a domain precondition. The current cloud adapter
uses a service-role client that bypasses RLS, so every ordinary read and write
must carry explicit owner/share/scope predicates. Shared contract tests include
owner, collaborator, unauthenticated, foreign-user, foreign-matter, and
guessed-document IDs against real local Supabase, not only mocks. If ordinary
queries later use a user-scoped client, RLS becomes an additional guard rather
than a replacement for the domain rule.

### DOCX reuse can accidentally normalize the package

**Risk:** a convenient full-AST rebuild can reorder unknown XML, discard parts,
or alter visible text.

**Control:** immutable session, targeted part writes, archive-diff gates, real
and generated pathology fixtures, and before/after accepted/redline views. No
whole-document serializer becomes the authoritative representation.

### Caches can make stale bugs look fast

**Risk:** a cache keyed without material options or compiler version serves a
different result than cold code.

**Control:** source hash + artifact kind + compiler version + material options;
atomic writes; cold/hit equivalence; corrupt/version-mismatch treated as a
miss; bounded process maps.

### Local/cloud parity can be faked by Supabase stubs

**Risk:** chain mocks prove method calls, not Postgres predicates, RLS, schema,
or ordering.

**Control:** keep fast pure tests, but promotion requires the same contract
suite against a real local Supabase/Postgres stack. No hosted service or
metered API is required.

### Line targets can reward moving or obscuring code

**Risk:** relocating code, generating it, compressing expressions, deleting
types/comments, or splitting repositories creates a misleading reduction.

**Control:** app and whole-maintained-source reports, generated/experiment
totals, dependency and complexity metrics, behavior mapping for deleted tests,
and code review for readability. The target counts ordinary readable source.

### Faster startup can make first use slower

**Risk:** lazy imports and removed warmups shift cost into the first legal
lookup or assistant turn.

**Control:** cold startup and first-use cases are reported together. A shift is
not a win unless the affected user-visible median and p95 remain neutral or
improve.

### Zero-user freedom can still destroy developer data

**Risk:** schema replacement or blob deduplication deletes the current
developer's local artifacts.

**Control:** refactor tests use isolated roots. Application startup never
deletes an unknown schema or blob. Any deliberate conversion or cleanup of a
real data root requires a separate explicit command and backup receipt.

### A large refactor can become permanently dual-path

**Risk:** a new architecture lands beside the old one “temporarily,” doubling
surface and tests.

**Control:** vertical slices update all callers and delete the old path in the
same commit. Git is the rollback mechanism; runtime compatibility flags are
not.

## Faster feature recipes

The architecture is complete only when these paths are ordinary:

| New work | Expected implementation path |
| --- | --- |
| provider | fetch/response adapter + compiler to `SourceDoc` + fixture contract; existing lookup/evidence/tools work unchanged |
| assistant tool | domain operation + colocated `ToolDefinition` + behavior test; one registry export |
| storage-backed resource | one domain contract/DTO/query plan + compiler-required SQLite and Supabase encodings; the automatically parameterized app contract and thin route are shared |
| DOCX operation | function over `DocxSession`/targeted parts + fidelity fixture + shared version writer |
| exact legal locator | compiler block/alias support + `SourceDoc` lookup fixture; no tool-specific parser |
| tabular capability | domain operation over shared document/grid services + runner policy; no new LLM loop |
| experiment | `experiments/<name>` entry point, local config, fixtures/tests, no production import |

A routine feature should touch the domain owner, its adapter only if it stores
new state, and its behavior test. If it requires edits in both local/cloud
routes, multiple dispatchers, multiple event reducers, or multiple document
readers, the architecture has regressed.

## Commit discipline

- Keep the checkpoint commit `02aff487` as the pre-refactor reference.
- Commit the plan/master-plan reconciliation separately.
- Thereafter commit vertical behavior slices, not layer scaffolds.
- Each commit message states the old path deleted and the behavior contract
  proving the replacement.
- Run focused tests during a slice and the full relevant contract lanes before
  the slice closes.
- Never commit credentials, AppData, corpora, caches, generated artifacts,
  managed runtimes, or dirty nested-repository state.

## Definition of done

The refactor is complete only when:

- production source is at most 70,000 lines by the frozen metric;
- total authored production-plus-test source is below 190,274 with every
  deleted test invariant mapped to retained contract coverage;
- one assistant runner, tool registry, event contract, and frontend reducer
  serve all assistant surfaces;
- ordinary routes contain no local/cloud behavior branches or direct storage
  queries;
- local/cloud selection occurs only at composition, both data-port
  constructors satisfy one contract and feed the single runtime factory, and
  the same automatically enumerated behavior suite passes for both;
- one local metadata database and content-addressed blob store serve local
  product state, with explicit schema verification and bounded handles;
- local and cloud resource/authorization/pagination contracts pass against
  temporary SQLite and real local Supabase;
- document operations reuse canonical projections and exact version receipts;
- DOCX fidelity and provider/native locator matrices pass;
- performance receipts show no affected-path regression and demonstrate the
  expected parse/import/query wins;
- useful experiments remain runnable outside production and Claude-P remains
  supported;
- subrepository changes, if any, are separately committed and pinned;
- the worktree contains no accidental source changes or committed runtime
  artifacts; and
- all release checks pass:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

The final receipt records commit range, exact line-count command/output,
dependency changes, local/cloud contract results, release results, and the
before/after performance table.
