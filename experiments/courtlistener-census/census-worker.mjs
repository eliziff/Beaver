// Worker: compresses one frame of whole CSV records, proves the round trip, hashes each row,
// and runs the per-row census into a compressed sidecar frame.
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseRecord } from './lib.mjs';
import { opinionCensus, clusterCensus, docketCensus } from './census-row.mjs';

const C = zlib.constants;
const { level, kind, header, lean } = workerData;
const cols = Object.fromEntries(header.map((h, i) => [h, i]));
const census = { opinions: opinionCensus, clusters: clusterCensus, dockets: docketCensus }[kind];
const zp = { params: { [C.ZSTD_c_compressionLevel]: level, [C.ZSTD_c_windowLog]: 27,
  [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_checksumFlag]: 1 } };

function idOf(rec) {
  let i = rec[0] === 34 ? 1 : 0, v = 0, any = false;
  for (; i < rec.length; i++) { const c = rec[i]; if (c < 48 || c > 57) break; v = v * 10 + (c - 48); any = true; }
  return any ? v : 0xffffffff;
}

parentPort.on('message', ({ no, buf, ends }) => {
  const raw = Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
  const t0 = performance.now();
  const z = zlib.zstdCompressSync(raw, zp);
  if (!zlib.zstdDecompressSync(z).equals(raw)) throw new Error(`frame ${no} does not round-trip`);
  const t1 = performance.now();
  const rows = Buffer.alloc(32 * ends.length);
  const side = []; const errors = [];
  let start = 0;
  ends.forEach((end, i) => {
    const rec = raw.subarray(start, end);
    const id = idOf(rec);
    rows.writeUInt32LE(id, i * 32); rows.writeUInt32LE(no, i * 32 + 4);
    rows.writeUInt32LE(start, i * 32 + 8); rows.writeUInt32LE(end - start, i * 32 + 12);
    createHash('sha256').update(rec).digest().copy(rows, i * 32 + 16, 0, 16);
    if (lean) { start = end; return; }
    try {
      const f = parseRecord(rec);
      if (f.length !== header.length) throw new Error(`field count ${f.length} != ${header.length}`);
      side.push(JSON.stringify(census ? census(cols, f) : { id }));
    } catch (e) {
      errors.push({ id, frame: no, error: String(e.message ?? e).slice(0, 300) });
      side.push(JSON.stringify({ id, err: String(e.message ?? e).slice(0, 300) }));
    }
    start = end;
  });
  const sideRaw = lean ? Buffer.alloc(0) : Buffer.from(side.join('\n') + '\n');
  const sz = lean ? Buffer.alloc(0) : zlib.zstdCompressSync(sideRaw, { params: { [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_checksumFlag]: 1 } });
  const t2 = performance.now();
  parentPort.postMessage({ no, z, rows, sz, sideRaw: sideRaw.length, errors, ms: { zstd: t1 - t0, census: t2 - t1 } });
});
