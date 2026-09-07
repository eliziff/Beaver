# Performance work: implementation closeout

This final PR completes the remaining concrete implementation work in one change against main at `2312e060fbde236e1f5d030e4c92bb1571aa1f3a`. It preserves the previously merged performance, research and Authorities changes. There are no prerequisites to merge from another feature branch and no duplicate copies of earlier performance implementations.

| Original proposal | Delivery |
| --- | --- |
| Cold startup dependencies, request count, compression and transient loading flashes | PR #2 |
| Separate chat/preparation/bulk capacity and durable change notifications | PR #4 |
| Collection snapshot reuse and precise history refreshes | PR #5 |
| Steering must not hold cancellation, cleanup or a worker slot | PR #7 |
| First/cited PDF page before all metadata, bounded file cache and less offscreen DOM | PR #8 |
| Prepared-statement reuse and timer-free durable event INSERT batching | PR #9 |
| Version/options-aware extracted-text reuse without caching authorization | PR #14 |
| SQLite lock/query execution off the HTTP event loop | This PR: dedicated worker using the existing relational port and statement cache |
| Authorized, integrity-preserving PDF byte ranges | This PR: verified range route, pinned transport and failed/invalidation cleanup |
| Intent-driven route/collection prefetch | This PR: bounded pointer/keyboard prefetch through existing query identities |

## Focused integration evidence

The final candidate passes 83 focused backend tests across 11 database, queue, cancellation, replay and range-route files, and 73 focused frontend tests across seven PDF, file-cache, prefetch, collection and sidebar files. Backend production compilation and frontend type checking pass. Production backend/frontend/shared source-import boundaries pass on the materialized checkout. The source-import check covers the materialized production source; it is not a full release gate. No experiment code is changed.

The PDF browser probe uses actual document routes, SQLite and filesystem storage, and the real PDF.js renderer. It displays page one of a controlled 7,022,956-byte file after receiving 207,212 bytes, navigates deeper using the same verified representation, and removes all page content after deletion is detected. Full-file and ranged first-page raster bytes match. Unit tests separately cover explicit invalidation of active complete-file and cached-file viewers. There is no new server-push revocation mechanism.

The production navigation probe verifies both pointer and keyboard intent: the first Projects request begins while the user is still on Library, and navigation uses that same single request. It also checks two-page collection reuse, refresh and deletion. Browser probes record no page errors; their automation-observed navigation times are not presented as statistical performance estimates.

Five alternating fresh-process SQLite samples isolate a 300 ms competing write lock. A main-thread callback scheduled for 10 ms runs at a median 332.04 ms inline versus 10.05 ms with the worker. The write itself still takes about 330 ms. The same samples expose the cost: connection setup increases from 12.14 to 118.20 ms and 1,000 tiny sequential queries from 13.97 to 127.58 ms. This is a responsiveness trade-off, not a blanket cold-load or database-throughput speedup.

See `sqlite-worker.md`, `pdf-range-loading.md` and `navigation-prefetch.md` for precise runtime contracts and reproduction commands. Test logs, raw samples, browser reports and the published source manifest accompany the PR in the conversation validation archive. No full CI battery, native build, paid-model calls or whole-application release sweep was run. Required CI policy is unchanged.

## Conditional ideas deliberately not implemented

An Office-converter process pool was exploratory, conditional on evidence of frequent actual conversions. The document application already saves and reuses version-specific PDF renditions. No measured production workload establishes that retaining LibreOffice processes outweighs its resource and isolation costs, so this PR adds no pool. That is a deliberate non-change, not a claim that a pool was implemented.

Indexes and expensive-query tuning were likewise conditional on realistic query plans. The statement cache removes repeated compilation; the worker isolates lock/query execution. Neither justifies speculative indexes based on synthetic workloads. The synchronous class remains available to existing tests and the comparison benchmark, not as a new runtime switch.

Persistent/cross-process text reuse remains outside PR #14's explicit process-memory scope. This avoids treating an adapter version as a native compiler fingerprint or persisting permission decisions. No Redis, new queue service, weaker model or parser rewrite is introduced.

## Measurement limits

Each probe measures a different dependency; their percentage gains must not be added. SQLite workers add startup/message overhead. PDF range savings depend on object layout and still require full source verification at the server on a cache miss. Text reuse adds metadata checks on cold reads. These costs are recorded rather than masked by a loading-state change.

Live multi-user cloud latency, provider first-token times, actual OCR corpora, HTTP/2 deployment behavior and Windows launcher smoke were not measured here. The reproducible focused probes close the concrete code work, not every possible production tuning or observability question. No claim is made that every initial load is imperceptible.
