# Database statement reuse and event writes

## Runtime contracts

The local relational adapter retains at most 128 prepared statements per connection,
ordered by last successful use. It caches compiled SQL, never query results. Every
execution still binds its parameters, reads the database, and observes the existing
transaction, foreign-key, ownership and durability contracts.

Only ordinary SELECT/INSERT/UPDATE/DELETE/WITH statements are retained. SQL exceeding
8,192 UTF-16 code units or bindings exceeding 64 KiB are not retained; this prevents
large native parameter buffers remaining reachable through the statement LRU. The
limits cover retained entries, not all SQLite/native/process memory. Statements are
removed before execution and reinserted only on success. Errors, oversized bindings,
DDL/PRAGMA, transaction rollback and connection close cannot leave a stale retained
statement. Schema changes must pass through the adapter or use a reopened connection;
live external schema migration is not supported by Beaver's versioned local runtime.

Node 22 is still supported; no SQLTagStore dependency or runtime upgrade is required.
No local database thread/process change or busy-timeout/durability relaxation is made.
SQLite work remains synchronous, so expensive individual queries or lock waits are
not made nonblocking by this change.

The job event writer keeps each event's original JSON, sequence and timestamp. It
combines available rows into one parameterized INSERT, with at most 64 rows and 64 KiB
of event JSON per multi-row batch. The existing maximum 512 KiB single event is still
accepted as its own batch. Statements have at most 256 parameters on both SQLite
and PostgreSQL. This is write batching, not semantic text coalescing.

The first batch starts on the existing Promise microtask boundary; there is no
batching timer or minimum dwell. Rows arriving while a previous write is pending can
share the next bounded batch. flush() seals its accepted prefix: later appends cannot
extend its wait. A failed batch commits no rows from that statement, sends no success
notification and keeps subsequent flushes rejecting. Earlier committed batches remain
available to owner-scoped replay. No failed batch is skipped. Notification transport,
queue capacity, handler lifecycle and retry policy are unchanged. As before, the
writer assumes a single writer for a leased job; this is not a multi-writer allocator
or a global producer-backpressure mechanism.

## Focused reproduction

With locked backend dependencies installed:

```sh
cd backend
npx vitest run src/lib/__tests__/sqliteStatements.test.ts src/lib/__tests__/jobEventBatching.test.ts src/lib/__tests__/relationalDatabase.test.ts src/lib/__tests__/relationalRepositories.test.ts src/lib/__tests__/jobQueue.test.ts src/lib/__tests__/jobScheduling.test.ts src/lib/__tests__/chatCommands.test.ts src/lib/__tests__/chatTurnTransport.test.ts
npx tsc --noEmit --incremental false
cd ..
node scripts/benchmark-database-events.mjs /path/to/pinned-baseline .perf/database-events.json
```

To run the seven event-writer cases against PostgreSQL, set BEAVER_TEST_POSTGRES_URL
to a disposable loopback PostgreSQL server and run only jobEventBatching.test.ts.
The fixture creates and drops randomly named databases; its user needs CREATEDB.
Do not point it at a shared or production server.

The microbenchmark uses fresh processes/databases, five samples per variant, and
alternates candidate/baseline order. It tests 10,000 indexed owner-scoped reads;
1,024 text events in bursts of 64 plus first/final events; and a sparse control that
flushes each of 128 text events. Event replay is checked in full, including order and
payloads. The read fixture is in-memory SQLite; event writes use the real local WAL
schema in an isolated temporary directory. Setup and module loading are outside the
reported operation duration. First-event durability is reported separately.

These measurements isolate database overhead. They do not establish an application
startup, model-generation, HTTP first-token, cloud, OCR or end-to-end speedup. No
paid model, native parser build or full CI battery is required.
