// Narrow, local-only microbenchmarks. No model calls, native parser, or user data.
// node scripts/benchmark-database-events.mjs [BASELINE_CHECKOUT] [REPORT_JSON]
// Both checkouts need the locked backend dependencies (tsx is already included).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(self), '..');
if (process.argv[2] === '--sample') {
  const [checkout, scenario] = process.argv.slice(3);
  const require = createRequire(path.join(checkout, 'backend/package.json'));
  require('tsx/cjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'beaver-db-bench-'));
  process.env.AUTH_MODE = 'local'; process.env.MIKE_LOCAL_DATA_DIR = directory;
  const module = require(path.join(checkout, 'backend/src/lib/relationalDatabase.ts'));
  let database, elapsedMs, firstDurableMs, checksum = 0, sqlPrepares = 0, inserts = 0;
  try {
    if (scenario === 'indexed-reads') {
      const { DatabaseSync } = require('node:sqlite'), native = new DatabaseSync(':memory:');
      native.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, owner TEXT, value INTEGER)');
      const put = native.prepare('INSERT INTO entries VALUES(?, ?, ?)');
      for (let i = 0; i < 1_000; i++) put.run(i, `user-${i % 2}`, i);
      const prepare = native.prepare.bind(native);
      native.prepare = text => { sqlPrepares++; return prepare(text); };
      database = new module.LocalDatabase(native);
      const started = performance.now();
      for (let i = 0; i < 10_000; i++) {
        const id = i % 1_000;
        const result = await database.query(module.sql`SELECT value FROM entries WHERE id=${id} AND owner=${`user-${id % 2}`}`);
        checksum += result.rows[0].value;
      }
      elapsedMs = performance.now() - started;
      assert.equal(checksum, 4_995_000);
    } else {
      const queue = require(path.join(checkout, 'backend/src/lib/jobQueue.ts'));
      database = await module.relationalDatabase();
      const job = await queue.enqueueJob({ kind: 'benchmark', dedupeKey: 'one', userId: 'owner', payload: {} });
      const writer = await queue.createJobEventWriter(job.id);
      const native = module.localDatabaseSync(), prepare = native.prepare.bind(native);
      native.prepare = text => { sqlPrepares++; return prepare(text); };
      const query = database.query.bind(database);
      database.query = statement => {
        if (/INSERT INTO\s+application_job_events/u.test(statement.text)) inserts++;
        return query(statement);
      };
      const first = performance.now();
      writer.append({ type: 'content', text: 'first' }); await writer.flush();
      firstDurableMs = performance.now() - first;
      const count = scenario === 'event-bursts' ? 1_024 : 128;
      const started = performance.now();
      for (let i = 0; i < count; i++) {
        writer.append({ type: 'content', text: `${i}:${'x'.repeat(200)}` });
        if (scenario === 'sparse-events') await writer.flush();
        else if ((i + 1) % 64 === 0) await yieldIO();
      }
      writer.append({ type: 'transcript_version', transcriptVersion: 1 });
      await writer.flush();
      elapsedMs = performance.now() - started;
      // Verify full committed content through owner-scoped, paginated replay.
      let after = 0;
      const events = [];
      for (;;) {
        const page = await queue.readJobEvents('owner', job.id, after);
        if (!page.length) break;
        assert.ok(page.every((event, i) => event.sequence === after + i + 1));
        events.push(...page.map(row => row.event)); after = page.at(-1).sequence;
      }
      assert.equal(events.length, count + 2);
      assert.deepEqual(events[0], { type: 'content', text: 'first' });
      for (let i = 0; i < count; i++) assert.equal(events[i + 1].text, `${i}:${'x'.repeat(200)}`);
      assert.deepEqual(events.at(-1), { type: 'transcript_version', transcriptVersion: 1 });
      checksum = events.length;
    }
    console.log(JSON.stringify({ scenario, elapsedMs, firstDurableMs, sqlPrepares, inserts, checksum }));
  } finally {
    if (scenario === 'indexed-reads') await database?.close(); else await module.closeRelationalDatabase();
    await rm(directory, { recursive: true, force: true });
  }
} else {
  const baseline = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const roots = { candidate: root, ...(baseline ? { baseline } : {}) };
  const samples = [];
  // Alternate order, fresh process/database per sample; include sparse control.
  for (const scenario of ['indexed-reads', 'event-bursts', 'sparse-events']) {
    for (let sample = 0; sample < 5; sample++) {
      const order = sample % 2 ? Object.entries(roots).reverse() : Object.entries(roots);
      for (const [build, checkout] of order) {
        const output = execFileSync(process.execPath, [self, '--sample', checkout, scenario], {
          encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        samples.push({ build, sample, ...JSON.parse(output.trim()) });
      }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(['indexed-reads', 'event-bursts', 'sparse-events'].map(scenario =>
    [scenario, Object.fromEntries(Object.keys(roots).map(build => {
      const rows = samples.filter(row => row.scenario === scenario && row.build === build);
      return [build, { medianMs: median(rows.map(row => row.elapsedMs)),
        firstDurableMedianMs: rows[0].firstDurableMs === undefined ? null : median(rows.map(row => row.firstDurableMs)),
        sqlPrepares: rows.map(row => row.sqlPrepares), inserts: rows.map(row => row.inserts) }];
    }))]));
  const report = { node: process.version, platform: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0]?.model, samples, summary };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3]) {
    await mkdir(path.dirname(process.argv[3]), { recursive: true });
    await writeFile(process.argv[3], JSON.stringify(report, null, 2));
  }
}
