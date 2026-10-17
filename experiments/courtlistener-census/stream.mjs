// One pass over a CourtListener bulk CSV (.csv.bz2): decode once (parallel ibzip2), split whole
// records, and on a worker pool (a) write every row, all columns, byte-exact, to zstd frames in
// ~1 GiB shard files with an id -> (frame, offset) index, and (b) write a per-row census sidecar.
//
//   node stream.mjs --in FILE --out DIR --kind opinions|clusters|dockets --rows N
//        [--level 6] [--workers 3] [--decoders 4] [--expect-bytes B] [--ibzip2 PATH]
//
// DIR/header.csv, DIR/shards/shard-NNNN.zst, DIR/frames.jsonl, DIR/rows.bin (32 B/row: id u32,
// frame u32, offset u32, length u32, sha256[0..16]), DIR/sidecar.zst (one jsonl frame per data
// frame), DIR/errors.jsonl (row parse failures, with ids), DIR/receipt.json, DIR/progress.log.
// Resumes after the last committed frame: shard, rows.bin and sidecar are truncated to it and the
// decoder seeks to its end (bz2cat.py), so committed rows are neither re-decoded through the pipe nor re-scanned.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { parseRecord } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const input = arg('--in'), out = arg('--out'), kind = arg('--kind');
const ROWS = Number(arg('--rows', 2000)), LEVEL = Number(arg('--level', 6));
const WORKERS = Number(arg('--workers', 3)), DECODERS = Number(arg('--decoders', 4));
const EXPECT = Number(arg('--expect-bytes', 0)), QUEUE = Number(arg('--queue', WORKERS + 1));
const IBZIP2 = arg('--ibzip2', 'C:/Users/elias/AppData/Local/Temp/claude/C--Users-elias-Desktop-MikeOSS-Fork/63fdd553-9e98-4a21-a28e-ba0710ce7313/scratchpad/ibz-venv/Scripts/ibzip2.exe');
const LEAN = argv.includes('--lean');
const SHARD_BYTES = 1 << 30, MAX_FRAME_RAW = 96 << 20;
fs.mkdirSync(path.join(out, 'shards'), { recursive: true });
const P = (f) => path.join(out, f);
const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.error(line); fs.appendFileSync(P('progress.log'), line + '\n'); };

// ---- resume -------------------------------------------------------------
let frames = fs.existsSync(P('frames.jsonl'))
  ? fs.readFileSync(P('frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const rowsStored = frames.reduce((n, f) => n + f.rows, 0);
let shardNo = frames.length ? frames.at(-1).shard : 0;
let shardEnd = frames.length ? frames.at(-1).offset + frames.at(-1).bytes : 0;
let sideEnd = frames.length ? frames.at(-1).side_offset + frames.at(-1).side_bytes : 0;
for (const f of fs.readdirSync(P('shards'))) {
  const n = Number(f.match(/shard-(\d+)\.zst/)?.[1]);
  if (n > shardNo) fs.rmSync(P('shards/' + f));
}
const shardPath = (n) => P(`shards/shard-${String(n).padStart(4, '0')}.zst`);
if (fs.existsSync(shardPath(shardNo))) fs.truncateSync(shardPath(shardNo), shardEnd);
if (fs.existsSync(P('sidecar.zst'))) fs.truncateSync(P('sidecar.zst'), sideEnd);
if (fs.existsSync(P('rows.bin'))) fs.truncateSync(P('rows.bin'), rowsStored * 32);
let errorsTotal = 0;
if (fs.existsSync(P('errors.jsonl'))) {
  const kept = fs.readFileSync(P('errors.jsonl'), 'utf8').split('\n').filter(Boolean)
    .filter((l) => JSON.parse(l).frame < frames.length);
  fs.writeFileSync(P('errors.jsonl'), kept.map((l) => l + '\n').join('')); errorsTotal = kept.length;
}
if (frames.length) log(`resume after ${frames.length} frames, ${rowsStored} rows`);
let shardFd = fs.openSync(shardPath(shardNo), 'a');
const rowsFd = fs.openSync(P('rows.bin'), 'a'), sideFd = fs.openSync(P('sidecar.zst'), 'a');
const framesFd = fs.openSync(P('frames.jsonl'), 'a');

// ---- wait for a growing download, then decode -----------------------------
while (EXPECT && fs.statSync(input).size < EXPECT) {
  log(`waiting for download: ${fs.statSync(input).size} / ${EXPECT}`);
  await new Promise((r) => setTimeout(r, 20000));
}
// A resumed run seeks the decoder to the end of the last committed frame (header + all committed
// raw bytes) instead of re-piping the decoded prefix.
const resumeSkip = frames.length ? fs.statSync(P('header.csv')).size + frames.reduce((n, f) => n + f.raw, 0) : 0;
const PYTHON = path.join(path.dirname(IBZIP2), 'python.exe');
const dec = resumeSkip
  ? spawn(PYTHON, ['-I', fileURLToPath(new URL('./bz2cat.py', import.meta.url)), path.resolve(input), String(DECODERS), String(resumeSkip)], { stdio: ['ignore', 'pipe', 'inherit'] })
  : spawn(IBZIP2, ['-d', '-c', '-P', String(DECODERS), path.resolve(input)], { stdio: ['ignore', 'pipe', 'inherit'] });

// ---- worker pool ------------------------------------------------------------
let header = null, pool = [], idle = [];
const inflight = new Map(); const done = new Map(); let nextCommit = frames.length;
const msTotals = { zstd: 0, census: 0 };
function startPool() {
  for (let i = 0; i < WORKERS; i++) {
    const w = new Worker(new URL('./census-worker.mjs', import.meta.url), { workerData: { level: LEVEL, kind, header, lean: LEAN } });
    w.on('message', (m) => { for (const k of ['z', 'rows', 'sz']) m[k] = Buffer.from(m[k].buffer, m[k].byteOffset, m[k].byteLength); done.set(m.no, m); inflight.delete(m.no); idle.push(w); commitReady(); wake(); });
    w.on('error', (e) => { log('worker error ' + (e.stack ?? e)); process.exit(3); });
    pool.push(w); idle.push(w);
  }
}
let waiters = [];
const wake = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
const until = async (cond) => { while (!cond()) await new Promise((r) => waiters.push(r)); };

const frameHash = createHash('sha256'); // header + frames in order = the decoded stream
const streamHash = createHash('sha256');
let decodedBytes = resumeSkip, records = resumeSkip ? rowsStored : 0, frameNo = frames.length, committedRows = rowsStored;
if (resumeSkip) {
  header = parseRecord(fs.readFileSync(P('header.csv')));
  log(`resume: decoder seeks to decoded byte ${resumeSkip} (after frame ${frames.length - 1}, row ${rowsStored})`);
}
let storedBytes = frames.reduce((n, f) => n + f.bytes, 0), sideBytes = sideEnd;

function commitReady() {
  while (done.has(nextCommit)) {
    const m = done.get(nextCommit); done.delete(nextCommit);
    if (shardEnd > 0 && shardEnd + m.z.length > SHARD_BYTES) {
      fs.closeSync(shardFd); shardNo++; shardEnd = 0; shardFd = fs.openSync(shardPath(shardNo), 'a');
    }
    fs.writeSync(shardFd, m.z); fs.writeSync(rowsFd, m.rows); fs.writeSync(sideFd, m.sz);
    // A frame is committed only once its shard bytes and index rows are on disk.
    fs.fdatasyncSync(shardFd); fs.fdatasyncSync(rowsFd); if (m.sz.length) fs.fdatasyncSync(sideFd);
    const meta = pendingMeta.get(m.no); pendingMeta.delete(m.no);
    const f = { frame: m.no, shard: shardNo, offset: shardEnd, bytes: m.z.length, raw: meta.raw, rows: meta.rows,
      first: m.rows.readUInt32LE(0), last: m.rows.readUInt32LE((meta.rows - 1) * 32), sha256: meta.sha256,
      side_offset: sideEnd, side_bytes: m.sz.length, side_raw: m.sideRaw };
    fs.writeSync(framesFd, JSON.stringify(f) + '\n'); fs.fdatasyncSync(framesFd);
    if (m.errors.length) { fs.appendFileSync(P('errors.jsonl'), m.errors.map((e) => JSON.stringify(e) + '\n').join('')); errorsTotal += m.errors.length; }
    shardEnd += m.z.length; sideEnd += m.sz.length; storedBytes += m.z.length; sideBytes += m.sz.length;
    committedRows += meta.rows; msTotals.zstd += m.ms.zstd; msTotals.census += m.ms.census;
    nextCommit++;
  }
}
const pendingMeta = new Map();

// ---- record scanner -----------------------------------------------------------
let pieces = [], piecesLen = 0, inQuote = false, escapeNext = false;
let frameRecs = [], frameRaw = 0;
const t0 = Date.now(); let lastLog = 0, skipBytes = 0;

async function flushFrame() {
  if (!frameRecs.length) return;
  const recs = frameRecs; frameRecs = []; frameRaw = 0;
  const raw = Buffer.concat(recs); const ends = []; let e = 0; for (const r of recs) { e += r.length; ends.push(e); }
  const sha = createHash('sha256').update(raw).digest('hex'); frameHash.update(raw);
  const no = frameNo++;
  pendingMeta.set(no, { raw: raw.length, rows: recs.length, sha256: sha });
  await until(() => idle.length > 0 && inflight.size + done.size < QUEUE);
  const w = idle.shift(); inflight.set(no, w);
  const ab = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength ? raw.buffer : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  w.postMessage({ no, buf: ab, ends }, [ab]);
  commitReady();
}

async function endRecord(last) {
  pieces.push(last); piecesLen += last.length;
  const rec = pieces.length === 1 ? Buffer.from(pieces[0]) : Buffer.concat(pieces, piecesLen);
  pieces = []; piecesLen = 0;
  if (header === null) {
    header = parseRecord(rec); fs.writeFileSync(P('header.csv'), rec); frameHash.update(rec); startPool(); return;
  }
  records++;
  if (records <= rowsStored) { skipBytes += rec.length; frameHash.update(rec); return; }
  frameRecs.push(rec); frameRaw += rec.length;
  if (frameRecs.length >= ROWS || frameRaw >= MAX_FRAME_RAW) await flushFrame();
}

async function scan(chunk) {
  streamHash.update(chunk); decodedBytes += chunk.length;
  let pos = 0, start = 0; const end = chunk.length;
  let nq = -2, nb = -2, nn = -2;
  const nextQ = () => (nq !== -1 && nq < pos ? (nq = chunk.indexOf(34, pos)) : nq);
  const nextB = () => (nb !== -1 && nb < pos ? (nb = chunk.indexOf(92, pos)) : nb);
  const nextN = () => (nn !== -1 && nn < pos ? (nn = chunk.indexOf(10, pos)) : nn);
  if (escapeNext) { escapeNext = false; pos = 1; }
  while (pos < end) {
    if (inQuote) {
      const q = nextQ(), b = nextB();
      if (b >= 0 && (q < 0 || b < q)) { if (b + 1 >= end) { escapeNext = true; pos = end; } else pos = b + 2; }
      else if (q >= 0) { inQuote = false; pos = q + 1; } else pos = end;
    } else {
      const q = nextQ(), n = nextN();
      if (n >= 0 && (q < 0 || n < q)) { await endRecord(chunk.subarray(start, n + 1)); pos = start = n + 1; }
      else if (q >= 0) { inQuote = true; pos = q + 1; } else pos = end;
    }
  }
  if (start < end) { const p = Buffer.from(chunk.subarray(start, end)); pieces.push(p); piecesLen += p.length; }
  const now = Date.now();
  if (now - lastLog > 60000) {
    lastLog = now; const s = (now - t0) / 1000;
    log(`rows ${records} committed ${committedRows} decoded ${(decodedBytes / 1e9).toFixed(2)} GB ` +
      `(${(decodedBytes / 1e6 / s).toFixed(1)} MB/s) frames ${nextCommit} shards ${shardNo + 1} stored ${(storedBytes / 1e9).toFixed(2)} GB ` +
      `sidecar ${(sideBytes / 1e6).toFixed(0)} MB errors ${errorsTotal} worker-ms zstd ${msTotals.zstd.toFixed(0)} census ${msTotals.census.toFixed(0)}`);
  }
}

const exited = new Promise((r) => dec.on('exit', (c) => r(c)));
if (resumeSkip) startPool();
const status = setInterval(() => log(`status decoded ${(decodedBytes / 1e9).toFixed(2)} GB records ${records} committed ${committedRows} ` +
  `inflight ${[...inflight.keys()].join(',')} done ${[...done.keys()].join(',')} idle ${idle.length} next ${nextCommit} frameNo ${frameNo} ` +
  `rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`), 30000);
for await (const chunk of dec.stdout) await scan(chunk);
if (piecesLen || inQuote) throw new Error(`stream ended inside a record (${piecesLen} bytes)`);
await flushFrame();
await until(() => inflight.size === 0); commitReady();
const code = await exited; clearInterval(status);
for (const w of pool) await w.terminate();
const receipt = {
  input, input_bytes: fs.statSync(input).size, kind, header_columns: header.length, records,
  frames: nextCommit, shards: shardNo + 1, decoded_bytes: decodedBytes, decoded_sha256: streamHash.digest('hex'),
  header_and_frames_sha256: frameHash.digest('hex'), stored_bytes: storedBytes, sidecar_bytes: sideBytes,
  rows_in_index: fs.statSync(P('rows.bin')).size / 32, parse_errors: errorsTotal, decoder_exit: code,
  level: LEVEL, lean: LEAN, rows_per_frame: ROWS, workers: WORKERS, decoders: DECODERS,
  seconds: (Date.now() - t0) / 1000, worker_ms: msTotals, finished: new Date().toISOString(),
};
// A resumed run's hashes cover only the bytes this process decoded, so they are not compared.
receipt.resumed_from_row = resumeSkip ? rowsStored : null;
receipt.lossless = (resumeSkip || receipt.decoded_sha256 === receipt.header_and_frames_sha256) && receipt.rows_in_index === records && code === 0;
fs.writeFileSync(P('receipt.json'), JSON.stringify(receipt, null, 2));
log('DONE ' + JSON.stringify(receipt));
process.exit(receipt.lossless ? 0 : 1);
