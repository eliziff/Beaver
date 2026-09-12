# Performance contracts and reproduction

This guide owns the implemented cache, transport and worker contracts. It replaces
per-PR progress notes; it is not a promise that all loads are imperceptible.
Measurements below are recorded evidence, not fresh measurements of every build.
[Architecture](architecture.md) owns application boundaries and
[background jobs](background-jobs.md) owns scheduling/durable delivery.

## Collections and navigation

Chat history, Projects, Library files/templates, project directories, shared pickers and tabular
collections reuse one paged-collection engine. Resource, account/project/Library
scope, query, filters and page size define identity. Sources' manually loaded,
revision-sensitive passage/finding chains remain component-local.

The account-keyed provider retains memory only—no localStorage, IndexedDB or
persisted private rows. Inactive retention is bounded to 32 entries, 8,000 items
and an estimated 8 MiB of UTF-16 serialization, with five-minute idle expiry.
Active views are not evicted, so this is not a total application-memory limit.

Returning renders the retained snapshot and revalidates. Identical consumers share
requests; loaded page depth is replaced atomically, never mixed across cursor
generations. Mutations invalidate affected active/inactive identities and prevent
late pre-mutation responses restoring stale rows. Focus, visibility and reconnect
revalidate; same-origin tabs exchange account-scoped invalidation identities, not
rows/documents. A 401 clears retained scopes; 403/404 discard affected queries.
Transient failures retain data and expose errors. There is no server-push freshness
guarantee. Chat history no longer reloads simply because every pathname changed.

Non-touch pointer entry or keyboard focus on supported links starts the existing
lazy route import and first collection request. It respects account ownership,
offline, Save-Data and 2G hints, permits at most two speculative reads, and drops
excess work rather than queuing it. No render-time link scan, model call, mutation
or speculative Sources query is added. Navigation joins pending work; a completed
prefetch has one handoff within one second, not a general freshness TTL. Mutations
clear it, failures retry on real navigation, and account replacement discards late
results.

History, Projects and review-history searches use the shared paged-query snapshot
retention: the previous rows and their highlighting query remain until a replacement
arrives. Retention is explicitly bounded to the same account/resource/filter scope;
scope changes, disabling and errors discard the held snapshot. Empty success replaces
it normally. Network-backed history, project and Library-picker text inputs use the
shared 200 ms debounce; inputs themselves update immediately. Hidden review history
does not issue requests. Initial table/picker loading uses the existing delayed
indicator instead of constructing a second, fictional row/column layout.

Transcript search uses the existing message-order index to find the earliest matching
message per chat, rather than ranking all matching messages. Matching remains literal
substring search over ordered content events, with the same access and date filters.
Absent terms still require a scoped scan; this is not a full-text index.
`node --import tsx scripts/measure-chat-search.ts` from `backend` reproduces a disposable
SQLite benchmark (1,000 chats, 24,000 messages, 48,000 content events; median of five
warm reads after one warm-up). The September 8 comparison against `ab7246374` measured
803 → 62 ms for `lease`, and 405 → 435 ms for an absent term. These are local synthetic
results, not PostgreSQL measurements or a general latency guarantee.

## Document text

`documentProjectionService.text()` reuses immutable extracted text in the existing
process-local projection working set. Identity includes document/version, source
SHA-256, normalized format and `beaver.document-text.v1`; native DOCX drafting mode
and text limits have separate keys. Other formats retain full extraction and apply
each caller's UTF-16-safe limit afterwards. No answer, tool result or authorization
decision is cached.

The working set has eight entries shared with weak native projections, with strong
text retention bounded to 8 MiB of UTF-16 payload. Oversized results are returned
without retention. This excludes in-flight work, caller-held values and native
heap. Replacing the process/compiler clears reuse; a future persistent cache needs
actual build fingerprints, not just an adapter version.

Each reader rechecks captured version, scope/access, hash/type/key/size and working
revision before using shared work and before returning. Misses verify complete
source bytes. Hits reuse already-verified immutable results, not a new check of
physical storage corruption. Sources without a repository validator still verify
bytes on every call. Explicit authorized historical versions remain readable;
replacement, deletion or revoked access cannot reuse a stale descriptor.

Cancelling one reader does not cancel shared extraction. Failed loads are not
retained; transient native DOCX drafting fallback is not cached as a drafting
result. Cold reads add metadata checks and can be slower. There is no disk cache,
cross-process reuse, polling timer or new persistence root.

## PDF preparation corpus

From `backend`, set `LEGAL_STRUCTURE_NATIVE` to the exact native library being
measured, then run:

```sh
node --import tsx scripts/pdf-corpus.ts <manifest.json> <source-root> <output-root> baseline
node --import tsx scripts/pdf-corpus.ts <manifest.json> <source-root> <output-root> candidate
```

The runner uses the application's preparation service, concurrency policy and
native thread pool. It verifies source hashes and page counts, starts with an
empty application cache, and records preparation and product-inspection times
separately. This digital-born profile disables OCR and external layout analysis.
The receipt includes hardware, runtime, profile and native-library identity.

Create the baseline once. Later runs replace the owned `candidate` directory and
compare against the frozen baseline under matching conditions. Identical products
retain only hashes; changed products retain compressed text and anchors. The
runner removes its application cache after recording the result and returns a
failure status when candidate preparation fails.

## PDF rendering and transport

The shared PDF.js renderer loads page-one fit geometry and the requested page
before resolving all remaining page geometry in bounded batches. Visible-page work
need not wait for an unrelated page. Unknown geometry stays hidden; viewport
anchoring handles mixed sizes, and annotation navigation awaits exact geometry.
Per-open page reuse survives zoom/resize. Quote search uses normalized text, not
whole-document text-layer DOM; visible/matched pages share text tasks. Rotation
and crop alignment retain the existing annotation coordinate contract.

PDF.js import overlaps acquisition. Supplied bytes do not trigger an unused
download. The complete-file cache retains at most eight files/64 MiB with LRU
eviction; oversized files remain usable by their reader but are not retained.
Account clearing and invalidation abort reads and guard against late bodies.
These are retained-buffer limits, not total renderer or process memory.

Document-backed viewers use the authorized file route with HTTP ranges; explicit-
byte and standalone viewers retain their path. On a cache miss the server first
reads and verifies the complete content-addressed object. Only verified bytes may
leave it. Its per-application working set holds at most eight buffers/128 MiB for
60 seconds from verification, sharing pending verification but never authorization.
Each range rechecks repository access and selected version before returning.

Responses use strong SHA-256 ETags, `Accept-Ranges` and private/no-store. The client
checks exact bounds, body length and ETag and pins later requests with `If-Match`.
Changed, revoked, truncated or invalid responses stop transport and clear the failed
viewer. Explicit invalidation clears completed/cached sessions too; obsolete paint,
quote-search and navigation callbacks cannot restore removed content. Disposal and
account invalidation abort requests. A complete 200 response remains supported;
partial chunks are not inserted in the complete-file cache. The response cap is
100 MiB, matching the existing object/upload limit.

Single/open/suffix ranges, HEAD, conditional validators and unsatisfiable ranges
have defined handling. Malformed/multiple ranges fall back to a complete response,
not multipart output. PDF ranges do not use signed object-store redirects; ordinary
downloads retain their route.

Range-friendly files can paint before full browser transfer, but server-side first
verification still reads the entire object. Dispersed PDF structure can require
most chunks before paint. No linearization, weaker integrity or server-push
revocation is introduced: remote deletion is discovered on the next authorized
request or existing explicit invalidation. Delivered bytes cannot be recalled.

## SQLite and durable event writes

The production local relational adapter owns one dedicated SQLite worker per
backend process. It keeps the same persistence port and synchronous connection
inside that worker; PostgreSQL behavior is unchanged. The old inline adapter is
an isolated test/benchmark comparator, not the production HTTP path.

The parent serializes requests and reserves the connection for an asynchronous
transaction callback; nested transactions join it. Parameters are captured before
queuing. Commit notifications publish only after acknowledgement; rollback drops
them. Ended transaction handles reject new work. Worker failure rejects pending
and future operations without replaying writes of uncertain outcome; shutdown
drains accepted operations. Production loads the compiled CommonJS worker, while
source development/tests use `tsx`. WAL, foreign keys, permissions, schema and lock
timeout are unchanged.

Each connection reuses at most 128 prepared statements by last successful use,
not query results. Ordinary SELECT/INSERT/UPDATE/DELETE/WITH statements qualify;
SQL over 8,192 UTF-16 units or bindings over 64 KiB do not remain retained. Execution
removes an entry first and restores it only on success. Errors, DDL/PRAGMA, rollback
and close invalidate as appropriate. External live schema migration is not supported:
use the adapter or reopen the connection. These limits do not bound total native
memory and do not depend on a newer Node SQLTagStore API.

The durable event writer batches available rows without changing payloads,
sequences or timestamps: up to 64 rows/64 KiB of event JSON and 256 parameters per
statement. The existing 512 KiB single-event maximum remains a separate batch.
The first write starts at the existing Promise microtask boundary, with no timer
or minimum dwell. `flush()` seals its accepted prefix; later appends cannot extend
its wait. Failed statements send no success notification, do not skip rows, and
keep later flushes rejecting; earlier committed batches remain replayable. This
assumes one writer per leased job, not a multi-writer allocator or global producer
backpressure service.

## Recorded evidence and limits

Earlier five-sample, alternating fresh-process measurements on Node 22.16/Linux
held a competing SQLite write lock for 300 ms:

| Median | Inline | Worker |
| --- | ---: | ---: |
| Callback scheduled for 10 ms | 332.04 ms | 10.05 ms |
| Blocked write | 329.92 ms | 330.40 ms |
| 1,000 tiny sequential reads | 13.97 ms | 127.58 ms |
| Open/first-query setup | 12.14 ms | 118.20 ms |

This demonstrates responsiveness, not faster locked writes or higher tiny-query
throughput. Worker setup/message/copying costs and long-transaction serialization
remain. The controlled PDF probe painted after 207,212 of 7,022,956 bytes, matched
the complete-file raster and cleared pages after deletion; that synthetic layout
is not a natural-corpus or production-latency estimate. Original measurement
context remains in [the pre-consolidation history](https://github.com/eliziff/Beaver/tree/5463edeae9b97c49f2587ad13f00a73534c39746/docs).

Do not add percentages across unrelated probes. No whole-application cloud/model/
OCR/Windows performance claim follows from them. A converter process pool,
speculative indexes and persistent text reuse were not implemented merely to close
a proposal: they require real workload/query-plan/build-identity evidence. No Redis,
new queue service, weaker model or parser rewrite is implied.

## Focused reproduction

Install the locked dependencies and follow [shared checks](../../CONTRIBUTING.md).
Relevant test areas are collection reuse/identity/prefetch, document text/access,
PDF sources/ranges/viewer, SQLite worker/statements and job-event batching. Use the
specific test files beside those modules, not an unrelated full release battery.
The existing probes are:

```sh
node scripts/test-collection-reuse.mjs frontend/dist /path/to/baseline/dist .perf/collections
CHECK_NAVIGATION_PREFETCH=1 node scripts/test-collection-reuse.mjs frontend/dist '' .perf/navigation
node scripts/benchmark-document-text.mjs /path/to/baseline .perf/document-text.json
node scripts/test-pdf-first-use.mjs .perf/pdf-first-use /path/to/pinned/baseline
node scripts/test-pdf-range-loading.mjs .perf/pdf-ranges
node scripts/benchmark-database-events.mjs /path/to/pinned-baseline .perf/database-events.json
BEAVER_BENCH_COMPILED=1 node scripts/benchmark-sqlite-responsiveness.mjs .perf/sqlite-responsiveness.json
```

Browser probes need the appropriate production build/harness and installed
Playwright Chromium. The SQLite responsiveness probe needs compiled backend
modules. Environment-prefix examples above use a POSIX shell; set the equivalent
process environment in PowerShell. Keep baselines pinned and output disposable.
For PostgreSQL event cases, `BEAVER_TEST_POSTGRES_URL` must point to a disposable
loopback server whose test user can create/drop the randomly named databases,
never a shared or production server.

The probes intentionally isolate different dependencies and check output identity,
ordering, access and invalidation. Their synthetic inputs and controlled native
DOCX/PDF edges are not substitutes for parser fidelity, private-document tests or
authorized live-model/real-host release evidence.
