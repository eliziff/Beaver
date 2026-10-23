import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';

const root = resolve(import.meta.dirname, '../..'), owner = resolve(root, 'legal-browser-ocr');
const {build} = createRequire(resolve(owner, 'package.json'))('esbuild');
const mode = process.argv[2] || 'int8'; assert.ok(['int8', 'convhswish'].includes(mode));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = readFileSync(resolve(owner, 'dist/legal-browser-ocr.html'), 'utf8');
const embedded = base.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const compression = base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const assets = JSON.parse(embedded), compressed = new Set(JSON.parse(compression));
const notice = JSON.parse(gunzipSync(Buffer.from(assets.packageNotice, 'base64')));
const sources = {};
const set = (key, bytes) => { assets[key] = gzipSync(bytes, {level: 9}).toString('base64'); compressed.add(key); sources[key] = {bytes: bytes.length, sha256: hash(bytes)}; };
function replace(source, before, after) { assert.equal(source.split(before).length, 2, before); return source.replace(before, () => after); }
const variants = mode === 'int8' ? {s8: 'frontier-int8/s8', u8: 'frontier-int8/u8'} : {conv: 'frontier-convhswish'};
for (const [name, path] of Object.entries(variants)) {
  const folder = resolve(owner, 'assets/detectors', path), model = readFileSync(resolve(folder, 'model.onnx'));
  const metadata = JSON.parse(readFileSync(resolve(folder, 'source.json'))); assert.equal(hash(model), metadata.model_sha256);
  set('frontierDetector' + name, model);
}
const engine = mode === 'int8' ? resolve(owner, 'node_modules/onnxruntime-web/dist') : resolve(owner, 'assets/indra-kernels/frontier2');
for (const suffix of ['mjs', 'wasm']) set(suffix === 'mjs' ? 'ortMjs' : 'ortWasm', readFileSync(resolve(engine, `ort-wasm-simd-threaded.${suffix}`)));
const worker = await build({entryPoints: [resolve(owner, 'experiments/ocr-speed/detector-worker.js')], bundle: true, format: 'iife', minify: true, legalComments: 'inline', write: false,
  plugins: [{name: 'detector-mode', setup(build) {
    build.onLoad({filter: /[\\/]detector-worker\.js$/}, ({path}) => {
      let contents = readFileSync(path, 'utf8');
      contents = replace(contents, 'let ready;', 'const ready = new Map();');
      contents = replace(contents, 'modelOptions, profile }', 'modelOptions, profile, frontierVariant }');
      contents = replace(contents, '    ready ||= load(modelOptions);',
        `    const variant = frontierVariant || 'control';\n    if (!['control', ${Object.keys(variants).map(key => `'${key}'`).join(', ')}].includes(variant)) throw Error('Unknown detector variant');\n    if (!ready.has(variant)) ready.set(variant, load({...modelOptions, modelPath: modelOptions.frontierModels[variant] || modelOptions.modelPath}));`);
      contents = replace(contents, 'const loaded = await ready,', 'const loaded = await ready.get(variant),');
      contents = replace(contents, 'timing: { layout_prepare_seconds:', `timing: { frontier_detector_variant: ({control: 0, s8: 1, u8: 2, conv: 3})[variant], layout_prepare_seconds:`);
      return {contents, resolveDir: resolve(owner, 'experiments/ocr-speed'), loader: 'js'};
    });
  }}]});
set('detectorWorker', Buffer.from(worker.outputFiles[0].contents));
const app = await build({entryPoints: [resolve(owner, 'app.js')], bundle: true, format: 'esm', minify: true, legalComments: 'inline', write: false,
  plugins: [{name: 'detector-mode-main', setup(build) {
    build.onLoad({filter: /[\\/]tesseract-layout\.js$/}, ({path}) => ({contents: replace(readFileSync(path, 'utf8'),
      'profile: Boolean(timing) }', 'profile: Boolean(timing), frontierVariant: globalThis.legalOcrExperimentalVariant || \'control\' }'), resolveDir: owner, loader: 'js'}));
    build.onLoad({filter: /[\\/]app\.js$/}, ({path}) => ({contents: replace(readFileSync(path, 'utf8'),
      "  $('segmentation').querySelector('[value=\"tesseract\"]').textContent=detector==='indra'?'Indra line detection':'Paddle line detection';",
      `  layoutOptions.modelOptions.frontierModels = {${Object.keys(variants).map(key => `${key}: await assetUrl('frontierDetector${key}', '', 'application/octet-stream')`).join(', ')}};\n  $('segmentation').querySelector('[value="tesseract"]').textContent=detector==='indra'?'Indra line detection':'Paddle line detection';`), resolveDir: owner, loader: 'js'}));
  }}]});
notice.experimental_detector = {mode, sources, engine: mode === 'int8' ? 'stock ORT 1.22 full WASM for control and INT8 variants; no custom four-row or HardSwish kernel' : 'custom ORT 1.22 convolution/HardSwish epilogue'};
set('packageNotice', Buffer.from(JSON.stringify(notice, null, 2) + '\n'));
let html = base.replace('globalThis.LEGAL_OCR_ASSETS=' + embedded, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
  .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + compression, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]));
const moduleText = html.match(/const moduleUrl=URL.createObjectURL\(new Blob\(\[("(?:\\.|[^"\\])*")\],\{type:'text\/javascript'\}\)\);/)[1];
html = replace(html, moduleText, JSON.stringify(Buffer.from(app.outputFiles[0].contents).toString('utf8').replaceAll('</script', '<\\/script')));
const output = resolve(owner, `dist/runtime-frontier-detector-${mode}.html`);
writeFileSync(output, html);
writeFileSync(output.replace('.html', '.json'), JSON.stringify({origin: 'machine_test', run_id: randomUUID(), mode, sources,
  base_html_sha256: hash(Buffer.from(base)), html_sha256: hash(Buffer.from(html)), bytes: Buffer.byteLength(html)}, null, 2) + '\n');
console.log(JSON.stringify({output, bytes: Buffer.byteLength(html), sha256: hash(Buffer.from(html))}));
