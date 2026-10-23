import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { packageAssets } from '../../legal-browser-ocr/package-assets.mjs';
import { runtimeAssetPaths } from '../../legal-browser-ocr/runtime-assets.js';

const root = resolve(import.meta.dirname, '../..'), hash = data => createHash('sha256').update(data).digest('hex');
const output = resolve(process.argv[2] || 'benchmarks/local-data/ocr-candidate-screen/browser/packaging/latest');
const receipt = { origin: 'machine_test', run_id: randomUUID(), scope: 'Every decoded packaged asset matches its source bytes; package inventory includes models and PDF support', packages: [] };
for (const variant of ['full', 'cpu', 'lite']) {
  const path = resolve(root, 'legal-browser-ocr/dist', `legal-browser-ocr${variant === 'full' ? '' : '-' + variant}.html`);
  const html = readFileSync(path, 'utf8');
  const assets = JSON.parse(html.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1]);
  const compressed = new Set(JSON.parse(html.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1]));
  const expected = packageAssets(variant);
  assert.deepEqual(Object.keys(assets).sort(), expected.map(asset => asset.key).sort());
  const inventory = expected.map(asset => {
    const encoded = Buffer.from(assets[asset.key], 'base64'), decoded = compressed.has(asset.key) ? gunzipSync(encoded) : encoded;
    assert.ok(decoded.equals(asset.bytes), `${variant}: ${asset.key} changed during packaging`);
    return { key: asset.key, bytes: decoded.length, transport_bytes: encoded.length, sha256: hash(decoded) };
  });
  const manifest = JSON.parse(expected.find(asset => asset.key === 'packageNotice').bytes);
  receipt.packages.push({ variant, html_bytes: Buffer.byteLength(html), html_gzip_bytes: gzipSync(Buffer.from(html), { level: 9 }).length, html_sha256: hash(Buffer.from(html)),
    backends: manifest.backends, default_tier: manifest.default_tier, tiers: Object.keys(manifest.tiers), inventory });
}
const compactPackages = ['fp32', 'fp16', 'bf16'].flatMap(precision => ['cpu', 'lite'].map(edition => ({
  precision, variant: edition + '-compact' + (precision === 'fp32' ? '' : '-' + precision),
})));
for (const precision of ['fp32', 'bf16']) compactPackages.push({ precision, variant: 'lite-compact-crop-' + precision });
compactPackages.push({ precision: 'bf16', variant: 'cpu-compact-crop128-bf16' });
for (const { precision, variant } of compactPackages) {
  const path = resolve(root, 'legal-browser-ocr/dist', `legal-browser-ocr-${variant}.html`);
  const html = readFileSync(path, 'utf8');
  const assets = JSON.parse(html.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1]);
  const compressed = new Set(JSON.parse(html.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1]));
  const decode = key => { const bytes = Buffer.from(assets[key], 'base64'); return compressed.has(key) ? gunzipSync(bytes) : bytes; };
  const manifest = JSON.parse(decode('packageNotice').toString('utf8'));
  const inventory = Object.keys(assets).filter(key => key !== 'packageNotice').map(key => {
    const target = key === 'indraDetector' ? manifest.detector.path : runtimeAssetPaths[key] || key;
    const decoded = decode(key);
    assert.equal(hash(decoded), manifest.assets[target].sha256, `${variant}: ${key} differs from manifest`);
    const source = ['ortMjs', 'ortWasm'].includes(key)
      ? 'assets/indra-compact/runtime/' + target.split('/').at(-1) : target;
    assert.ok(decoded.equals(readFileSync(resolve(root, 'legal-browser-ocr', source))), `${variant}: ${key} differs from source`);
    return { key, bytes: decoded.length, transport_bytes: Buffer.from(assets[key], 'base64').length, sha256: hash(decoded) };
  });
  receipt.packages.push({ variant, weight_precision: precision, html_bytes: Buffer.byteLength(html),
    html_gzip_bytes: gzipSync(Buffer.from(html), { level: 9 }).length, html_sha256: hash(Buffer.from(html)),
    backends: manifest.backends, default_tier: manifest.default_tier, tiers: Object.keys(manifest.tiers), inventory });
}
const tess = resolve(root, 'experiments/ocr-candidate-screen/node_modules');
const tessPaths = ['tesseract.js/dist/tesseract.min.js', 'tesseract.js/dist/worker.min.js', 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js'];
try {
  const files = tessPaths.map(path => ({ path, bytes: readFileSync(resolve(tess, path)) }));
  files.push({ path: 'eng.traineddata', bytes: readFileSync(resolve(root, 'benchmarks/local-data/ocr-candidate-screen/tesseract-fast/eng.traineddata')) });
  receipt.tesseract_reference = { version: JSON.parse(readFileSync(resolve(tess, 'tesseract.js/package.json'), 'utf8')).version,
    scope: 'Actual SIMD-LSTM core variant from the prior browser benchmark, API/worker and English fast data; excludes PDF.js, application UI and export',
    files: files.map(({ path, bytes }) => ({ path, bytes: bytes.length, gzip_bytes: gzipSync(bytes, { level: 9 }).length, sha256: hash(bytes) })) };
} catch (error) { if (error.code !== 'ENOENT') throw error; receipt.tesseract_reference_unavailable = true; }
mkdirSync(output, { recursive: true }); writeFileSync(resolve(output, 'results.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ packages: receipt.packages.map(({ inventory, ...value }) => value), tesseract_reference: receipt.tesseract_reference }));
