// A real competing SQLite write lock. No models, native parser, or user data.
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === '--sample') {
  const mode = process.argv[3], dir = await mkdtemp(path.join(os.tmpdir(), 'beaver-lock-probe-'));
  process.env.AUTH_MODE = 'local'; process.env.MIKE_LOCAL_DATA_DIR = dir;
  const require = createRequire(path.join(root, 'backend/package.json'));
  if (!process.env.BEAVER_BENCH_COMPILED) require('tsx/cjs');
  const { relationalDatabase, LocalDatabase, localDatabaseSync, closeRelationalDatabase, sql } = require(path.join(root, process.env.BEAVER_BENCH_COMPILED ? 'backend/dist/lib/relationalDatabase.js' : 'backend/src/lib/relationalDatabase.ts'));
  const setup = performance.now();
  const db = mode === 'worker' ? await relationalDatabase() : new LocalDatabase(localDatabaseSync());
  let contender;
  try {
    await db.query(sql`CREATE TABLE contention(id INTEGER PRIMARY KEY)`);
    const startupMs = performance.now() - setup;
    const reads = performance.now();
    for (let n = 0; n < 1000; n++) await db.query(sql`SELECT id FROM contention WHERE id=${n}`);
    const sequential1000Ms = performance.now() - reads;
    contender = new Worker(`
      const { DatabaseSync } = require('node:sqlite');
      const { parentPort, workerData } = require('node:worker_threads');
      const db = new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.close(); }, 300);
    `, { eval: true, workerData: path.join(dir, 'application.sqlite') });
    await once(contender, 'message');
    const start = performance.now();
    const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 10));
    await db.query(sql`INSERT INTO contention VALUES(1)`);
    const writeMs = performance.now() - start, timerMs = await timer;
    console.log(JSON.stringify({ mode, startupMs, sequential1000Ms, writeMs, timerMs }));
  } finally {
    if (contender) await contender.terminate();
    if (mode === 'worker') await closeRelationalDatabase();
    else { await db.close(); }
    await rm(dir, { recursive: true, force: true });
  }
} else {
  const samples = [];
  for (let sample = 0; sample < 5; sample++) for (const mode of sample % 2 ? ['worker', 'inline'] : ['inline', 'worker']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--sample', mode], { encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    samples.push(JSON.parse(result.stdout.trim().split('\n').at(-1)));
  }
  const median = values => values.sort((a,b) => a-b)[Math.floor(values.length/2)];
  const summary = Object.fromEntries(['inline', 'worker'].map(mode => [mode, Object.fromEntries(
    ['startupMs','sequential1000Ms','writeMs','timerMs'].map(key => [key, median(samples.filter(s => s.mode === mode).map(s => s[key]))]))]));
  const report = { implementation: process.env.BEAVER_BENCH_COMPILED ? "compiled CommonJS" : "TypeScript source via tsx", node: process.version, platform: process.platform, description: '10 ms main-thread timer during a 300 ms competing SQLite write lock; five alternating fresh-process samples. First connection startup and 1000 sequential tiny reads reported separately.', summary, samples };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
