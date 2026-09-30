# Performance contracts and reproduction

This guide owns the implemented cache, transport and worker contracts. It replaces
per-PR progress notes; it is not a promise that all loads are imperceptible.
Measurements below are recorded evidence, not fresh measurements of every build.
[Architecture](architecture.md) owns application boundaries and
[background jobs](background-jobs.md) owns scheduling/durable delivery.

## Printed-page navigation measurement (September 27, 2026)

The viewer's printed-label request reuses prepared native structure, including
partial OCR. Without prepared data it runs native extraction with OCR and layout
models disabled. Rendering proceeds independently. The existing projection cache
coalesces requests and retains weak references keyed by document, version, source
hash and preparation key. Label lookup preserves repeated labels and gaps.

A local Windows/Node 22.20.0 release-addon check used nine PDFs (52 pages): seven
synthetic documents with labels fixed before extraction and two existing public
PDFs with source-reviewed footer labels. Across three fresh-cache runs, median
operation times (including extraction, excluding HTTP and rendering) were:

| Input | Pages | Cold median |
| --- | ---: | ---: |
| Arabic 101–108, first call including native module initialization | 8 | 247 ms |
| Roman i–iv | 4 | 21 ms |
| Repeated 1–3 sequences | 6 | 34 ms |
| Missing labels | 4 | 17 ms |
| Conflicting header/footer labels | 4 | 18 ms |
| Prefixed A-1–A-4 | 4 | 16 ms |
| Scan without OCR | 3 | 49 ms |
| SEC complaint 25666 | 9 | 368 ms |
| Illinois opinion 05-cv-03198 | 10 | 121 ms |

Five immediate in-memory repeats per input had medians below 0.1 ms and did not
reread source bytes; these are service timings, not end-to-end latency promises.
The two public source SHA-256s are
`8c4578992501e4d3739e07e81b81e52b88d93e429afe6e1cefedec0585615027` and
`fa3081cf2f54431cfe969c9e71be3b262847f9978285edc0c243dcba7a4d9564`.
Their first pages have docket stamps but no standalone footer label; this check
scores footer labels, not numbers embedded in filing stamps.

Reliability: 37 correct labels, zero incorrect emitted labels, seven missed
labels (four prefixed labels and three unrecognized scans), and eight correct
abstentions for missing/conflicting labels. All 17 public-PDF footer labels were
correct. Repeated labels were retained. This small sample is not a broad accuracy
estimate. The unchanged detector accepts Arabic/Roman labels, not A-1 prefixes.

A separate three-page scan selected only pages 1 and 3 for Kraken-lite OCR. That
pass took 1.57 s and recognized body text but omitted both footer numbers. Reading
its stored labels took 4.1 ms, read no source bytes and returned three blanks;
page 2 remained unrecognized. Partial-OCR reuse is verified, but scanned-page
number accuracy is not established. Reporter-offset inference remains separate.

## Collections and navigation

Authorities citation review indexes units once and counts body occurrences in one
ordered pass for location labels. Selecting another citation does not rescan every
preceding occurrence against every unit. The loaded list still renders in full;
this improvement does not establish a latency or memory bound for larger ledgers.

Chat history, Projects, Library files/templates, project directories, shared pickers and tabular
collections reuse one paged-collection engine. Resource, account/project/Library
scope, query, filters and page size define identity. Sources' manually loaded,
revision-sensitive passage/finding chains remain component-local. When the Sources
highlight tree is present, its saved per-source counts warm only the passage chains
known to contain highlights; expanding a highlight type reuses that snapshot instead
of starting a request or showing a loading row.

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
The receipt includes hardware, runtime, profile, native-library identity and
preparation CPU time to help distinguish processing work from wall-clock delays.

Create the baseline once. Later runs replace the owned `candidate` directory and
compare against the frozen baseline under matching conditions. Identical products
retain only hashes; changed products retain compressed text and anchors. The
runner removes its application cache after recording the result and returns a
failure status when candidate preparation fails or exceeds the frozen baseline's
preparation time.

## PDF rendering and transport

`shared/browser-pdf.mjs` owns document byte ownership, the app-lifetime PDF worker,
decoder fetching and viewer configuration/disposal for Beaver and the full
Authorities HTML. Their host adapters supply the matching PDF.js 6.3.289 module
and assets. `shared/pdf/viewer.ts` is their framework-independent session for
resident text layers, annotation overlays, page navigation, resize, gestures and
disposal. A rendered page updates its own geometry and marks rather than
synchronizing the whole document.

Authorities Lite retains its own viewer and a matched PDF.js 4.10.38 API/worker.
It reuses Beaver's printed-page binding, page-navigation component and annotation
writer. Lite requests omitted author/comment metadata from that writer. Its cards,
selection and undo state remain Lite-owned.

In the shared viewer, closing a loading task releases that document, not the
app-lifetime worker. Byte-backed
opens copy at this boundary so worker transfers cannot detach callers' originals.

For the full Authorities `file:` HTML, the adapter supplies an inline data URL to an explicit module
Worker. Chrome's module blob wrapper failed in the local reproduction and silently
selected PDF.js's main-thread fake worker. The explicit worker avoids that path.
Hosted pages use PDF.js's normal worker creation. Worker/decoder URLs and package
embedding stay in the host; source acquisition, persistence, OCR priorities and
highlight/export policy stay outside the shared runtime.

Legal Browser OCR's layout worker now accepts a transferred ImageBitmap and reads
its pixels through OffscreenCanvas inside the worker. Platforms without these APIs
retain the pixel-buffer path. Termination rejects pending work and closes bitmaps;
worker allocations are released on success and failure. A browser comparison
against the pinned worker returned identical 40-line geometry for both new paths,
with large main-thread pixel readbacks reduced from one to zero on the bitmap path.
This changes transport, not recognition models, grayscale policy or page geometry.

Earlier September 27 long-task observations (the presentation traces were truncated
and cannot establish scrolling latency): the full HTML's 10-second Oakes sweep recorded one
55 ms long task at normal CPU speed; a separate paused-OCR run recorded none.
At 4x CPU throttling it recorded 55 long tasks
(maximum 312 ms); pausing OCR still left 78 (maximum 174 ms). These individual runs
mix first visits and revisits and are not a latency guarantee or a controlled speedup
ratio. They confirm removal of large main-thread OCR readbacks, while raster drawing
and other UI work can still stall under load. Full/Lite browser checks cover real
workers, viewing, selection, highlights, export and reopening; Lite is checked from
both file and HTTP origins. The assistant-dock smoke passed with screenshot review.

The local candidate consumes the owning `legal-browser-ocr` checkout through
`AUTHORITIES_OCR_SOURCE`; Lite records its layout/source hashes in `SOURCES.json`,
and full Authorities includes the layout hash in its OCR cache identity. Publish
and pin the reviewed Beaver/OCR revisions before a standalone release: the current
published Beaver pin does not yet contain the new shared files. Build-time copies
are generated inputs, never a second maintained implementation.

The shared reader uses PDF.js's `PDFViewer` for page geometry, visible-page priority,
scroll-direction preloading, resumable rendering, zoom previews and bounded page
retention. Authorities (embedded and full standalone), court-record previews,
assistant/document panels and research citation views use this same component.
There is no second application-owned raster scheduler. GPU-friendly canvas contexts
are enabled at document creation, with PDF.js's screen-area canvas budget at device pixel ratios up to 2;
PDF.js normally retains ten pages and increases its cache when more pages are
simultaneously visible. PDF.js 6.3.289 uses its official compatibility build and
packaged JBIG2, JPEG2000 and colour-management WASM assets, including inline assets
in the full Authorities HTML. Detail canvases sharpen visible zoomed regions at
device pixel ratios up to 2; above that a two-million-pixel base raster trades sharpness
for bounded allocations. These are canvas/cache bounds, not a cap on decoded
images or total process memory. Keep PDF.js's default unlimited source-image size:
`maxImageSize` discards oversized images rather than downsampling them, leaving
scanned pages blank. Native text layers use the matching PDF.js `textLayer` CSS;
recognized OCR layers retain their explicit box geometry.

The viewer uses PDF.js's `removePageBorders` option. Its default nine-pixel page
border conflicts with the host's border-box sizing: the canvas becomes 18 pixels
smaller than the text layer, and normalized selection rectangles use a different
origin from their overlays. Borderless pages give the canvas, native/OCR text and
selection overlays the same bounds, without compensating offsets or custom scaling.

A September 27 local Chrome diagnostic rendered public Oakes scan pages 1, 20 and
41 at scale 1.25 with separate PDF.js 6.3.289 loading tasks and OCR disabled. Their
combined render times were 1,053 ms using that version's JavaScript fallback and
507 ms using WASM; the factory recorded loading `jbig2.wasm`, with no decoder
warnings. This single three-page comparison excludes document opening and does
not establish an old-version speedup or a scrolling-latency bound.

Beaver retains its source/range handling, quote search, OCR text selection and saved
annotation overlays. Text layers follow the resident page lifecycle; OCR refresh
waits for a live selection to finish. Quote matches and marks are reapplied when
PDF.js recreates a page. A temporary visible-page bitmap preserves the display while
a replacement source loads. Unknown geometry stays hidden until resolved, and
annotation navigation awaits the target page's exact geometry. Whole-line selection
uses cached line bounds without measuring every selected character.

A foreground rapid-scroll diagnostic on the public Oakes scan at 1.25x DPR
recorded 217 detail renders with the previous two-million-pixel override and zero
with the standard canvas budget (34 base-page renders in each run). Both runs had
roughly 17 ms p95 frame intervals. This establishes less redundant rendering, not
a fix for intermittent movement freezes under load. Higher-DPI allocation limits
remain unchanged.

Ctrl-wheel and pinch call PDFViewer's `updateScale` once per animation frame, with
its 150 ms raster redraw delay. The canvas scales during the gesture; text layers
settle afterward. Pointer coordinates are converted for nested modal offsets before
passing the zoom origin to PDF.js. This adds no foreground-idle gate to OCR: its
existing page queue, explicit pause/cancel and priorities are unchanged.

Full standalone Authorities caches completed OCR pages independently by source,
processing identity and page index. Only the new page is serialized; eviction reads
separate size/time metadata. Memory and persistent payload budgets remain 64 MiB
apiece, not a bound on total process memory. Cache schema 2 discards old disposable
OCR results, without touching drafts. Lite keeps its existing storage behavior.

The custom wheel listener remains non-passive to preserve PDF-only Ctrl-wheel and
trackpad zoom. The shared viewer sets `will-change: transform` on the scroll
container while it is mounted, so Chrome can move that layer without waiting for
page painting on the main thread. Only the scroll container is promoted, not every
PDF page; disposal restores the previous style. This uses the browser compositor,
not another application scroll scheduler. Fast-scroll frame timing and page readiness must be measured
separately; a steady frame rate does not prove the absence of blank pages. Neither
the focused tests nor the scan probe establish a universal scrolling-latency bound.
Rapid wheel sweeps through the public Oakes scan still expose pages waiting for
their first decode. Discard timing runs when the browser throttles a covered tab;
keep fresh-load and previously visited-page measurements separate.

The September 27 compositor check compared the same built HTML and public Oakes
scan at 4x CPU, changing only the scroll container's `will-change` value. The
maintained probe uses `PROFILE_COMPOSITE=0` to disable that style for the control.
Continuous gestures produced these input-to-presentation and compositor results:

| OCR / sweep | p95 before | p95 after | Janky frames before | Janky frames after |
| --- | ---: | ---: | ---: | ---: |
| Paused / cold | 98.8 ms | 33.6 ms | 15.8% | 0.5% |
| Paused / revisit | 83.0 ms | 33.5 ms | 9.9% | 0.2% |
| Running / cold | 115.8 ms | 49.9 ms | 28.3% | 2.5% |
| Running / revisit | 99.7 ms | 49.9 ms | 22.0% | 3.9% |

An earlier style-only probe also measured 33-34 ms p95 with OCR paused. These
controlled local runs establish a substantial reduction in routine scroll delay,
not elimination of every stall: the final candidate still had 150-200 ms maximum
presentation gaps. Retained canvases stayed at 25.4 MiB; compositor/GPU memory is
separate and was not measured. Page decoding can still lag behind fast movement.
Input hashes and complete traces are in the disposable `pdf-composite-ocr*-layer*`
receipts (HTML `6323d7b97fe4...`, PDF `12a8077085ce...`). Earlier discrete-wheel
matrices are repeated-gesture-start stress tests, not continuous-scroll evidence.

Authorities fetches OCR for resident pages rather than retaining a document-wide
JavaScript sidecar. A 1–16 page request restores only the cache artifacts owning
those pages and filters in Rust before serialization. The existing eight-entry
weak projection cache shares pending restorations. A restored Rust artifact is
still whole-document data: this is not random-access native storage. Unfiltered
internal annotation preparation remains available and never starts another OCR pass.

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
context remains in [the pre-consolidation history](https://github.com/eliziff/Beaver/tree/d2b1880c1cb823303d3da29b50ac50430b6ce0fa/docs).

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

Authorities' maintained `modern/test-pdf-performance.mjs` runs the actual HTML
smoke setup against a saved baseline and candidate, alternating three repetitions
at normal and 4x CPU, with OCR running and paused. It also runs unmodified PDFViewer
as an OCR-paused reference against the same bytes, viewport, PDF.js and decoder assets.
Each run separates a first sweep from a revisit; neither reverses at a scroll boundary.
By default it uses Chrome's continuous synthetic scroll gestures and requires
updates within those gestures. `PROFILE_GESTURE=discrete` is a separate stress
mode: Chrome begins and ends a gesture for each injected mouse-wheel event, so
those results must not be presented as continuous-scroll latency. See Chromium's
[input implementation](https://github.com/chromium/chromium/blob/main/content/browser/devtools/protocol/input_handler.cc).
The trace reader requires both interval markers, coverage and Chrome's no-data-loss
flag. It records compositor scroll-event latency/jank, presentation gaps, page readiness,
long tasks and retained canvas bytes. Results and input hashes belong in disposable
output, rather than an application telemetry service.

```sh
node AuthoritiesHelper/modern/test-pdf-performance.mjs baseline.html candidate.html public-scan.pdf .perf/pdf-scroll
```

The probes intentionally isolate different dependencies and check output identity,
ordering, access and invalidation. Their synthetic inputs and controlled native
DOCX/PDF edges are not substitutes for parser fidelity, private-document tests or
authorized live-model/real-host release evidence.
