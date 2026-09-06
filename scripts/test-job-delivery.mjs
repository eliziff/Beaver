// Real queue/persistence/IPC integration; synthetic handlers, no models or documents.
// Build backend first, then: node scripts/test-job-delivery.mjs [REPORT_JSON]
// Optional QUEUE_TEST_DATABASE_URL must name a disposable loopback PostgreSQL server.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url), repo = path.resolve(path.dirname(self), '..');
const require = createRequire(path.join(repo, 'backend/package.json'));
const load = name => require(path.join(repo, `backend/dist/lib/${name}.js`));
const owner = '10000000-0000-4000-8000-000000000001';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (read, accept, label) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await pause(10);
  }
  throw new Error(`Timed out: ${label}`);
};

if (process.argv[2] === '--peer') {
  const queue = load('jobQueue'), { relationalDatabase, closeRelationalDatabase } = load('relationalDatabase');
  const { durableChatTurns } = load('chatTurnQueue');
  const db = await relationalDatabase(), releases = new Map(), watches = [];
  const claims = [], active = { chat: 0, preparation: 0, bulk: 0 }, maximum = { ...active };
  let workers, hints = 0, reads = 0;
  const query = db.query.bind(db);
  db.query = statement => { reads += 1; return query(statement); };
  const handler = lane => async (job, { signal }) => {
    maximum[lane] = Math.max(maximum[lane], ++active[lane]);
    claims.push({ id: job.id, lane, startedAt: Date.now() });
    try {
      const writer = await queue.createJobEventWriter(job.id);
      writer.append({ type: 'content', text: job.id }); await writer.flush();
      if (job.payload.hold) await new Promise(resolve => {
        const finish = () => { signal.removeEventListener('abort', finish); releases.delete(job.id); resolve(); };
        releases.set(job.id, finish);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      });
      return { finished: true };
    } finally { active[lane] -= 1; }
  };
  const methods = {
    start: () => {
      workers = load('jobWorkerLanes').startJobLanes([
        { concurrency: 2, handlers: { 'chat.turn': handler('chat') } },
        { concurrency: 1, handlers: { 'pdf.prepare': handler('preparation') } },
        { concurrency: 1, handlers: { 'tabular.agent': handler('bulk') } },
      ]);
      return true;
    },
    enqueue: input => queue.enqueueJob({ ...input, userId: owner, dedupeKey: input.key ?? randomUUID(), payload: input.payload ?? {} }),
    cancel: id => queue.requestJobCancellation(id, owner),
    get: id => queue.getJob(id, owner),
    release: id => { releases.get(id)?.(); return true; },
    watch: topic => { watches.push(db.notifications.subscribe([topic], () => { hints += 1; })); return true; },
    publish: topic => { db.notifications.publish(topic); return true; },
    stats: () => ({ claims, active, maximum, hints, reads }),
    append: async id => {
      const writer = await queue.createJobEventWriter(id);
      writer.append({ type: 'content', text: 'external' }); await writer.flush(); return true;
    },
    replay: id => {
      const events = [];
      return durableChatTurns.observe({ userId: owner }, id, new AbortController().signal,
        event => events.push(event)).then(job => ({ status: job.status, events }));
    },
    command: id => queue.enqueueJobCommand(owner, id, 'steer', { id: randomUUID(), text: 'fixture' }),
    commands: id => queue.pendingJobCommands(id),
    rollback: async () => {
      let id;
      try {
        await db.transaction(async tx => {
          await tx.transaction(async nested => {
            id = (await queue.enqueueJob({ kind: 'fixture.rollback', dedupeKey: randomUUID(), userId: owner, payload: {} }, nested)).id;
          });
          throw new Error('fixture rollback');
        });
      } catch (error) { if (error.message !== 'fixture rollback') throw error; }
      return queue.getJob(id, owner);
    },
    stop: async () => {
      await workers?.stop(); watches.forEach(off => off());
      await closeRelationalDatabase(); return true;
    },
  };
  process.on('message', message => {
    if (message?.test !== 'rpc') return;
    Promise.resolve().then(() => methods[message.method](message.value)).then(
      value => process.send?.({ test: 'reply', id: message.id, value }),
      error => process.send?.({ test: 'reply', id: message.id, error: error.stack }),
    );
  });
  process.send?.({ test: 'ready' });
} else {
  const { createJobNotificationRelay } = load('jobNotifications');
  const reports = [];
  async function peer(env, relay) {
    const child = fork(self, ['--peer'], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const detach = relay?.attach(child), pending = new Map();
    let ready, failed;
    const started = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.once('error', failed);
    child.on('message', message => {
      if (message?.test === 'ready') ready();
      if (message?.test !== 'reply') return;
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    });
    child.on('exit', code => {
      failed(new Error(`Peer exited before ready: ${code}`));
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Peer exited: ${code}`)); }
      pending.clear();
    });
    const call = (method, value) => new Promise((resolve, reject) => {
      if (!child.connected) return reject(new Error('Peer disconnected'));
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${method}`)); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.send({ test: 'rpc', id, method, value }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    });
    const timeout = setTimeout(() => child.kill(), 15_000);
    await started; clearTimeout(timeout);
    return { call, async close() {
      try { await call('stop'); } finally {
        detach?.(); child.kill(); await exited;
      }
    } };
  }
  async function scenario(name, env, relayEnabled, admin, database) {
    const relay = relayEnabled ? createJobNotificationRelay() : undefined;
    const server = await peer(env, relay), worker = await peer(env, relay);
    try {
      await server.call('watch', 'events:probe');
      if (admin) await until(() => server.call('stats'), stats => stats.hints > 0, 'initial LISTEN');
      const before = (await server.call('stats')).hints;
      const publishedAt = Date.now();
      await worker.call('publish', 'events:probe');
      if (relayEnabled || admin) await until(() => server.call('stats'), stats => stats.hints > before, 'cross-process hint');
      const hintMs = Date.now() - publishedAt;
      await server.call('watch', 'queue:fixture.rollback');
      const rollbackHints = (await server.call('stats')).hints;
      assert.equal(await worker.call('rollback'), null);
      await pause(80);
      assert.equal((await server.call('stats')).hints, rollbackHints, 'rollback must not wake observers');
      await worker.call('start');
      const preparation = await server.call('enqueue', { kind: 'pdf.prepare', payload: { hold: true } });
      const bulk = await server.call('enqueue', { kind: 'tabular.agent', payload: { hold: true } });
      await until(() => worker.call('stats'), s => s.active.preparation === 1 && s.active.bulk === 1, 'occupied non-interactive lanes');
      const submittedAt = Date.now();
      const chat = await server.call('enqueue', { kind: 'chat.turn', key: 'interactive', payload: { hold: true } });
      const duplicate = await server.call('enqueue', { kind: 'chat.turn', key: 'interactive' });
      assert.equal(duplicate.id, chat.id);
      const started = await until(() => worker.call('stats'), s => s.claims.some(c => c.id === chat.id), 'chat starts independently');
      const queueMs = started.claims.find(c => c.id === chat.id).startedAt - submittedAt;
      const chat2 = await server.call('enqueue', { kind: 'chat.turn', payload: { hold: true } });
      await until(() => worker.call('stats'), s => s.active.chat === 2, 'second interactive slot');
      const queued = await server.call('enqueue', { kind: 'chat.turn' });
      assert.equal((await server.call('get', queued.id)).status, 'queued');
      await worker.call('watch', `control:${chat.id}`);
      const controlsBefore = (await worker.call('stats')).hints;
      assert.equal(await server.call('command', chat.id), true);
      if (relayEnabled || admin) await until(() => worker.call('stats'), s => s.hints > controlsBefore, 'cross-process command hint');
      assert.equal((await worker.call('commands', chat.id)).length, 1);
      const replay = server.call('replay', chat.id);
      await worker.call('append', chat.id);
      const cancelledAt = Date.now();
      await server.call('cancel', chat.id);
      const observed = await replay;
      const cancellationMs = Date.now() - cancelledAt;
      assert.equal(observed.status, 'cancelled');
      assert.deepEqual(observed.events, [{ type: 'content', text: chat.id }, { type: 'content', text: 'external' }]);
      assert.deepEqual(await server.call('replay', chat.id), observed);
      await until(() => server.call('get', queued.id), job => job.status === 'succeeded', 'released capacity');
      assert.equal((await server.call('get', preparation.id)).status, 'running');
      assert.equal((await server.call('get', bulk.id)).status, 'running');
      assert.deepEqual((await worker.call('stats')).maximum, { chat: 2, preparation: 1, bulk: 1 });
      if (admin) {
        const previous = (await server.call('stats')).hints;
        const terminated = await admin.unsafe('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND query ~* $2', [database, '^listen.*beaver_jobs']);
        assert.ok(terminated.length > 0, 'test must actually disconnect LISTEN');
        await until(() => server.call('stats'), s => s.hints > previous, 'LISTEN reconnect catch-up');
        const next = (await server.call('stats')).hints;
        await worker.call('publish', 'events:probe');
        await until(() => server.call('stats'), s => s.hints > next, 'notifications after reconnection');
      }
      for (const id of [preparation.id, bulk.id, chat2.id]) await server.call('cancel', id);
      reports.push({ scenario: name, queueMs, cancellationAndDrainMs: cancellationMs,
        hintMs: relayEnabled || admin ? hintMs : null, isolatedCapacity: true,
        replayExact: true, rollbackSilent: true, recoveredAfterDisconnect: !!admin });
    } finally { await Promise.all([server.close(), worker.close()]); }
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'beaver-delivery-'));
  try {
    for (const relay of [true, false]) await scenario(relay ? 'sqlite-ipc' : 'sqlite-lost-hints-fallback',
      { ...process.env, AUTH_MODE: 'local', MIKE_LOCAL_DATA_DIR: path.join(directory, String(relay)) }, relay);
    const connection = process.env.QUEUE_TEST_DATABASE_URL;
    if (connection) {
      const url = new URL(connection);
      assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'PostgreSQL fixture must be loopback');
      const postgres = require('postgres'), admin = postgres(connection, { ssl: false, max: 1 });
      const database = `beaver_queue_${randomUUID().replaceAll('-', '')}`;
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      url.pathname = `/${database}`; url.searchParams.set('sslmode', 'disable');
      const setup = postgres(url.href, { ssl: false, max: 1 });
      try {
        const schema = await readFile(path.join(repo, 'backend/schema.sql'), 'utf8');
        await setup.unsafe(/-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u.exec(schema)[1]);
        await setup.end();
        await scenario('postgres-notify', { ...process.env, AUTH_MODE: 'cloud', DATABASE_URL: url.href,
          DATABASE_LISTEN_URL: url.href }, false, admin, database);
      } finally { await setup.end(); await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.end(); }
    }
    console.log(JSON.stringify(reports, null, 2));
    if (process.argv[2]) { await mkdir(path.dirname(process.argv[2]), { recursive: true }); await writeFile(process.argv[2], JSON.stringify(reports, null, 2)); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
