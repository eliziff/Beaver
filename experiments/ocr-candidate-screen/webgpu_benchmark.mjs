import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';

const root = fileURLToPath(new URL('../../', import.meta.url));
const owner = resolve(root, 'legal-browser-ocr');
const { chromium } = createRequire(resolve(root, 'package.json'))('playwright');
const [manifestArg, outputArg, casesArg] = process.argv.slice(2);
assert.ok(manifestArg && outputArg && casesArg, 'usage: webgpu_benchmark.mjs MANIFEST OUTPUT MODEL:webgpu|wasm:BATCH,...');
const manifestPath = resolve(manifestArg), inputs = dirname(manifestPath), output = resolve(outputArg);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = casesArg.split(',').map(value => {
  const [name, backend, batch] = value.split(':');
  assert.match(name, /^[a-z0-9]+$/);
  assert.ok(['webgpu', 'wasm'].includes(backend));
  assert.ok([4, 16, 32, 64].includes(Number(batch)));
  const model = resolve(owner, 'assets/indra-followup', name, 'model.onnx');
  return { name, backend, batch: Number(batch), key: value, model_sha256: hash(readFileSync(model)) };
});
for (const entry of manifest.scales['1']) {
  assert.match(entry.file, /^[a-zA-Z0-9.-]+$/);
  const bytes = readFileSync(resolve(inputs, entry.file));
  assert.equal(hash(bytes), entry.sha256);
  assert.equal(bytes.length, entry.dims.reduce((a, b) => a * b, 4));
  assert.equal(entry.widths.length, entry.dims[0]);
  assert.ok(entry.widths.every(width => width > 0 && width <= entry.dims[3]));
}
mkdirSync(output, { recursive: true });
const roots = { ort: resolve(owner, 'node_modules/onnxruntime-web/dist'), inputs,
  cpu: resolve(owner, 'assets/indra-kernels/sgemm'), assets: resolve(owner, 'assets/indra-followup') };
const server = createServer((request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>OCR GPU measurement</title>'); return; }
    const [, prefix, ...parts] = path.split('/');
    const base = roots[prefix];
    if (!base) throw Error('Unknown asset');
    const file = resolve(base, ...parts);
    if (!file.startsWith(base + sep)) throw Error('Invalid asset path');
    const mime = file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': mime }).end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const client = await browser.newBrowserCDPSession();
  const hardware = await client.send('SystemInfo.getInfo');
  await client.detach();
  const results = {};
  const pages = [];
  for (const entry of cases) {
    const page = await browser.newPage();
    page.on('pageerror', error => console.error(entry.key, error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(entry.key, message.text().slice(0, 600)); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const initialization = await page.evaluate(async ({ manifest, entry }) => {
      const ort = await import(entry.backend === 'webgpu' ? '/ort/ort.webgpu.min.mjs' : '/ort/ort.wasm.min.mjs');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = entry.backend === 'webgpu'
        ? { mjs: '/ort/ort-wasm-simd-threaded.jsep.mjs', wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm' }
        : { mjs: '/cpu/ort-wasm-simd-threaded.mjs', wasm: '/cpu/ort-wasm-simd-threaded.wasm' };
      let adapterInfo = null;
      if (entry.backend === 'webgpu') {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter || adapter.isFallbackAdapter) throw Error('Hardware WebGPU adapter unavailable');
        adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
          device: adapter.info.device, description: adapter.info.description, features: [...adapter.features] };
      }
      const lines = [];
      for (const source of manifest.scales['1']) {
        const values = new Float32Array(await (await fetch('/inputs/' + source.file)).arrayBuffer());
        for (let n = 0; n < source.widths.length; n++) {
          const width = source.widths[n], pixels = new Float32Array(32 * width);
          for (let y = 0; y < 32; y++) pixels.set(values.subarray((n * 32 + y) * source.dims[3], (n * 32 + y) * source.dims[3] + width), y * width);
          lines.push({ pixels, width });
        }
      }
      if (lines.length !== manifest.lines) throw Error('Input line count changed');
      const feeds = [];
      for (let offset = 0; offset < lines.length; offset += entry.batch) {
        const selected = lines.slice(offset, offset + entry.batch);
        const width = Math.ceil(Math.max(...selected.map(line => line.width)) / 8) * 8;
        const pixels = new Float32Array(selected.length * 32 * width);
        selected.forEach((line, n) => { for (let y = 0; y < 32; y++) pixels.set(line.pixels.subarray(y * line.width, (y + 1) * line.width), (n * 32 + y) * width); });
        feeds.push({ image: new ort.Tensor('float32', pixels, [selected.length, 1, 32, width]),
          widths: new ort.Tensor('int64', BigInt64Array.from(selected, line => BigInt(line.width)), [selected.length]) });
      }
      const session = await ort.InferenceSession.create(await (await fetch(`/assets/${entry.name}/model.onnx`)).arrayBuffer(), {
        executionProviders: [entry.backend], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false,
      });
      globalThis.run = async inspect => {
        const ids = [];
        const started = performance.now();
        for (const feed of feeds) {
          const out = await session.run(feed, ['class_ids', 'lengths']);
          if (inspect) for (let n = 0; n < out.lengths.data.length; n++) {
            const length = Number(out.lengths.data[n]), steps = out.class_ids.dims[1];
            if (length < 1 || length > steps) throw Error('Invalid output length');
            for (let t = 0; t < length; t++) ids.push(Number(out.class_ids.data[n * steps + t]));
          }
          for (const tensor of Object.values(out)) tensor.dispose();
        }
        const seconds = (performance.now() - started) / 1000;
        if (!inspect) return { seconds };
        if (!ids.every(id => Number.isInteger(id) && id >= 0 && id < 1680)) throw Error('Invalid character IDs');
        const digest = await crypto.subtle.digest('SHA-256', Uint32Array.from(ids).buffer);
        return { seconds, greedy_ids_sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') };
      };
      return { adapter: adapterInfo, warmup: await globalThis.run(true), user_agent: navigator.userAgent };
    }, { manifest, entry });
    results[entry.key] = { ...entry, ...initialization, seconds: [] };
    pages.push({ page, entry });
    console.log(`${entry.key}: warmed`);
  }
  for (let round = 0; round < 7; round++) for (let i = 0; i < pages.length; i++) {
    const { page, entry } = pages[(i + round) % pages.length];
    results[entry.key].seconds.push((await page.evaluate(() => globalThis.run(false))).seconds);
  }
  for (const { page, entry } of pages) {
    const result = results[entry.key];
    assert.equal((await page.evaluate(() => globalThis.run(true))).greedy_ids_sha256, result.warmup.greedy_ids_sha256);
    result.median_seconds = [...result.seconds].sort((a, b) => a - b)[3];
    result.lines_per_second = manifest.lines / result.median_seconds;
    console.log(`${entry.key}: ${result.lines_per_second.toFixed(2)} lines/s`);
  }
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ origin: 'machine_test', run_id: randomUUID(),
    scope: 'Warm recognition on prepared 128 development lines; CPU input/output transfers included; no page-speed claim',
    rounds: 7, order: 'Rotate starting case each round; same full Chromium for CPU and GPU',
    hardware: { cpu: cpus()[0].model, ...hardware.gpu }, input_manifest_sha256: hash(readFileSync(manifestPath)),
    models: results }, null, 2) + '\n');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
