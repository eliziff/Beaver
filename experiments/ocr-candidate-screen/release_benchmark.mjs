import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { ocrTier } from '../../legal-browser-ocr/ocr-tiers.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), owner = resolve(root, 'legal-browser-ocr');
const require = createRequire(resolve(owner, 'package.json'));
const { chromium } = createRequire(resolve(root, 'package.json'))('playwright');
const { createCanvas } = require('@napi-rs/canvas');
const { getDocument } = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const [manifestArg, outputArg, casesArg = 'balanced:cpu,balanced:webgpu', roundsArg = '3', queryArg = ''] = process.argv.slice(2);
assert.ok(manifestArg && outputArg, 'usage: release_benchmark.mjs MANIFEST OUTPUT TIER:cpu|webgpu|auto,... [1|3|7]');
const rounds = Number(roundsArg); assert.ok([1, 3, 7].includes(rounds));
const cases = casesArg === 'hosted' ? [] : casesArg.split(',').map(key => { const [tier, backend] = key.split(':'); ocrTier(tier); assert.ok(['cpu', 'webgpu', 'auto'].includes(backend)); return { key: key.replace(':', '-'), tier, backend }; });
const manifestPath = resolve(manifestArg), inputs = dirname(manifestPath), output = resolve(outputArg), dist = resolve(owner, 'dist');
const standalonePath = resolve(dist, process.env.OCR_RELEASE_HTML || 'legal-browser-ocr.html');
assert.ok(standalonePath.startsWith(dist + sep));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = value => value.replace(/[\u00ad\u00ac]\r?\n/g, '').normalize('NFKC').replace(/[\u00ad\u00ac]/g, '').replace(/\s+/gu, ' ').trim();
function distance(a, b) {
  a = Array.from(a); b = Array.from(b); const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) { let previous = row[0]; row[0] = i + 1; for (let j = 0; j < b.length; j++) { const old = row[j + 1]; row[j + 1] = Math.min(old + 1, row[j] + 1, previous + Number(a[i] !== b[j])); previous = old; } }
  return row[b.length];
}
const pdfPath = resolve(inputs, 'input.pdf');
const reference = JSON.parse(readFileSync(resolve(inputs, '../latest/desktop/matched-balanced/results.json'), 'utf8'));
assert.equal(hash(readFileSync(pdfPath)), reference.input_pdf_sha256);
mkdirSync(output, { recursive: true });
const loadPdf = path => getDocument({ data: Uint8Array.from(readFileSync(path)) }).promise;
async function firstPageCanvas(doc, scale = 1) { const page = await doc.getPage(1), view = page.getViewport({ scale }), canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height)); await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise; return canvas; }
async function pixels(doc) { const canvas = await firstPageCanvas(doc); return Buffer.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data); }
const original = await loadPdf(pdfPath), originalPixels = await pixels(original);
const firstPagePng = (await firstPageCanvas(original, 2)).toBuffer('image/png');
const server = createServer((request, response) => {
  try {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (!path.startsWith(dist + sep)) throw Error('Invalid asset path');
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }[extname(path)] || 'application/octet-stream';
    const bytes=readFileSync(path);
    response.writeHead(200, { 'Content-Type': mime, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const result = { origin: 'machine_test', run_id: randomUUID(), rounds, hardware: { cpu: cpus()[0].model, logical_cpus: cpus().length },
  input_manifest_sha256: hash(readFileSync(manifestPath)), input_pdf_sha256: hash(readFileSync(pdfPath)),
  standalone: { bytes: statSync(standalonePath).size, sha256: hash(readFileSync(standalonePath)) },
  archive_sha256: hash(readFileSync(resolve(dist, 'legal-browser-ocr-runtime.tar.gz'))), models: {} };
const save = () => writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
async function ready(page) { await page.waitForFunction(() => /Model (ready|failed)/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 180000 }); assert.match(await page.locator('#status').textContent(), /Model ready/); }
async function upload(page, path) { await page.setInputFiles('#file', path); await page.waitForFunction(() => document.querySelector('#status').textContent === 'Page 1 ready.', null, { timeout: 120000 }); }
async function recognize(page) {
  const started = performance.now(); await page.locator('#all').click();
  await page.waitForFunction(() => !document.querySelector('#all').disabled, null, { timeout: 300000 });
  const seconds = (performance.now() - started) / 1000;
  assert.equal(await page.locator('#download').isEnabled(), true, await page.locator('#status').textContent());
  return { seconds, texts: [await page.locator('#text').textContent(), ...await page.locator('#document .pair pre').allTextContents()],
    stages: await page.evaluate(() => window.legalOcrLastDocumentTimings) };
}
try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  result.browser_version=browser.version();
  const client = await browser.newBrowserCDPSession(); result.browser_gpu = (await client.send('SystemInfo.getInfo')).gpu; await client.detach();
  for (const entry of cases) {
    const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(entry.key, message.text().slice(0, 500)); });
    const url = pathToFileURL(standalonePath), query=new URLSearchParams(queryArg);
    query.set('backend',entry.backend);query.set('tier',entry.tier);query.set('timing','1');url.search=query.toString();
    const started = performance.now(); await page.goto(url.href); await ready(page);
    const value = { ...entry, startup_seconds: (performance.now() - started) / 1000, configuration: await page.evaluate(() => window.legalOcrConfiguration()), runs: [] };
    if (entry.backend === 'auto') assert.ok(['wasm', 'webgpu'].includes(value.configuration.backend));
    else assert.equal(value.configuration.backend, entry.backend === 'cpu' ? 'wasm' : 'webgpu');
    assert.equal(await page.locator('#mode').inputValue(), entry.tier);
    assert.equal(await page.locator('#mode option').count(), 5);
    console.log(`${entry.key}: ready in ${value.startup_seconds.toFixed(2)}s`);
    await upload(page, pdfPath); const warmup = await recognize(page); value.first_document_seconds = warmup.seconds;
    value.first_document_stages=warmup.stages;
    console.log(`${entry.key}: first document ${(manifest.pages.length / warmup.seconds).toFixed(3)} pages/s`);
    assert.equal(warmup.texts.length, manifest.pages.length);
    for (let round = 0; round < rounds; round++) {
      const run = await recognize(page); assert.deepEqual(run.texts, warmup.texts, 'OCR changed between warm passes'); value.runs.push(run);
      console.log(`${entry.key}: round ${round + 1}: ${(manifest.pages.length / run.seconds).toFixed(3)} pages/s`);
    }
    value.median_seconds = value.runs.map(run => run.seconds).sort((a, b) => a - b)[Math.floor(rounds / 2)];
    value.pages_per_second = manifest.pages.length / value.median_seconds;
    value.edits = warmup.texts.reduce((sum, text, i) => sum + distance(manifest.pages[i].gold, normalized(text)), 0);
    value.characters = manifest.pages.reduce((sum, page) => sum + Array.from(page.gold).length, 0); value.cer = value.edits / value.characters;
    value.text_sha256 = hash(Buffer.from(JSON.stringify(warmup.texts)));
    value.lines_sha256 = hash(Buffer.from(JSON.stringify(await page.evaluate(() => window.legalOcrLastDocumentLines))));
    assert.equal(await page.locator('#document img').count(), 0);
    assert.equal(await page.locator('#page').evaluate(canvas => canvas.width > 10 && canvas.height > 10), true);
    await page.screenshot({ path: resolve(output, entry.key + '.png') });
    const downloadPromise = page.waitForEvent('download'); await page.locator('#download').click();
    const exportedPath = resolve(output, entry.key + '-searchable.pdf'); await (await downloadPromise).saveAs(exportedPath);
    const exported = await loadPdf(exportedPath);
    try {
      assert.equal(exported.numPages, manifest.pages.length);
      for (let i = 0; i < exported.numPages; i++) {
        const content = await (await exported.getPage(i + 1)).getTextContent({ disableNormalization: true });
        const text = normalized(content.items.filter(item => 'str' in item).map(item => item.str + (item.hasEOL ? '\n' : '')).join(''));
        assert.equal(text.replace(/\s/gu, ''), normalized(warmup.texts[i]).replace(/\s/gu, ''), entry.key + ': exported text changed on page ' + (i + 1));
      }
      assert.ok((await pixels(exported)).equals(originalPixels), 'Original page pixels changed');
    } finally { await exported.destroy(); }
    value.pdf_gate = { text_pages: manifest.pages.length, first_page_pixels_identical: true, sha256: hash(readFileSync(exportedPath)) };
    assert.deepEqual(errors, []);
    const cpu = result.models[entry.tier + '-cpu'];
    if (value.configuration.backend === 'webgpu' && cpu) assert.ok(value.cer <= cpu.cer + .0005, `${entry.key}: GPU exceeded +0.05 percentage point CER gate`);
    result.models[entry.key] = value; save();
    console.log(`${entry.key}: ${value.pages_per_second.toFixed(3)} pages/s, ${(value.cer * 100).toFixed(3)}% CER; offline and PDF gates passed`);
    await context.close();
  }
  for (const value of Object.values(result.models)) if (value.configuration.backend === 'webgpu') {
    const cpu = result.models[value.tier + '-cpu'];
    if (cpu) assert.ok(value.cer <= cpu.cer + .0005, `${value.key}: GPU exceeded +0.05 percentage point CER gate`);
  }
  result.hosted_png_source={source:'frozen_pdf_first_page',dpi:144,sha256:hash(firstPagePng)};
  result.hosted_png_smoke={};
  for(const backend of ['cpu','auto']) {
    const context = await browser.newContext({ acceptDownloads: true }); const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/legal-browser-ocr-runtime/index.html?backend=${backend}`); await ready(page);
    await upload(page, {name:'benchmark-page.png',mimeType:'image/png',buffer:firstPagePng});
    result.hosted_png_smoke[backend] = { configuration:await page.evaluate(()=>window.legalOcrConfiguration()), characters: (await recognize(page)).texts[0].length };
    for (const tier of ['extreme', 'quality', 'balanced']) {
      await page.locator('#mode').selectOption(tier); await page.waitForFunction(() => !document.querySelector('#mode').disabled);
      assert.equal(await page.locator('#download').isEnabled(), false, 'Tier change must invalidate the previous export');
      assert.equal((await page.evaluate(() => window.legalOcrConfiguration())).tier, tier);
      assert.ok((await recognize(page)).texts[0].length > 100);
    }
    await page.screenshot({path:resolve(output,`hosted-${backend}.png`)});
    await context.close(); save();
  }
} finally {
  if (browser) await browser.close();
  await original.destroy();
  await new Promise(resolve => server.close(resolve));
}
