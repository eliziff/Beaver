import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const owner = resolve(import.meta.dirname, '../../legal-browser-ocr');
const [cpuPack, gpuPack, name, modelKind = 'standard'] = process.argv.slice(2);
assert.ok([cpuPack, gpuPack, name].every(value => /^[a-z0-9-]+$/.test(value || '')));
assert.ok(['standard', 'light'].includes(modelKind));
const read = path => readFileSync(resolve(owner, path));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cpuRoot = `assets/indra-followup/${cpuPack}`, gpuRoot = `assets/indra-followup/${gpuPack}`;
const cpu = JSON.parse(read(cpuRoot + '/source.json'));
const gpu = JSON.parse(read(gpuRoot + '/source.json'));
const capture = JSON.parse(read(gpuRoot + '-capture/source.json'));
assert.equal(gpu.fp16_gate_passed, true);
assert.equal(capture.original_model_sha256, gpu.model_sha256);
assert.equal(capture.checks.length, 3); assert.ok(capture.checks.every(check => check.logits_exact));
assert.ok(read(cpuRoot + '/codec.json').equals(read(gpuRoot + '/codec.json')));
const base = read('dist/runtime-speed-gpu-capture.html').toString('utf8');
const originalAssets = base.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const originalCompression = base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const originalConfiguration = base.match(/globalThis\.LEGAL_OCR_PACKAGE=(\{[^;]*\});/)[1];
const assets = JSON.parse(originalAssets), compressed = new Set(JSON.parse(originalCompression));
const configuration = JSON.parse(originalConfiguration);
const decode = key => { const bytes = Buffer.from(assets[key], 'base64'); return compressed.has(key) ? gunzipSync(bytes) : bytes; };
const manifest = JSON.parse(decode('packageNotice'));
assert.ok(manifest.experimental_gpu_capture, 'Both recognizers must use compatible capture graphs');
const put = (key, bytes) => { assets[key] = gzipSync(bytes, { level: 9 }).toString('base64'); compressed.add(key); };
for (const [kind, path, expected] of [
  ['cpu', cpuRoot + '/model.onnx', cpu.model_sha256], ['codec', cpuRoot + '/codec.json', cpu.codec_sha256],
  ['gpu', gpuRoot + '-capture/model.onnx', capture.model_sha256],
]) {
  const previous = manifest.models[modelKind][kind].path;
  delete assets[previous]; compressed.delete(previous); delete manifest.assets[previous];
  const bytes = read(path); assert.equal(hash(bytes), expected);
  manifest.models[modelKind][kind] = { path, sha256: expected };
  manifest.assets[path] = { bytes: bytes.length, sha256: expected }; put(path, bytes);
}
configuration.packs = Object.fromEntries(Object.entries(manifest.models).map(([key, model]) => [key,
  Object.fromEntries(Object.entries(model).map(([kind, value]) => [kind, value.path]))]));
manifest.experimental_recognizer = { name, model: modelKind, cpu, gpu, capture, query: 'gpuCapture=1' };
manifest.experimental_gpu_capture.sources[modelKind] = capture;
put('packageNotice', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
const html = base.replace('globalThis.LEGAL_OCR_ASSETS=' + originalAssets, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
  .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + originalCompression, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]))
  .replace('globalThis.LEGAL_OCR_PACKAGE=' + originalConfiguration, () => 'globalThis.LEGAL_OCR_PACKAGE=' + JSON.stringify(configuration));
const output = resolve(owner, 'dist', `runtime-speed-${name}.html`);
writeFileSync(output, html);
const receipt = { origin: 'machine_test', run_id: randomUUID(), base_html_sha256: hash(Buffer.from(base)),
  html_sha256: hash(Buffer.from(html)), html_bytes: Buffer.byteLength(html), models: manifest.models, sources: { cpu, gpu, capture } };
writeFileSync(output.replace('.html', '.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ output, bytes: receipt.html_bytes, sha256: receipt.html_sha256 }));
