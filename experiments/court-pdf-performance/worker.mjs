import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { performance } from 'node:perf_hooks';
import { ROOT, HOME, fixedDate, args, json, saveJson, sha256, canonical } from './common.mjs';

const options = args();
const split = options.split ?? 'dev';
const mode = options.mode ?? 'check';
assert(['dev', 'holdout'].includes(split));
assert(['check', 'measure', 'record'].includes(mode));
assert(['fc-60', 'fc-180', 'abca-60', 'abca-180'].includes(options.workload));
if (split === 'holdout' && options.unseal !== 'final-incumbent') throw new Error('Holdout sealed; final-incumbent token required');
if (mode === 'measure' && !global.gc) throw new Error('Measurement requires node --expose-gc');
const snapshot = resolve(options.snapshot);
const snapshotManifest = await json(resolve(snapshot, 'manifest.json'));
assert.equal(sha256(await readFile(resolve(snapshot, 'assembly.mjs'))), snapshotManifest.bundle_sha256);
fixedDate();
globalThis.location = { origin: 'http://court-evaluation.invalid' };
let denied = [], requests = [], reads = {};
const deny = (name) => (..._args) => { denied.push(name); throw new Error(`Unintended network blocked: ${name}`); };
net.Socket.prototype.connect = deny('net.Socket.connect');
net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
tls.connect = deny('tls.connect');
http.request = deny('http.request'); http.get = deny('http.get');
https.request = deny('https.request'); https.get = deny('https.get');
for (const key of Object.keys(dns)) if (typeof dns[key] === 'function' && /^(lookup|resolve|reverse)/.test(key)) dns[key] = deny(`dns.${key}`);
for (const key of Object.keys(dns.promises)) if (typeof dns.promises[key] === 'function') dns.promises[key] = deny(`dns.promises.${key}`);
globalThis.WebSocket = class { constructor() { deny('WebSocket')(); } };
const fontAssets = new Map();
for (const name of ['NotoSerif-Regular.ttf', 'NotoSansCanadianAboriginal-Regular.ttf', 'NotoNaskhArabic-Regular.ttf', 'NotoSerifSC-Regular.ttf'])
  fontAssets.set(`http://court-evaluation.invalid/court-fonts/${name}`, await readFile(resolve(ROOT, 'frontend/public/court-fonts', name)));
globalThis.fetch = async (resource, init) => {
  const url = String(resource); requests.push(url);
  if (init?.method && init.method !== 'GET' || !fontAssets.has(url)) return deny(`fetch:${url}`)();
  const bytes = fontAssets.get(url);
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
const fixtureHome = resolve(HOME, 'fixtures', split, options.workload);
const serialized = await json(resolve(fixtureHome, 'input.json'));
const input = serialized.input;
for (const entry of input.entries) {
  const descriptor = entry.file;
  const bytes = await readFile(resolve(fixtureHome, descriptor.path));
  assert.equal(sha256(bytes), descriptor.sha256);
  const file = new File([bytes], descriptor.name, { type: descriptor.type, lastModified: 0 });
  const original = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => { reads[entry.id] = (reads[entry.id] ?? 0) + 1; return original(); };
  entry.file = file;
}
const { buildCourtRecord } = await import(pathToFileURL(resolve(snapshot, 'assembly.mjs')).href);
const expectedPath = resolve(HOME, 'oracles', split, options.workload + '.json');
const expected = mode === 'record' ? null : await json(expectedPath);
const counters = (items) => Object.fromEntries([...new Set(items)].sort().map((key) => [key, items.filter((value) => value === key).length]));
const times = [], cpuTimes = [], peaks = [], results = [];
let latestResult;
const iterations = mode === 'measure' ? 5 : 1;
for (let iteration = 0; iteration < iterations; iteration++) {
  global.gc?.();
  denied = []; requests = []; reads = {};
  const progress = [];
  input.onProgress = (...event) => progress.push(event);
  const cpuBefore = process.cpuUsage();
  const before = performance.now();
  latestResult = await buildCourtRecord(input);
  const elapsed = performance.now() - before;
  const cpu = process.cpuUsage(cpuBefore);
  const peak = process.resourceUsage().maxRSS;
  const report = {
    artifacts: latestResult.artifacts.map(({ bytes, ...artifact }) => ({ ...artifact,
      byteLength: bytes.byteLength, actualSha256: sha256(bytes) })),
    receipt: latestResult.receipt, progress,
    requests: counters(requests), source_reads: reads, denied,
  };
  assert.equal(denied.length, 0, 'No unintended network');
  for (const artifact of report.artifacts) assert.equal(artifact.sha256, artifact.actualSha256);
  assert.equal(report.receipt.sources.length, input.entries.filter((entry) => !entry.descriptionOnly).length);
  const fixtureSources = new Map(serialized.sources.map((source) => [source.entryId, source]));
  for (const source of report.receipt.sources) {
    const original = fixtureSources.get(source.entryId);
    assert(original, 'Receipt source identity belongs to input');
    assert.equal(source.sha256, original.sha256);
    assert.equal(source.byteCount, original.byteCount);
  }
  if (expected) {
    assert.deepEqual(report.artifacts, expected.artifacts, 'Exact artifact bytes and metadata');
    assert.deepEqual(report.receipt, expected.receipt, 'Exact receipt');
    assert.deepEqual(report.progress, expected.progress, 'Exact progress');
    for (const [url, count] of Object.entries(report.requests)) assert(count <= (expected.requests[url] ?? 0), `Asset request bound: ${url}`);
    for (const [id, count] of Object.entries(report.source_reads)) assert(count <= (expected.source_reads[id] ?? 0), `Source read bound: ${id}`);
  }
  if (iteration >= iterations - (mode === 'measure' ? 3 : 1)) {
    times.push(elapsed); cpuTimes.push((cpu.user + cpu.system) / 1000); peaks.push(peak);
    results.push({ requests: report.requests, source_reads: report.source_reads,
      output_sha256: sha256(canonical(report.artifacts)), receipt_sha256: sha256(canonical(report.receipt)),
      progress_sha256: sha256(canonical(progress)), peak_rss_kib: peak });
  }
  if (mode === 'record') {
    await mkdir(resolve(HOME, 'oracles', split, options.workload), { recursive: true });
    for (const [index, artifact] of latestResult.artifacts.entries())
      await writeFile(resolve(HOME, 'oracles', split, options.workload, `${index}.pdf`), artifact.bytes);
    await saveJson(expectedPath, report);
  }
  if (iteration < iterations - 1) latestResult = undefined;
}
const output = {
  schema: 'beaver.court-cloud-measurement.v1', workload: options.workload, split, mode,
  snapshot: snapshotManifest.name, source_sha256: snapshotManifest.source_sha256,
  bundle_sha256: snapshotManifest.bundle_sha256, node: process.version,
  times_ms: times, cpu_ms: cpuTimes, peak_rss_kib: Math.max(...peaks), correctness: true,
  checks: { exact_pdf_bytes: mode !== 'record', exact_receipt: mode !== 'record', exact_progress: mode !== 'record',
    asset_requests_at_most_baseline: true, source_reads_at_most_baseline: true,
    unintended_network: 0, source_sha256_receipts: true },
  memory_scope: 'Process maxRSS after assembly, before current output hashing; includes imports, frozen input loading, GC, warmups and previous hash-only checks; excludes fixture generation and PDF semantic parsing.',
  iterations: results,
};
process.stdout.write(JSON.stringify(output) + '\n');
