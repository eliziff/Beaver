import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ocrTier } from '../../legal-browser-ocr/ocr-tiers.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), owner = resolve(root, 'legal-browser-ocr');
const require = createRequire(resolve(owner, 'package.json'));
const { PDFDocument } = require('pdf-lib'), { createCanvas } = require('@napi-rs/canvas');
const engines = createRequire(resolve(root, 'package.json'))('playwright');
const { getDocument } = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const output = resolve(process.argv[2] || 'benchmarks/local-data/ocr-candidate-screen/browser/portability/latest');
const selected = (process.argv[3] || 'chromium,firefox,webkit').split(',');
const only = (process.argv[4] || '').split(',').filter(Boolean);
const standalone = resolve(owner, 'dist', process.env.OCR_PORTABILITY_HTML || 'legal-browser-ocr.html'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const frontierVariant = process.env.OCR_PORTABILITY_VARIANT;
if (frontierVariant) assert.ok(['head', 'cascade'].includes(frontierVariant));
const requestedTier = process.env.OCR_PORTABILITY_TIER;
if (requestedTier) ocrTier(requestedTier);
assert.ok(standalone.startsWith(resolve(owner, 'dist') + sep));
mkdirSync(output, { recursive: true });

// Independently invented material; this is a compatibility test, not an accuracy benchmark.
const fixture = await PDFDocument.create(), pngs = [];
for (const number of [482, 716]) {
  const canvas = createCanvas(1200, 1600), context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'black'; context.font = '36px serif';
  ['CEDAR ARCHIVE', 'Inventory report', `Recorded balance ${number}`, 'Store this page for review.'].forEach((text, index) => context.fillText(text, 100, 160 + 95 * index));
  const png = canvas.toBuffer('image/png'); pngs.push(png.toString('base64'));
  const image = await fixture.embedPng(png);
  fixture.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
}
const input = resolve(output, 'invented-scan.pdf'), fixtureBytes = await fixture.save();
writeFileSync(input, fixtureBytes);
const loadPdf = bytes => getDocument({ data: Uint8Array.from(bytes) }).promise;
const original = await loadPdf(fixtureBytes);
async function pixels(doc) {
  const page = await doc.getPage(1), viewport = page.getViewport({ scale: 1 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return Buffer.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
}
const originalPixels = await pixels(original);
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/portability') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>OCR embedding test</title>'); return; }
    const path = resolve(owner, '.' + pathname);
    assert.ok(path.startsWith(owner + sep));
    const bytes = readFileSync(path);
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' })[extname(path)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const result = { origin: 'machine_test', run_id: randomUUID(), scope: 'Invented two-page scan; real models and export; GPU failures injected at the worker boundary',
  standalone_sha256: hash(readFileSync(standalone)), fixture_sha256: hash(fixtureBytes), fixture_png_sha256: pngs.map(png => hash(Buffer.from(png, 'base64'))), cases: [] };
if (frontierVariant) result.frontier_variant = frontierVariant;
if (requestedTier) result.tier_override = requestedTier;
const reference = process.env.OCR_PORTABILITY_REFERENCE && JSON.parse(readFileSync(resolve(process.env.OCR_PORTABILITY_REFERENCE), 'utf8'));
if (reference) assert.deepEqual(reference.fixture_png_sha256, result.fixture_png_sha256);
const save = () => writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
const textKey = value => value.normalize('NFKC').replace(/\s/gu, '');
try {
  for (const engine of selected) {
    assert.ok(['chromium', 'firefox', 'webkit'].includes(engine));
    const browser = await engines[engine].launch({ headless: true, ...(engine === 'chromium' && { channel: 'chromium' }) });
    try {
      const scenarios = [{ name: 'cpu-offline', offline: true, backend: 'cpu' }, { name: 'auto-hosted', backend: 'auto' },
        { name: 'extreme-cpu-offline', offline: true, backend: 'cpu', tier: 'extreme' },
        { name: 'gpu-init-failure', backend: 'auto', fault: 'init' }, { name: 'embedding-auto', embedding: true }];
      if (engine === 'chromium') scenarios.push({ name: 'gpu-run-failure', backend: 'auto', fault: 'run' },
        { name: 'two-core-cpu', backend: 'auto', cores: 2 }, { name: 'embedding-gpu-run-failure', embedding: true, fault: 'run' },
        { name: 'cpu-no-native-decompression', backend: 'cpu', noNative: true });
      for (const scenario of scenarios.filter(value => !only.length || only.includes(value.name))) {
        const context = await browser.newContext({ offline: Boolean(scenario.offline), acceptDownloads: true, viewport: { width: 1280, height: 900 } });
        const entry = { engine, browser_version: browser.version(), scenario: scenario.name };
        let page;
        const errors = [], consoleErrors = [];
        const phase = value => { entry.phase = value; save(); };
        result.cases.push(entry);
        try {
          if (frontierVariant) await context.addInitScript(value => { globalThis.legalOcrExperimentalVariant = value; }, frontierVariant);
          if (scenario.fault || scenario.cores || scenario.noNative) await context.addInitScript(({ fault, cores, noNative }) => {
            if (noNative) globalThis.DecompressionStream = undefined;
            if (cores) {
              Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => cores });
              Object.defineProperty(navigator, 'gpu', { get: () => undefined });
            }
            if (!fault) return;
            Object.defineProperty(navigator, 'gpu', { get: () => ({ requestAdapter: async () => ({ features: new Set(['shader-f16']) }) }) });
            const NativeWorker = Worker;
            globalThis.Worker = class extends NativeWorker {
              postMessage(message, transfers) {
                if (message.type === 'init') {
                  this.injectFailure = message.backend === 'webgpu';
                  if (this.injectFailure) { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { type: fault === 'init' ? 'error' : 'ready', message: 'Invented GPU initialization failure' } }))); return; }
                }
                if (this.injectFailure && message.type === 'recognize') {
                  for (const page of message.pages) page.bitmap?.close();
                  queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { type: 'fatal', message: 'Invented GPU device loss' } })));
                  return;
                }
                super.postMessage(message, transfers);
              }
            };
          }, scenario);
          phase('opening-page'); page = await context.newPage();
          page.on('pageerror', error => errors.push(error.message));
          page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 1000)); });
          if (scenario.embedding) {
            await page.goto(`http://127.0.0.1:${server.address().port}/portability`);
            const value = await page.evaluate(async pngs => {
              const { createBrowserOcr } = await import('/browser-runtime.js');
              const { runtimeAssetPaths } = await import('/runtime-assets.js');
              const url = name => new URL('/dist/legal-browser-ocr-runtime/' + runtimeAssetPaths[name], location.href).href;
              const runtime = createBrowserOcr({ url, bytes: async name => new Uint8Array(await (await fetch(url(name))).arrayBuffer()) });
              try {
                await runtime.prepare();
                const texts = [];
                for (const png of pngs) {
                  const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
                  const lines = await runtime.recognizePage(bitmap);
                  if (bitmap.width !== 0) throw Error('Embedding runtime retained the page bitmap');
                  texts.push(lines.map(line => line.text).join('\n'));
                }
                return { texts, configuration: runtime.configuration };
              } finally { runtime.dispose(); }
            }, pngs);
            assert.match(value.texts[0], /482/); assert.match(value.texts[1], /716/);
            if (scenario.fault) assert.equal(value.configuration.backend, 'wasm');
            assert.deepEqual(errors, []);
            entry.configuration = value.configuration; entry.passed = true; entry.text_pages = 2;
            console.log(`${engine} ${scenario.name}: passed (${value.configuration.backend})`);
            continue;
          }
          const url = scenario.offline ? pathToFileURL(standalone) : new URL(`http://127.0.0.1:${server.address().port}/dist/${basename(standalone)}`);
          url.searchParams.set('backend', scenario.backend);
          if (frontierVariant) url.searchParams.set('timing', '1');
          if (scenario.tier || requestedTier) url.searchParams.set('tier', scenario.tier || requestedTier);
          phase('loading-app'); const loadStarted = performance.now(); await page.goto(url.href);
          phase('initializing-model');
          await page.waitForFunction(() => /Model (ready|failed)/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 120_000 });
          assert.match(await page.locator('#status').textContent(), /Model ready/);
          entry.model_init_seconds = (performance.now() - loadStarted) / 1000;
          entry.features = await page.evaluate(() => ({ native_base64: typeof Uint8Array.fromBase64 === 'function',
            native_decompression: typeof DecompressionStream === 'function', offscreen_canvas: typeof OffscreenCanvas === 'function' }));
          phase('opening-pdf'); await page.setInputFiles('#file', input);
          await page.waitForFunction(() => /^(Page 1 ready\.|Could not load file:)/.test(document.querySelector('#status').textContent), null, { timeout: 60_000 });
          assert.equal(await page.locator('#status').textContent(), 'Page 1 ready.');
          phase('recognizing'); await page.locator('#all').click();
          await page.waitForFunction(() => !document.querySelector('#all').disabled, null, { timeout: 120_000 });
          assert.equal(await page.locator('#download').isEnabled(), true, await page.locator('#status').textContent());
          entry.configuration = await page.evaluate(() => window.legalOcrConfiguration());
          assert.equal(entry.configuration.tier, scenario.tier || requestedTier || 'balanced');
          if (frontierVariant) {
            const key = frontierVariant === 'head' ? 'frontier_head_batches' : 'frontier_cascade_lines';
            entry.frontier_work = await page.evaluate(key => (window.legalOcrLastDocumentTimings || []).reduce((sum, page) => sum + (page[key] || 0), 0), key);
            assert.equal(entry.frontier_work > 0, entry.configuration.backend === 'webgpu');
          }
          entry.cross_origin_isolated = await page.evaluate(() => crossOriginIsolated);
          if (scenario.fault || scenario.cores || scenario.backend === 'cpu') assert.equal(entry.configuration.backend, 'wasm');
          if (scenario.cores) assert.equal(entry.configuration.workerPoolSize, 1);
          const texts = [await page.locator('#text').textContent(), ...await page.locator('#document .pair pre').allTextContents()];
          assert.equal(texts.length, 2);
          assert.ok(texts.every(text => text.trim().length > 40), 'Each page must have recognized text');
          entry.ocr_text_sha256 = hash(Buffer.from(JSON.stringify(texts)));
          if (reference) {
            const expected = reference.cases.find(value => value.passed && value.engine === engine && value.configuration?.backend === entry.configuration.backend && value.configuration?.tier === entry.configuration.tier && value.ocr_text_sha256);
            assert.ok(expected, 'A full-package reference is required for this browser, backend and tier');
            assert.equal(entry.ocr_text_sha256, expected.ocr_text_sha256, 'Slim packaging changed the recognized text');
            entry.full_package_text_identical = true;
          }
          phase('exporting'); const download = page.waitForEvent('download'); await page.locator('#download').click();
          const pdfPath = resolve(output, `${engine}-${scenario.name}.pdf`);
          await (await download).saveAs(pdfPath);
          const exported = await loadPdf(readFileSync(pdfPath));
          try {
            assert.equal(exported.numPages, 2);
            for (let i = 0; i < 2; i++) {
              const content = await (await exported.getPage(i + 1)).getTextContent();
              assert.equal(textKey(content.items.map(item => item.str || '').join('')), textKey(texts[i]));
            }
            assert.ok((await pixels(exported)).equals(originalPixels));
          } finally { await exported.destroy(); }
          assert.deepEqual(errors, []);
          await page.screenshot({ path: resolve(output, `${engine}-${scenario.name}.png`) });
          entry.passed = true; entry.text_pages = 2; entry.original_pixels_identical = true;
          console.log(`${engine} ${scenario.name}: passed (${entry.configuration.backend})`);
        } catch (error) {
          entry.passed = false; entry.error = String(error).slice(0, 2000); entry.browser_errors = errors; entry.console_errors = consoleErrors;
          if (page) {
            entry.status = await page.locator('#status').textContent({ timeout: 1000 }).catch(() => undefined);
            await page.screenshot({ path: resolve(output, `${engine}-${scenario.name}.png`), timeout: 5000 }).catch(() => {});
          }
          console.error(`${engine} ${scenario.name}: ${entry.error}`);
        }
        finally { await context.close(); save(); }
      }
    } finally { await browser.close(); }
  }
  for (const name of only) assert.ok(result.cases.some(entry => entry.scenario === name), `Unknown or unavailable scenario: ${name}`);
  assert.ok(result.cases.length > 0 && result.cases.every(entry => entry.passed), 'Browser portability cases failed; see the private receipt');
} finally {
  await original.destroy(); await new Promise(resolve => server.close(resolve)); save();
}
