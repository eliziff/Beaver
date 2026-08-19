# Beaver background jobs

Status: implemented and verified.

This is the one background-work design for local SQLite and cloud PostgreSQL.
It replaces process-local promise tails and PDF-specific queues outright. Beaver
has no users, so there is no compatibility queue, migration bridge, or dual-run
period.

## Why this shape

Background work must survive a process restart, deduplicate repeated requests,
bound expensive work, expose honest progress, and work when more than one cloud
instance is running. An in-memory queue cannot do those things. Redis/BullMQ,
Temporal, and a separate worker service add infrastructure Beaver does not need.
Graphile Worker, pg-boss, and Supabase Queues are mature PostgreSQL choices, but
adopting one would require a second queue for account-free SQLite mode.

Beaver will use the established database-queue model with one small portable
repository:

- a logged jobs table;
- atomic claims and visibility leases;
- bounded retries with backoff;
- idempotency keys and priorities;
- cooperative cancellation and crash recovery;
- a fixed handler allowlist;
- small, identifier-only payloads.

This follows PostgreSQL's documented queue use of `SKIP LOCKED`, Supabase
Queues' visibility-timeout model, and the job-key/attempt/lease model used by
Graphile Worker and pg-boss:

- <https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
- <https://supabase.com/docs/guides/queues>
- <https://worker.graphile.org/docs/jobs-view>
- <https://github.com/timgit/pg-boss/blob/master/docs/database-backends.md>
- <https://sqlite.org/lang_returning.html>

## Contract

`application_jobs` is server-only application data. Browser clients and
Supabase `anon`/`authenticated` roles receive no table or function access.

Each row contains:

- an opaque ID and fixed task kind;
- a unique, bounded idempotency key;
- a small JSON payload containing durable IDs, never bytes, credentials,
  arbitrary paths, remote URLs, or prompts;
- priority and `run_at`;
- `queued`, `running`, `succeeded`, `failed`, or `cancelled` state;
- attempt/max-attempt counts and a bounded non-secret error category;
- `locked_by`, `locked_until`, and a cancellation request timestamp;
- bounded progress and result JSON;
- created/updated/completed timestamps.

Task handlers are a compile-time map. Unknown kinds fail closed. A handler must
reload its source through the application repository, re-authorize or use a
server-owned internal identity, and verify the immutable content hash before
work begins. Jobs are at-least-once; handlers and publication are idempotent.
The parser's content-addressed cache is the authority, not job completion.

## Claiming and execution

The queue has one semantic repository and one tiny dialect seam:

- PostgreSQL claims with a short transaction using `FOR UPDATE SKIP LOCKED`.
- SQLite claims in `BEGIN IMMEDIATE` with a conditional update.

Both return the claimed row only after setting a fresh lease and incrementing
the attempt. No transaction remains open while a handler runs. A heartbeat
extends the lease and checks cancellation. If a process dies, another worker
may reclaim the job after the lease. Completion/failure updates require the
matching job ID and worker token, so a stale worker cannot overwrite a newer
attempt.

Defaults are deliberately boring: one expensive-document worker per process,
a five-second heartbeat, a 30-second renewable lease, three attempts, capped
two-to-60-second exponential backoff, and a one-second idle poll. Shutdown
stops claims, requests cancellation, waits for the running handler to release
its lease, and then closes the repository.

Producers insert a job in the same database transaction as the durable domain
change (transactional outbox). A committed document version therefore cannot
lose its preparation request. Completed rows are pruned after a short retention
window; prepared content remains reusable in the parser cache.

## PDF policy

There are two normal job forms behind one handler:

1. `pdf.prepare` (priority 0) performs native extraction for the whole upload
   and OCRs only pages classified as weak. Upload returns after object and
   metadata commit; it never waits for parsing. It never invokes remote vision.
2. `pdf.pages` (priority 100) prepares only explicitly requested pages. Repeated
   callers join the same idempotency key and wait for its small cache-key
   result. Enqueueing it requests cancellation of a lower-priority full-document
   job for the same source. The worker checks that request at heartbeat and
   subprocess cancellation boundaries, then the full job resumes from immutable
   cached work later.

The UI keeps one activity ID and changes its label as durable progress changes:
`Inspecting page 5` -> `Running OCR on page 5` -> `Reading page 5`. It does not
emit three duplicate activities. A completed content-addressed page is reused
without OCR. Whole-document search, Table of Authorities, and structure work
may await the full projection. Remote multimodal layout is an explicit user or
operator action only, never an automatic fallback.

An explicit reprocess request is a third, user-initiated form. It may choose
Tesseract or Kraken-Lite OCR and the installed local PP-DocLayout runtime. It
uses the same source-bound group, queue, limits, and parser cache; there is no
second PDF queue or in-process promise tail.

Routing is page-local and evidence based:

- use native text when the engine's existing quality classifier accepts it;
- OCR only weak/empty requested pages;
- do not guess from file size or page count;
- do not send documents to a remote vision model merely because OCR is slow;
- surface a durable, actionable failure when local extraction and OCR both fail.

### Why this is the boring route

This is the established document-processing pattern, not a Beaver-specific
invention. OCRmyPDF's normal safe modes preserve or skip pages that already
contain text and allow selected-page OCR. PyMuPDF recommends deciding per page,
notes that OCR is roughly a thousand times slower than ordinary extraction,
and reuses one cached OCR text page for later reads. Google Document AI likewise
exposes embedded-PDF text extraction, page-level quality signals, and explicit
page selection. The common rule is: extract native text first, measure whether
it is usable, OCR only the deficient page, and reuse the result.

- <https://ocrmypdf.readthedocs.io/en/latest/advanced.html#when-ocr-is-skipped>
- <https://ocrmypdf.readthedocs.io/en/latest/cookbook.html#process-only-certain-pages>
- <https://pymupdf.readthedocs.io/en/latest/recipes-ocr.html>
- <https://docs.cloud.google.com/document-ai/docs/enterprise-document-ocr>

An agent receives the bounded text and structure produced by that pipeline.
It should not render a page for a multimodal model merely because a PDF was
uploaded. Image understanding is a different, explicit capability for a
genuinely visual question or a reviewed local-layout experiment; it is not an
OCR timeout fallback.

## Security and operations

- Enforce payload and result size limits before storage.
- Store no secrets, signed URLs, raw document bytes, or user-controlled paths.
- Validate every handler payload again at execution.
- Pin document ID, version ID, source SHA-256, parser identity, and requested
  pages in the idempotency key and projection identity.
- Cap page lists, attempts, concurrency, runtime, subprocess output, and logs.
- Redact unexpected errors; persist only a stable category for users/operators.
- Revoke public database access to the table and expose no generic enqueue HTTP
  endpoint.
- Expose bounded status, phase, attempts, and terminal failure categories without
  emitting payload contents; queue depth and age remain available from the
  server-only jobs table for operational monitoring.

## Acceptance gates

1. Repository tests prove atomic claim, duplicate enqueue/join, lease expiry,
   stale-worker rejection, retry/backoff, cancellation, priority, payload caps,
   and identical SQLite/PostgreSQL outcomes.
2. Upload tests prove the response does not await parsing and the job is
   committed atomically with the version.
3. Parser tests prove foreground page work preempts and later resumes a full
   preparation without concurrent writes or duplicate cache work.
4. Every page in the entire available legal-PDF corpus is compared between the
   page-targeted and canonical full preparation. Text, structure, order,
   locators, evidence hashes/handles, and links must be exact. No representative
   samples or proxy metrics are accepted.
5. ChromeDriver verifies honest progress, refresh consistency, cancellation,
   corrupt-file errors, and shared PDF/DOCX/XLSX/text viewers.
6. Live Luna reads exact pages from newly uploaded native and scanned PDFs,
   reuses evidence without a duplicate Read, survives a backend restart, and
   cannot access another user's/project's job or document.
7. Backend/frontend tests, builds, and the full local smoke command pass before
   commit and push.

## Verification receipt

Tests cover active dedupe, priority monotonicity, same-source foreground
preemption, different-source isolation, atomic SQLite and PostgreSQL claims,
stale lease recovery, bounded retry/backoff, owner-scoped cancellation,
progress/result limits, transactional PDF enqueue, and multi-worker claims.
Document responses expose the latest durable state and phase, and the Library
UI polls only while visible queued or running work exists.

The cache-contract corpus gate passed all eight available PDFs and 425 pages:
1,275 targeted page/context comparisons, 7,567 paragraph locators, 45 published
bounded sections, 677 footnotes, 10,365 structural queries, 14,264 fresh
contract calls, and 16 corrupt-cache rebuilds, with exact cold/warm,
direct/prepare, and full/targeted values except the expected cache-hit flag.
Source text, IDs, page bindings, order, evidence inputs, source-byte separation,
and cache-key separation all matched.

ChromeDriver verified immediate mixed-file uploads, the shared
PDF/DOCX/XLSX/text viewer, React action menus and rename, legislation search,
lazy model-catalog loading, reasoning-effort display, and durable OCR progress.
Live Luna turns through a Codex subscription read exact pages from both native
and scanned PDFs, persisted evidence and completion state, and survived a
backend restart without a stopped or interrupted response. Full backend and
frontend tests, production builds, and the launcher-owned Beaver/Authorities
smoke passed before release.
