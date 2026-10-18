// Frame decoder for opinion_census (native/legal-structure-node/src/bin): reads "path\toffset\tbytes\n" requests on stdin
// and answers each with an 8-byte little-endian length and the decompressed zstd frame, so the Rust pass needs no zstd crate.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

const files = new Map();
const out = 1;
const write = (buffer) => { let at = 0; while (at < buffer.length) at += fs.writeSync(out, buffer, at); };
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line) continue;
  const [file, offset, bytes] = line.split('\t');
  if (!files.has(file)) files.set(file, fs.openSync(file, 'r'));
  const compressed = Buffer.alloc(Number(bytes));
  fs.readSync(files.get(file), compressed, 0, compressed.length, Number(offset));
  const raw = zlib.zstdDecompressSync(compressed);
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(raw.length));
  write(length); write(raw);
}
