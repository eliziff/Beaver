import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..'), owner = resolve(root, 'legal-browser-ocr');
const variant = process.argv[2] || 'cpu'; assert.ok(['cpu', 'lite'].includes(variant));
const precision = process.argv[3] || 'fp32'; assert.ok(['fp32', 'fp16', 'bf16'].includes(precision));
const group = process.argv[4] || (precision === 'fp32' ? '' : precision);
assert.match(group, /^[a-z0-9-]*$/);
const suffix = group ? '-' + group : '';
const hash = data => createHash('sha256').update(data).digest('hex');
const baseFolder = resolve(owner, 'assets/indra-compact');
const folder = group ? resolve(baseFolder, group) : baseFolder;
const graphs = JSON.parse(readFileSync(resolve(folder, 'source.json'), 'utf8'));
const engine = JSON.parse(readFileSync(resolve(baseFolder, 'runtime/build-inputs.json'), 'utf8'));
assert.equal(graphs.weight_precision || 'fp32', precision);
assert.equal(engine.mode, 'minimal');
const compiledConfig = readFileSync(resolve(baseFolder, 'operators.config'));
const graphConfig = readFileSync(resolve(folder, 'operators.config'));
assert.equal(hash(compiledConfig), engine.config_sha256);
assert.equal(hash(graphConfig), graphs.operator_config_sha256);
const operators = config => config.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).sort();
assert.deepEqual(operators(graphConfig), operators(compiledConfig), 'Models require a different operator/type build');
const base = readFileSync(resolve(owner, `dist/legal-browser-ocr-${variant}.html`), 'utf8');
const originalAssets = base.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const assets = JSON.parse(originalAssets);
const originalCompression = base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const compressed = new Set(JSON.parse(originalCompression));
const originalConfiguration = base.match(/globalThis\.LEGAL_OCR_PACKAGE=(\{[^;]*\});/)[1];
const configuration = JSON.parse(originalConfiguration);
const decode = name => { const bytes = Buffer.from(assets[name], 'base64'); return compressed.has(name) ? gunzipSync(bytes) : bytes; };
function asset(name, bytes) { compressed.add(name); assets[name] = gzipSync(bytes, { level: 9 }).toString('base64'); }
const manifest = JSON.parse(decode('packageNotice').toString('utf8'));
for (const [name, info] of Object.entries(manifest.models)) {
  const graph = graphs.models[name];
  const sourcePack = graphs.source_packs?.[name];
  if (sourcePack) {
    assert.match(sourcePack, /^[a-z0-9-]+$/);
    const sourceRoot = `assets/indra-followup/${sourcePack}`;
    const source = JSON.parse(readFileSync(resolve(owner, sourceRoot, 'source.json'), 'utf8'));
    const codec = readFileSync(resolve(owner, sourceRoot, 'codec.json'));
    assert.equal(hash(readFileSync(resolve(owner, sourceRoot, 'model.onnx'))), graph.source_sha256);
    assert.equal(source.model_sha256, graph.source_sha256); assert.equal(source.codec_sha256, hash(codec));
    assert.ok(codec.equals(decode(info.codec.path)), 'New weights must retain the selected package alphabet');
  } else assert.equal(graph.source_sha256, info.cpu.sha256);
  assert.ok(graph.checks.length === 2 && graph.checks.every(check => check.all_outputs_exact));
  const path = `assets/indra-compact/${group ? group + '/' : ''}${name}/model.ort`, bytes = readFileSync(resolve(owner, path));
  assert.equal(hash(bytes), graph.ort_sha256);
  delete assets[info.cpu.path]; compressed.delete(info.cpu.path); delete manifest.assets[info.cpu.path];
  info.cpu = { path, sha256: hash(bytes), format: 'ort', source_sha256: graph.source_sha256, weight_precision: precision };
  manifest.assets[path] = { bytes: bytes.length, sha256: hash(bytes) }; asset(path, bytes);
}
const detector = readFileSync(resolve(folder, 'detector/model.ort'));
assert.equal(manifest.detector.sha256, graphs.models.detector.source_sha256);
assert.equal(hash(detector), graphs.models.detector.ort_sha256);
delete manifest.assets[manifest.detector.path];
manifest.detector = { path: `assets/indra-compact/${group ? group + '/' : ''}detector/model.ort`, sha256: hash(detector), format: 'ort', source_sha256: graphs.models.detector.source_sha256 };
manifest.assets[manifest.detector.path] = { bytes: detector.length, sha256: hash(detector) }; asset('indraDetector', detector);
for (const [key, filename, expected] of [['ortMjs', 'ort-wasm-simd-threaded.mjs', engine.loader_sha256], ['ortWasm', 'ort-wasm-simd-threaded.wasm', engine.wasm_sha256]]) {
  const bytes = readFileSync(resolve(baseFolder, 'runtime', filename)); assert.equal(hash(bytes), expected);
  asset(key, bytes); manifest.assets['dist/' + filename] = { bytes: bytes.length, sha256: expected };
}
configuration.packs = Object.fromEntries(Object.entries(manifest.models).map(([name, info]) => [name, Object.fromEntries(Object.entries(info).map(([kind, data]) => [kind, data.path]))]));
configuration.graphOptimizationLevel = 'disabled';
manifest.variant = variant + '-compact' + suffix; manifest.cpu_runtime = { model_format: 'ort', build: engine, graphs };
manifest.modifications += ` Models use portable preoptimized ORT format and a model-specific minimal engine. Stored recognizer weights use ${precision.toUpperCase()} precision; computation remains FP32.`;
asset('packageNotice', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
const html = base.replace('globalThis.LEGAL_OCR_ASSETS=' + originalAssets, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
  .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + originalCompression, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]))
  .replace('globalThis.LEGAL_OCR_PACKAGE=' + originalConfiguration, () => 'globalThis.LEGAL_OCR_PACKAGE=' + JSON.stringify(configuration));
const output = resolve(owner, `dist/legal-browser-ocr-${variant}-compact${suffix}.html`);
writeFileSync(output, html);
const receipt = { origin: 'machine_test', run_id: randomUUID(), variant, precision, group, base_html_sha256: hash(Buffer.from(base)),
  html_sha256: hash(Buffer.from(html)), html_bytes: Buffer.byteLength(html), runtime: engine, models: graphs.models };
writeFileSync(output.replace('.html', '.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ output, bytes: receipt.html_bytes, sha256: receipt.html_sha256 }));
