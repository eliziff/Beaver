import { readFile, writeFile, rename, mkdir, open, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { check, hash, payload, validateResponse, VERSION } from './contract.mjs';

export async function readJsonl(path) {
  check((await stat(path)).size <= 64 * 1024 * 1024, 'Input exceeds 64 MiB; use explicit corpus shards');
  const contents = await readFile(path, 'utf8');
  check(Buffer.byteLength(contents) <= 64 * 1024 * 1024, 'Input exceeds 64 MiB; use explicit corpus shards');
  return contents.split(/\r?\n/u).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at record ${i + 1}`); }
  });
}
export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function codeHash() {
  return hash(await Promise.all(['contract.mjs', 'transport.mjs', 'runner.mjs', 'metrics.mjs', 'cli.mjs'].map(async file =>
    [file, await readFile(new URL(file, import.meta.url), 'utf8')])));
}
export function verifyPlan(plan) {
  check(plan.version === VERSION && Array.isArray(plan.items) && Array.isArray(plan.calls), 'Invalid plan');
  check(new Set(plan.calls.map(c => c.id)).size === plan.calls.length, 'Duplicate planned calls');
  for (const call of plan.calls) check(hash(payload(plan, call)) === call.request_sha256, 'Changed request payload');
}

/** A started checkpoint is never silently retried: its remote billing/outcome is unknown. */
export async function runPlan(plan, { directory, evaluate, maxCalls, workers = 1, timeoutMs = 30_000, signal }) {
  verifyPlan(plan);
  check(Number.isSafeInteger(maxCalls) && maxCalls >= 0, 'Explicit nonnegative call budget required');
  check(Number.isSafeInteger(workers) && workers >= 1 && workers <= 32, 'Workers must be 1..32');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 600_000, 'Invalid timeout');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await open(join(directory, '.lock'), 'wx', 0o600).catch(() => { throw new Error('Run is locked; do not run concurrent writers. After a crash, confirm the old process is dead before removing .lock.'); });
  const start = performance.now(), session = randomUUID();
  let started = 0, cursor = 0;
  try {
    const manifest = join(directory, 'plan.json');
    let existing;
    try { existing = JSON.parse(await readFile(manifest, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) check(hash(existing) === hash(plan), 'Resume refuses a changed corpus, code, model or configuration');
    else await atomicJson(manifest, plan);
    await mkdir(join(directory, 'receipts'), { recursive: true, mode: 0o700 });
    await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
    const sessionPath = join(directory, 'sessions', `${session}.json`);
    const sessionData = { id: session, started_at: new Date().toISOString(), workers, timeout_ms: timeoutMs, max_calls: maxCalls, status: 'started' };
    await atomicJson(sessionPath, sessionData);
    const pending = [];
    for (const call of plan.calls) {
      const path = join(directory, 'receipts', `${call.id}.json`);
      try {
        const saved = JSON.parse(await readFile(path, 'utf8'));
        check(saved.request_sha256 === call.request_sha256, 'Stale receipt');
        if (saved.status === 'started') await atomicJson(path, { ...saved, status: 'interrupted', error: 'unknown_remote_outcome' });
      } catch (error) { if (error.code === 'ENOENT') pending.push(call); else throw error; }
    }
    await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, async () => {
      while (cursor < pending.length && !signal?.aborted) {
        const call = pending[cursor++], path = join(directory, 'receipts', `${call.id}.json`);
        const base = { call_id: call.id, request_sha256: call.request_sha256, session, started_at: new Date().toISOString() };
        if (call.refusal) { await atomicJson(path, { ...base, status: 'refused', error: call.refusal, attempted: false }); continue; }
        if (started >= maxCalls) continue; // No receipt: explicitly pending in every score; a resume may run it.
        started++;
        await atomicJson(path, { ...base, status: 'started', attempted: true });
        const clock = performance.now(), deadline = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let result;
        try {
          result = await evaluate(payload(plan, call), combined);
          if (!result.error) validateResponse(result.response, payload(plan, call));
        } catch { result = { error: combined.aborted ? 'aborted_or_timeout' : 'invalid_response', raw: null }; }
        await atomicJson(path, { ...base, ...result, raw_sha256: typeof result.raw === 'string' ? hash(result.raw) : null, status: result.error ? 'error' : 'ok', attempted: true,
          elapsed_ms: performance.now() - clock, ended_at: new Date().toISOString() });
      }
    }));
    await atomicJson(sessionPath, { ...sessionData, status: signal?.aborted ? 'cancelled' : 'completed', calls_started: started,
      elapsed_ms: performance.now() - start, ended_at: new Date().toISOString() });
  } finally { await lock.close(); await unlink(join(directory, '.lock')); }
  return loadRun(directory);
}

export async function loadRun(directory) {
  const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
  verifyPlan(plan);
  const receipts = new Map();
  for (const call of plan.calls) {
    try {
      const record = JSON.parse(await readFile(join(directory, 'receipts', `${call.id}.json`), 'utf8'));
      check(record.call_id === call.id && record.request_sha256 === call.request_sha256, 'Receipt identity mismatch');
      if (typeof record.raw === 'string') check(record.raw_sha256 === hash(record.raw), 'Raw response hash mismatch');
      if (record.status === 'ok') validateResponse(record.response, payload(plan, call));
      receipts.set(call.id, record);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let sessions = [];
  try { sessions = await Promise.all((await readdir(join(directory, 'sessions'))).filter(f => f.endsWith('.json')).map(async file => JSON.parse(await readFile(join(directory, 'sessions', file), 'utf8')))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { plan, receipts, sessions };
}

export const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
