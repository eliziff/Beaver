// Shared readers for the re-encoded CourtListener packs (see reencode.mjs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

/** Fields of one PostgreSQL CSV record (ESCAPE '\'); unquoted empty = null, "" = ''. */
export function parseRecord(rec) {
  const fields = []; let i = 0; const n = rec.length;
  let end = n; if (rec[end - 1] === 10) end--; if (rec[end - 1] === 13) end--;
  while (i <= end) {
    if (i === end) { fields.push(null); break; }
    if (rec[i] === 34) {
      // quoted: collect segments, removing escape backslashes
      i++; const parts = []; let s = i;
      for (;;) {
        const q = rec.indexOf(34, i), b = rec.indexOf(92, i);
        if (b >= 0 && b < q) { parts.push(rec.subarray(s, b)); s = b + 1; i = b + 2; continue; }
        if (q < 0) throw new Error('unterminated quote');
        parts.push(rec.subarray(s, q)); i = q + 1; break;
      }
      fields.push(parts.length === 1 ? parts[0].toString('utf8') : Buffer.concat(parts).toString('utf8'));
      // a closing quote must be followed by a comma or the end
      if (i === end) break;
      if (rec[i] !== 44) throw new Error(`junk after quote at ${i}`);
      i++; if (i === end) { fields.push(null); break; }
    } else {
      const c = rec.indexOf(44, i); const e = c < 0 || c > end ? end : c;
      fields.push(e === i ? null : rec.subarray(i, e).toString('utf8'));
      if (e === end) break;
      i = e + 1; if (i === end) { fields.push(null); break; }
    }
  }
  return fields;
}

/** The pack's frame list and header columns. */
export function openPack(dir) {
  const frames = fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const header = parseRecord(fs.readFileSync(path.join(dir, 'header.csv')));
  const fd = fs.openSync(path.join(dir, 'data.zst'), 'r');
  return { dir, frames, header, fd };
}

/** Decompressed frame bytes, checked against the frame's sha256. */
export function readFrame(pack, f) {
  const b = Buffer.alloc(f.bytes); fs.readSync(pack.fd, b, 0, f.bytes, f.offset);
  const raw = zlib.zstdDecompressSync(b);
  if (createHash('sha256').update(raw).digest('hex') !== f.sha256) throw new Error(`frame ${f.frame} hash mismatch`);
  return raw;
}

/** Row index entries of a frame: [{id, offset, length, hash16}] from rows.bin. */
export function frameRows(pack, f, rowStart) {
  const fd = fs.openSync(path.join(pack.dir, 'rows.bin'), 'r');
  const b = Buffer.alloc(32 * f.rows); fs.readSync(fd, b, 0, b.length, rowStart * 32); fs.closeSync(fd);
  const rows = [];
  for (let i = 0; i < f.rows; i++) rows.push({ id: b.readUInt32LE(i * 32), frame: b.readUInt32LE(i * 32 + 4),
    offset: b.readUInt32LE(i * 32 + 8), length: b.readUInt32LE(i * 32 + 12), hash16: b.subarray(i * 32 + 16, i * 32 + 32) });
  return rows;
}

/** Records of a frame, each verified against its stored per-row hash. */
export function* frameRecords(pack, f, rowStart) {
  const raw = readFrame(pack, f); const rows = frameRows(pack, f, rowStart);
  for (const r of rows) {
    if (r.frame !== f.frame) throw new Error(`row index frame mismatch at ${r.id}`);
    const rec = raw.subarray(r.offset, r.offset + r.length);
    const h = createHash('sha256').update(rec).digest().subarray(0, 16);
    if (!h.equals(r.hash16)) throw new Error(`row ${r.id} hash mismatch`);
    yield { id: r.id, rec };
  }
}

/** Row-start offsets of each frame (prefix sums). */
export const rowStarts = (frames) => { let s = 0; return frames.map((f) => { const v = s; s += f.rows; return v; }); };

export function loadEngine(file) {
  const module = { exports: {} };
  process.dlopen(module, path.resolve(file));
  const transport = module.exports, enc = new TextEncoder(), dec = new TextDecoder();
  return (op, args) => {
    const json = enc.encode(JSON.stringify({ op, args }));
    const request = new Uint8Array(4 + json.length);
    new DataView(request.buffer).setUint32(0, json.length, true); request.set(json, 4);
    const reply = transport.call(request);
    const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
    const n = view.getUint32(1, true), text = dec.decode(reply.subarray(5, 5 + n));
    if (!view.getUint8(0)) throw new Error(text);
    return JSON.parse(text);
  };
}
