// Writes opinions/cluster.bin: one u32 cluster_id per row, aligned with rows.bin (0xffffffff = NULL),
// so a cluster's opinions can be found without scanning. cluster_id is the last CSV column, so each
// record is read only from its end.
//
//   node cluster-index.mjs STREAM_DIR/opinions [--workers 3]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (isMainThread) {
  const dir = process.argv[2];
  const W = Number(process.argv[process.argv.indexOf('--workers') + 1] || 3) || 3;
  const header = fs.readFileSync(path.join(dir, 'header.csv'), 'utf8').trim().split(',');
  if (header.at(-1) !== 'cluster_id') throw new Error('cluster_id is not the last column');
  const frames = fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const starts = []; let s = 0; for (const f of frames) { starts.push(s); s += f.rows; }
  const out = new Uint32Array(s); const t0 = Date.now(); let next = 0, doneN = 0;
  await Promise.all(Array.from({ length: W }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { dir } });
    const feed = () => (next < frames.length ? w.postMessage({ f: frames[next], start: starts[next++] }) : w.postMessage(null));
    w.on('message', (m) => {
      if (m === 'bye') return resolve();
      out.set(new Uint32Array(m.ids.buffer, m.ids.byteOffset, m.ids.length), m.start);
      if (++doneN % 1000 === 0) console.error(`${doneN}/${frames.length} frames ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      feed();
    });
    w.on('error', reject); feed();
  })));
  fs.writeFileSync(path.join(dir, 'cluster.bin'), Buffer.from(out.buffer));
  console.error(`cluster.bin: ${s} rows, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} else {
  const { dir } = workerData; const fds = {};
  const rowsFd = fs.openSync(path.join(dir, 'rows.bin'), 'r');
  parentPort.on('message', (job) => {
    if (!job) { parentPort.postMessage('bye'); return; }
    const { f, start } = job;
    const shard = path.join(dir, 'shards', `shard-${String(f.shard).padStart(4, '0')}.zst`);
    const fd = fds[shard] ??= fs.openSync(shard, 'r');
    const b = Buffer.alloc(f.bytes); fs.readSync(fd, b, 0, f.bytes, f.offset);
    const raw = zlib.zstdDecompressSync(b);
    const idx = Buffer.alloc(32 * f.rows); fs.readSync(rowsFd, idx, 0, idx.length, start * 32);
    const ids = new Uint32Array(f.rows);
    for (let i = 0; i < f.rows; i++) {
      const o = idx.readUInt32LE(i * 32 + 8), l = idx.readUInt32LE(i * 32 + 12);
      let e = o + l - 1; if (raw[e] === 10) e--; if (raw[e] === 34) e--;
      let v = 0, mul = 1, any = false;
      while (e >= o && raw[e] >= 48 && raw[e] <= 57) { v += (raw[e] - 48) * mul; mul *= 10; e--; any = true; }
      ids[i] = any ? v : 0xffffffff;
    }
    parentPort.postMessage({ start, ids });
  });
}
