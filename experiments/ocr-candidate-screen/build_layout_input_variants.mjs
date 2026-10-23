import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..'), owner = resolve(root, 'legal-browser-ocr');
const { build } = createRequire(resolve(owner, 'package.json'))('esbuild');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHtml = readFileSync(resolve(owner, 'dist/legal-browser-ocr.html'), 'utf8');
const embedded = originalHtml.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const compressedText = originalHtml.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const originalAssets = JSON.parse(embedded), compressed = new Set(JSON.parse(compressedText));
const decode = key => compressed.has(key) ? gunzipSync(Buffer.from(originalAssets[key], 'base64')) : Buffer.from(originalAssets[key], 'base64');
const originalSource = readFileSync(resolve(owner, 'experiments/ocr-speed/detector-worker.js'), 'utf8');
const variants = process.argv.slice(2);
if (!variants.length) variants.push('control', 'reuse', 'medium', 'low', 'cpu-page');
assert.ok(variants.every(variant => ['control', 'reuse', 'medium', 'low', 'cpu-page', 'pagebatch8'].includes(variant)));
function replace(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Expected one source anchor: ' + before);
  return source.replace(before, () => after);
}
for (const variant of variants) {
  const reuse = !['control', 'cpu-page', 'pagebatch8'].includes(variant);
  let source = originalSource;
  source = replace(source, 'let ready;', 'let ready;\nlet inputCanvas, inputBuffer;');
  source = replace(source, '  const canvas = new OffscreenCanvas(inputWidth, inputHeight), context = canvas.getContext',
    `  const prepareStarted = performance.now();\n  const canvas = ${!reuse ? 'new OffscreenCanvas(inputWidth, inputHeight)' : '(inputCanvas && inputCanvas.width === inputWidth && inputCanvas.height === inputHeight ? inputCanvas : inputCanvas = new OffscreenCanvas(inputWidth, inputHeight))'}, context = canvas.getContext`);
  if (variant === 'medium' || variant === 'low') source = replace(source, "backend === 'indra' ? 'high' : 'low'", `backend === 'indra' ? '${variant}' : 'low'`);
  source = replace(source, '  const rgba = context.getImageData', '  const drawFinished = performance.now();\n  const rgba = context.getImageData');
  source = replace(source, '  const channels = backend', '  const readFinished = performance.now();\n  const channels = backend');
  if (reuse) source = replace(source, 'data = new Float32Array(plane * channels)', 'data = inputBuffer?.length === plane * channels ? inputBuffer.fill(0) : inputBuffer = new Float32Array(plane * channels)');
  source = replace(source, '  canvas.width = canvas.height = 1;', !reuse ? '  canvas.width = canvas.height = 1;' : '  // Keep only one bounded canvas and input tensor per detector worker.');
  source = replace(source, 'return { data, dims:', 'return { inputTiming: { layout_draw_seconds: (drawFinished - prepareStarted) / 1000, layout_read_seconds: (readFinished - drawFinished) / 1000, layout_normalize_seconds: (performance.now() - readFinished) / 1000 }, data, dims:');
  source = replace(source, 'timing: { layout_prepare_seconds:', 'timing: { ...prepared.inputTiming, layout_prepare_seconds:');
  const built = await build({ stdin: { contents: source, resolveDir: resolve(owner, 'experiments/ocr-speed'), sourcefile: 'detector-worker.js' }, bundle: true, format: 'iife', minify: true, legalComments: 'inline', write: false });
  const worker = Buffer.from(built.outputFiles[0].contents), assets = { ...originalAssets };
  assets.detectorWorker = gzipSync(worker, { level: 9 }).toString('base64'); compressed.add('detectorWorker');
  const notice = JSON.parse(decode('packageNotice').toString('utf8'));
  notice.experimental_layout_input = { variant, source_sha256: hash(Buffer.from(source)), worker_sha256: hash(worker) };
  notice.assets['dist/detector-worker.js'] = { bytes: worker.length, sha256: hash(worker) };
  assets.packageNotice = gzipSync(Buffer.from(JSON.stringify(notice, null, 2) + '\n'), { level: 9 }).toString('base64'); compressed.add('packageNotice');
  let html = originalHtml.replace('globalThis.LEGAL_OCR_ASSETS=' + embedded, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
    .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + compressedText, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]));
  if (['cpu-page', 'pagebatch8'].includes(variant)) {
    let app = readFileSync(resolve(owner, 'app.js'), 'utf8').replaceAll('\r\n', '\n');
    if (variant === 'cpu-page') app = replace(app, "async function documentCanvas(number,timing){\n  const canvas=document.createElement('canvas');",
      "async function documentCanvas(number,timing){\n  const canvas=document.createElement('canvas');\n  canvas.getContext('2d', {willReadFrequently:true});");
    if (variant === 'pagebatch8') {
      app = replace(app, "const pageBatch = Number(experimental.get('pageBatch') || defaults.pageBatch);", "const pageBatch = Number(experimental.get('pageBatch') || (backend === 'webgpu' ? 8 : defaults.pageBatch));");
      app = replace(app, 'pageBatch > 4', 'pageBatch > 8');
      app = replace(app, 'pageBatch must be between 1 and 4', 'pageBatch must be between 1 and 8');
    }
    const compiled = await build({ stdin: { contents: app, resolveDir: owner, sourcefile: 'app.js' }, bundle: true, format: 'esm', minify: true, legalComments: 'inline', write: false });
    const moduleText = html.match(/const moduleUrl=URL.createObjectURL\(new Blob\(\[("(?:\\.|[^"\\])*")\],\{type:'text\/javascript'\}\)\);/)[1];
    html = replace(html, moduleText, JSON.stringify(Buffer.from(compiled.outputFiles[0].contents).toString('utf8').replaceAll('</script', '<\\/script')));
  }
  const output = resolve(owner, `dist/runtime-speed-layout-${variant}.html`);
  writeFileSync(output, html);
  const receipt = { origin: 'machine_test', run_id: randomUUID(), variant, base_html_sha256: hash(Buffer.from(originalHtml)),
    source_sha256: hash(Buffer.from(source)), worker_sha256: hash(worker), html_sha256: hash(Buffer.from(html)), html_bytes: Buffer.byteLength(html) };
  writeFileSync(output.replace('.html', '.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ variant, bytes: receipt.html_bytes, sha256: receipt.html_sha256 }));
}
