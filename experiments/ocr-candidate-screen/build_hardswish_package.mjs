import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..'), owner = resolve(root, 'legal-browser-ocr');
const filename = process.argv[2] || 'runtime-speed-gpu-capture.html';
assert.match(filename, /^[a-z0-9-]+\.html$/);
const outputName = process.argv[3] || 'runtime-speed-hswish.html';
assert.match(outputName, /^[a-z0-9-]+\.html$/); assert.notEqual(outputName, filename);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const folder = resolve(owner, 'assets/indra-kernels/hswish');
const engine = JSON.parse(readFileSync(resolve(folder, 'build-inputs.json'), 'utf8'));
assert.equal(engine.mode, 'hswish'); assert.equal(engine.fused_hardswish, true);
assert.equal(engine.config_sha256, hash(readFileSync(resolve(import.meta.dirname, 'hardswish-operators.config'))));
for (const [name, expected] of Object.entries(engine.kernel_headers_sha256)) assert.equal(hash(readFileSync(resolve(import.meta.dirname, name))), expected);
for (const [name, expected] of Object.entries(engine.source_patches_sha256)) assert.equal(hash(readFileSync(resolve(import.meta.dirname, name))), expected);
const base = readFileSync(resolve(owner, 'dist', filename), 'utf8');
const original = base.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const compression = base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const assets = JSON.parse(original), compressed = new Set(JSON.parse(compression));
const decode = key => { const bytes = Buffer.from(assets[key], 'base64'); return compressed.has(key) ? gunzipSync(bytes) : bytes; };
const notice = JSON.parse(decode('packageNotice').toString('utf8'));
const previous = {};
for (const [key, suffix, expected] of [['ortMjs', 'mjs', engine.loader_sha256], ['ortWasm', 'wasm', engine.wasm_sha256]]) {
  const path = `ort-wasm-simd-threaded.${suffix}`, bytes = readFileSync(resolve(folder, path));
  assert.equal(hash(bytes), expected); previous[key] = hash(decode(key));
  assert.equal(previous[key], notice.assets['dist/' + path].sha256);
  assets[key] = gzipSync(bytes, { level: 9 }).toString('base64'); compressed.add(key);
  notice.assets['dist/' + path] = { bytes: bytes.length, sha256: expected };
}
notice.experimental_cpu_kernel = engine;
notice.modifications += ' CPU runtime adds a fused SIMD128 HardSwish kernel with the standard ORT worker/thread scheduler; model weights are unchanged.';
assets.packageNotice = gzipSync(Buffer.from(JSON.stringify(notice, null, 2) + '\n'), { level: 9 }).toString('base64'); compressed.add('packageNotice');
const html = base.replace('globalThis.LEGAL_OCR_ASSETS=' + original, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
  .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + compression, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]));
const output = resolve(owner, 'dist', outputName);
writeFileSync(output, html);
const receipt = { origin: 'machine_test', run_id: randomUUID(), base_html_sha256: hash(Buffer.from(base)),
  html_sha256: hash(Buffer.from(html)), html_bytes: Buffer.byteLength(html), previous, engine };
writeFileSync(output.replace('.html', '.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ output, bytes: receipt.html_bytes, sha256: receipt.html_sha256 }));
