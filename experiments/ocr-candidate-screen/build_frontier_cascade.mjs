import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {ocrModels} from '../../legal-browser-ocr/ocr-tiers.js';

const root = resolve(import.meta.dirname, '../..'), owner = resolve(root, 'legal-browser-ocr');
const {build} = createRequire(resolve(owner, 'package.json'))('esbuild');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const calibrationBytes = readFileSync(resolve(root, 'benchmarks/local-data/ocr-candidate-screen/browser/frontier2/cascade-dev/results.json'));
const calibration = JSON.parse(calibrationBytes), {metric, threshold} = calibration.selected.accurate;
assert.ok(['mean', 'minimum', 'lowerQuartile'].includes(metric) && Number.isFinite(threshold));
assert.deepEqual(JSON.parse(readFileSync(resolve(owner, ocrModels.standard.codec))), JSON.parse(readFileSync(resolve(owner, ocrModels.light.codec))));
const base = readFileSync(resolve(owner, 'dist/legal-browser-ocr.html'), 'utf8');
const embedded = base.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const compression = base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const assets = JSON.parse(embedded), compressed = new Set(JSON.parse(compression));
const notice = JSON.parse(gunzipSync(Buffer.from(assets.packageNotice, 'base64'))), sources = {};
const set = (key, bytes) => { assets[key] = gzipSync(bytes, {level: 9}).toString('base64'); compressed.add(key); sources[key] = {bytes: bytes.length, sha256: hash(bytes)}; };
function replace(source, before, after) { assert.equal(source.split(before).length, 2, before); return source.replace(before, () => after); }
set('frontierCascadePolicy', Buffer.from(JSON.stringify({metric, threshold})));
const worker = await build({entryPoints: [resolve(owner, 'recognition-worker.js')], bundle: true, format: 'iife', minify: true, legalComments: 'inline', write: false,
  plugins: [{name: 'recognition-cascade', setup(build) {
    build.onLoad({filter: /[\\/]recognizer\.js$/}, ({path}) => {
      let contents = "import { emissionMargins } from './experiments/ocr-speed/cascade-policy.js';\n" + readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
      contents = replace(contents, 'export function decodeClassIds(output, n, validSteps, labels) {', 'export function decodeClassIds(output, n, validSteps, labels, margins) {');
      contents = replace(contents, '  return { text };\n}\n\n// The trained exports',
        '  return { text, ...(margins && {cascadeScore: emissionMargins(output.data, margins.data, n * steps, Math.min(steps, validSteps))}) };\n}\n\n// The trained exports');
      contents = replace(contents, 'decodeClassIds(out.class_ids, n, Number(out.lengths.data[n]), this.labels)', 'decodeClassIds(out.class_ids, n, Number(out.lengths.data[n]), this.labels, out.margins)');
      return {contents, resolveDir: owner, loader: 'js'};
    });
    build.onLoad({filter: /[\\/]recognition-worker\.js$/}, ({path}) => {
      let contents = "import { CascadeRecognizer } from './experiments/ocr-speed/cascade-recognizer.js';\n" + readFileSync(path, 'utf8');
      contents = replace(contents, 'let lineRecognizer;', 'let lineRecognizer, cascadeRecognizer, frontier;');
      contents = replace(contents, '      collectTiming=data.timing;', "      frontier=data.backend==='webgpu'?data.frontier:undefined;\n      collectTiming=data.timing;");
      contents = replace(contents, '    const timing=collectTiming?', "    const useCascade=Boolean(frontier)&&data.frontierVariant==='cascade';\n    if(useCascade&&!cascadeRecognizer)cascadeRecognizer=await CascadeRecognizer.create(ort,lineRecognizer,labels,frontier,batchSize);\n    const timing=collectTiming?");
      contents = replace(contents, 'await lineRecognizer.recognizePrepared(prepared,', 'await (useCascade?cascadeRecognizer:lineRecognizer).recognizePrepared(prepared,');
      return {contents, resolveDir: owner, loader: 'js'};
    });
  }}]});
set('recognitionWorker', Buffer.from(worker.outputFiles[0].contents));
const app = await build({entryPoints: [resolve(owner, 'app.js')], bundle: true, format: 'esm', minify: true, legalComments: 'inline', write: false,
  plugins: [{name: 'recognition-cascade-main', setup(build) {
    build.onLoad({filter: /[\\/]recognition-pool\.js$/}, ({path}) => {
      let contents = replace(readFileSync(path, 'utf8'), "{ type: 'recognize', scale: tasks[0].scale, pages }", "{ type: 'recognize', scale: tasks[0].scale, pages, frontierVariant: globalThis.legalOcrExperimentalVariant || 'control' }");
      contents = replace(contents, 'gpuDirect, collectTimings } = options;', 'gpuDirect, collectTimings, frontier } = options;');
      contents = replace(contents, "{ type: 'init', backend,", "{ type: 'init', frontier, backend,");
      return {contents, resolveDir: owner, loader: 'js'};
    });
    build.onLoad({filter: /[\\/]app\.js$/}, ({path}) => ({contents: replace(readFileSync(path, 'utf8'),
      'options: { backend, workerPoolSize,', "options: { frontier: backend === 'webgpu' ? {smallModel: await assetUrl(modelPacks.light.gpu,'./'+modelPacks.light.gpu,'application/octet-stream'), policy: JSON.parse(new TextDecoder().decode(await assetBytes('frontierCascadePolicy',''))), sessionOptions, captureEnabled, gpuCacheShapes} : undefined, backend, workerPoolSize,"), resolveDir: owner, loader: 'js'}));
  }}]});
notice.experimental_cascade = {policy: {metric, threshold}, calibration_sha256: hash(calibrationBytes), calibration_split: 'development', calibration_lines: 128,
  sources, models: ['light', 'standard'], full_alphabet: true, weights_unchanged: true};
set('packageNotice', Buffer.from(JSON.stringify(notice, null, 2) + '\n'));
let html = base.replace('globalThis.LEGAL_OCR_ASSETS=' + embedded, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
  .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + compression, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]));
const moduleText = html.match(/const moduleUrl=URL.createObjectURL\(new Blob\(\[("(?:\\.|[^"\\])*")\],\{type:'text\/javascript'\}\)\);/)[1];
html = replace(html, moduleText, JSON.stringify(Buffer.from(app.outputFiles[0].contents).toString('utf8').replaceAll('</script', '<\\/script')));
const output = resolve(owner, 'dist/runtime-frontier-cascade.html'); writeFileSync(output, html);
writeFileSync(output.replace('.html', '.json'), JSON.stringify({origin: 'machine_test', run_id: randomUUID(), sources, policy: {metric, threshold},
  calibration_sha256: hash(calibrationBytes), base_html_sha256: hash(Buffer.from(base)), html_sha256: hash(Buffer.from(html)), bytes: Buffer.byteLength(html)}, null, 2) + '\n');
console.log(JSON.stringify({output, bytes: Buffer.byteLength(html), sha256: hash(Buffer.from(html)), policy: {metric, threshold}}));
