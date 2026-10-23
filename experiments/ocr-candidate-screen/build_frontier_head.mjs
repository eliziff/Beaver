import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';

const root = resolve(import.meta.dirname, '../..'), owner = resolve(root, 'legal-browser-ocr');
const {build} = createRequire(resolve(owner, 'package.json'))('esbuild');
assert.ok(process.argv[2] === undefined || ['reuse', 'packed', 'combined'].includes(process.argv[2]));
const mode = process.argv[2];
const reuseBuffers = mode === 'reuse' || mode === 'combined', packedWeights = mode === 'packed' || mode === 'combined';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = readFileSync(resolve(owner, 'dist/legal-browser-ocr.html'), 'utf8');
const embedded = base.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const compression = base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const assets = JSON.parse(embedded), compressed = new Set(JSON.parse(compression));
const notice = JSON.parse(gunzipSync(Buffer.from(assets.packageNotice, 'base64'))), sources = {};
const set = (key, bytes) => { assets[key] = gzipSync(bytes, {level: 9}).toString('base64'); compressed.add(key); sources[key] = {bytes: bytes.length, sha256: hash(bytes)}; };
function replace(source, before, after) { assert.equal(source.split(before).length, 2, before); return source.replace(before, () => after); }
for (const [kind, name] of Object.entries({standard: 'gpu8croph', light: 'gpu64croph'})) {
  const folder = resolve(owner, 'assets/indra-followup', name + '-features'), metadata = JSON.parse(readFileSync(resolve(folder, 'source.json')));
  for (const [key, file, sha] of [['Model', 'model.onnx', metadata.model_sha256], ['Head', 'head.bin', metadata.head_sha256]]) {
    const bytes = readFileSync(resolve(folder, file)); assert.equal(hash(bytes), sha); set('frontier' + kind + key, bytes);
  }
}
const worker = await build({entryPoints: [resolve(owner, 'recognition-worker.js')], bundle: true, format: 'iife', minify: true, legalComments: 'inline', write: false,
  plugins: [{name: 'feature-recognition', setup(build) {
    build.onLoad({filter: /[\\/]recognition-worker\.js$/}, ({path}) => {
      let contents = "import { FeatureSession } from './experiments/ocr-speed/feature-session.js';\nimport { FusedGpuHead } from './experiments/ocr-speed/fused-gpu-head.js';\n" + readFileSync(path, 'utf8');
      contents = replace(contents, 'let lineRecognizer;', 'let lineRecognizer, originalRecognizer, featureRecognizer, frontier;');
      contents = replace(contents, '      collectTiming=data.timing;', '      originalRecognizer=lineRecognizer;frontier=data.frontier;\n      collectTiming=data.timing;');
      contents = replace(contents, '    const timing=collectTiming?', `    const variant=frontier?(data.frontierVariant||'control'):'control';\n    if(!['control','head'].includes(variant))throw Error('Unknown recognition variant');\n    if(variant==='head'){\n      if(!featureRecognizer){\n        const read=async url=>{const response=await fetch(url);if(!response.ok)throw Error('Missing feature asset');return response.arrayBuffer()};\n        const [model,binary]=await Promise.all([read(frontier.model),read(frontier.head)]);\n        const head=await FusedGpuHead.create(ort.env.webgpu.device,binary);\n        const extracted=await FeatureSession.create(ort,new Uint8Array(model),frontier.sessionOptions,batchSize,frontier.captureEnabled,frontier.gpuCacheShapes,head);\n        featureRecognizer=new LineRecognizer(ort,extracted,{...originalRecognizer.profile,gpuArgMax:0},labels);\n        featureRecognizer.gpuPreparer=originalRecognizer.gpuPreparer;\n      }\n      lineRecognizer=featureRecognizer;\n    }else lineRecognizer=originalRecognizer;\n    const timing=collectTiming?`);
      if (reuseBuffers || packedWeights) contents = replace(contents, 'FusedGpuHead.create(ort.env.webgpu.device,binary)',
        `FusedGpuHead.create(ort.env.webgpu.device,binary,${JSON.stringify({reuseBuffers, packedWeights})})`);
      contents = replace(contents, '    let offset=0;', "    if(timing)timing.frontier_head_batches=variant==='head'?(timing.model_batches||0):0;\n    let offset=0;");
      return {contents, resolveDir: owner, loader: 'js'};
    });
  }}]});
set('recognitionWorker', Buffer.from(worker.outputFiles[0].contents));
const app = await build({entryPoints: [resolve(owner, 'app.js')], bundle: true, format: 'esm', minify: true, legalComments: 'inline', write: false,
  plugins: [{name: 'feature-recognition-main', setup(build) {
    build.onLoad({filter: /[\\/]recognition-pool\.js$/}, ({path}) => {
      let contents = replace(readFileSync(path, 'utf8'), '{ type: \'recognize\', scale: tasks[0].scale, pages }',
        "{ type: 'recognize', scale: tasks[0].scale, pages, frontierVariant: globalThis.legalOcrExperimentalVariant || 'control' }");
      contents = replace(contents, 'gpuDirect, collectTimings } = options;', 'gpuDirect, collectTimings, frontier } = options;');
      contents = replace(contents, "{ type: 'init', backend,", "{ type: 'init', frontier, backend,");
      return {contents, resolveDir: owner, loader: 'js'};
    });
    build.onLoad({filter: /[\\/]app\.js$/}, ({path}) => ({contents: replace(readFileSync(path, 'utf8'),
      'options: { backend, workerPoolSize,', `options: { frontier: backend === 'webgpu' ? {model: await assetUrl('frontier'+tier.model+'Model','','application/octet-stream'), head: await assetUrl('frontier'+tier.model+'Head','','application/octet-stream'), sessionOptions, captureEnabled, gpuCacheShapes} : undefined, backend, workerPoolSize,`), resolveDir: owner, loader: 'js'}));
  }}]});
notice.experimental_fused_head = {sources, full_alphabet: true, weights_unchanged: true, output_rounding: 'FP16', classification: 'partitioned 64-class workgroups over eight timesteps, followed by winner reduction', reuse_buffers: reuseBuffers, packed_weights: packedWeights, retained_workspace_byte_limit: reuseBuffers ? 16 * 1024 * 1024 : 0};
set('packageNotice', Buffer.from(JSON.stringify(notice, null, 2) + '\n'));
let html = base.replace('globalThis.LEGAL_OCR_ASSETS=' + embedded, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
  .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + compression, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]));
const moduleText = html.match(/const moduleUrl=URL.createObjectURL\(new Blob\(\[("(?:\\.|[^"\\])*")\],\{type:'text\/javascript'\}\)\);/)[1];
html = replace(html, moduleText, JSON.stringify(Buffer.from(app.outputFiles[0].contents).toString('utf8').replaceAll('</script', '<\\/script')));
const output = resolve(owner, `dist/runtime-frontier-head${mode === 'combined' ? '-combined' : reuseBuffers ? '-reused' : packedWeights ? '-packed' : ''}.html`); writeFileSync(output, html);
writeFileSync(output.replace('.html', '.json'), JSON.stringify({origin: 'machine_test', run_id: randomUUID(), reuse_buffers: reuseBuffers, packed_weights: packedWeights, sources,
  base_html_sha256: hash(Buffer.from(base)), html_sha256: hash(Buffer.from(html)), bytes: Buffer.byteLength(html)}, null, 2) + '\n');
console.log(JSON.stringify({output, bytes: Buffer.byteLength(html), sha256: hash(Buffer.from(html))}));
