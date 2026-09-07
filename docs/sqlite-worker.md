# SQLite responsiveness

The local relational adapter runs its existing synchronous SQLite connection in one dedicated worker per backend process. Feature code still uses the same relational persistence port; cloud PostgreSQL behavior is unchanged. This builds on the prepared-statement reuse in PR #9, not a second cache or queue service.

## Contract

The parent serializes requests and reserves the connection across an asynchronous transaction callback. Nested transactions join the outer transaction. Commit notifications remain in the parent and are published only after the worker acknowledges COMMIT; a rollback drops them. Ordinary query parameters are captured before queuing, and message transport captures transactional parameters before native execution. Ended transaction handles cannot submit more queries. SQLite error details are preserved. A worker failure rejects pending and future operations without replaying writes whose outcome may be unknown. Shutdown drains accepted operations and terminates the worker.

The compiled production worker loads its own CommonJS file. Source-mode development and focused tests use the existing tsx dependency; request data is never executable code. The old synchronous handle is retained for existing isolated tests, not used by application repositories. The schema version, file permissions, WAL mode, foreign keys, lock timeout and cached-statement bounds remain unchanged.

## Measured trade-off

Five alternating fresh-process samples on Node 22.16.0/Linux, using compiled production modules, a disposable database, and a second writer holding a lock for 300 ms:

| Median | Inline | Worker |
| --- | ---: | ---: |
| Callback scheduled for 10 ms during the held write | 332.04 ms | 10.05 ms |
| Blocked write itself | 329.92 ms | 330.40 ms |
| 1,000 sequential tiny indexed reads | 13.97 ms | 127.58 ms |
| Open/first-query setup | 12.14 ms | 118.20 ms |

The callback measurement demonstrates that the HTTP process can continue handling unrelated work during a database lock wait; it is not an HTTP latency benchmark. It does not make the locked write complete sooner. Worker startup is paid once per connection. Tiny queries incur message overhead (about 0.114 ms additional per query in this sample), and large result sets require copying. This is not a whole-application cold-start or live-cloud benchmark. Long transactions still serialize other queries on this connection. Large queries and indexes should be tuned from real query plans, not guessed.

## Focused checks

```sh
cd backend
npx vitest run src/lib/__tests__/sqliteWorker.test.ts src/lib/__tests__/sqliteStatements.test.ts src/lib/__tests__/relationalDatabase.test.ts src/lib/__tests__/jobQueue.test.ts src/lib/__tests__/jobScheduling.test.ts src/lib/__tests__/jobEventBatching.test.ts
npx tsc --incremental false
cd ..
BEAVER_BENCH_COMPILED=1 node scripts/benchmark-sqlite-responsiveness.mjs .perf/sqlite-responsiveness.json
```

The worker regressions use actual SQLite connections and worker termination: blocked-writer responsiveness, transaction ownership/nesting/rollback, commit-only notifications, immutable request snapshots, failure without replay, and durable shutdown/reopen. Integrated targeted checks also cover existing cancellation, command delivery and event replay; no full application suite or live model is needed.
