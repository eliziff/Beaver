import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, freemem } from 'node:os';

const root = fileURLToPath(new URL('../../', import.meta.url));
const experiment = dirname(fileURLToPath(import.meta.url));
const owner = resolve(root, 'legal-browser-ocr');
const { chromium } = createRequire(resolve(root, 'package.json'))('playwright');
const [manifestArg, outputArg, workersArg = '6', browserArg = 'chromium', roundsArg = '3'] = process.argv.slice(2);
assert.ok(manifestArg && outputArg, 'usage: tesseract_browser_benchmark.mjs MANIFEST OUTPUT [6] [chromium|shell] [3|7]');
assert.ok(['chromium', 'shell'].includes(browserArg));
const rounds = Number(roundsArg);
assert.ok([3, 7].includes(rounds));
const pools = workersArg.split(',').map(Number);
assert.ok(pools.every(value => Number.isInteger(value) && value >= 1 && value <= 12));
const manifestPath = resolve(manifestArg), inputs = dirname(manifestPath), output = resolve(outputArg);
const language = resolve(root, 'benchmarks/local-data/ocr-candidate-screen/tesseract-fast');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const entry of manifest.pages) assert.equal(hash(readFileSync(resolve(inputs, entry.png))), entry.png_sha256);
const reference = JSON.parse(readFileSync(resolve(inputs, '../latest/desktop/speed-pipeline/no-previews/results.json'), 'utf8'));
const inputPdf = readFileSync(resolve(inputs, 'input.pdf'));
assert.equal(hash(inputPdf), reference.input_pdf_sha256, 'Use the exact PDF from the Indra benchmark');
const model = readFileSync(resolve(language, 'eng.traineddata'));
assert.equal(hash(model), '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2');
const normalized = text => text.replace(/[\u00ad\u00ac]\r?\n/g, '').normalize('NFKC').replace(/[\u00ad\u00ac]/g, '').replace(/\s+/gu, ' ').trim();
function distance(a, b) {
  a = Array.from(a); b = Array.from(b);
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let previous = row[0]; row[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const old = row[j + 1];
      row[j + 1] = Math.min(row[j + 1] + 1, row[j] + 1, previous + Number(a[i] !== b[j])); previous = old;
    }
  }
  return row[b.length];
}
assert.equal(distance('cab', 'crab'), 1);
assert.equal(distance('😀a', '😀b'), 1);
mkdirSync(output, { recursive: true });
const roots = { npm: resolve(experiment, 'node_modules'), pdfjs: resolve(owner, 'node_modules/pdfjs-dist'), language };
const server = createServer((request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Tesseract.js Fast benchmark</title><canvas id="first"></canvas><div id="document"></div>'); return; }
    if (path === '/input.pdf') { response.writeHead(200, { 'Content-Type': 'application/pdf' }).end(inputPdf); return; }
    const [, prefix, ...parts] = path.split('/'), base = roots[prefix];
    if (!base) throw Error('Unknown asset');
    const file = resolve(base, ...parts);
    if (!file.startsWith(base + sep)) throw Error('Invalid asset path');
    const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' }[extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': mime }).end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const result = { origin: 'machine_test', run_id: randomUUID(), models: {},
  hardware: { cpu: cpus()[0].model, logical_cpus: cpus().length }, input_manifest_sha256: hash(readFileSync(manifestPath)),
  input_pdf_sha256: hash(inputPdf), language: { source: 'https://github.com/tesseract-ocr/tessdata_fast/blob/4.1.0/eng.traineddata', sha256: hash(model) },
  tesseract_js_version: JSON.parse(readFileSync(resolve(roots.npm, 'tesseract.js/package.json'), 'utf8')).version,
  tesseract_core_version: JSON.parse(readFileSync(resolve(roots.npm, 'tesseract.js-core/package.json'), 'utf8')).version,
  scope: 'Warm whole-document browser OCR: same 55-page PDF, PDF.js at 144 dpi, English fast LSTM, AUTO segmentation, text and blocks, no document previews; initial input view and startup excluded; no export timing',
  rounds };
const save = () => writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
try {
  browser = await chromium.launch({ headless: true, ...(browserArg === 'chromium' && { channel: 'chromium' }) });
  const gpuClient = await browser.newBrowserCDPSession();
  result.browser_gpu = (await gpuClient.send('SystemInfo.getInfo')).gpu;
  await gpuClient.detach();
  for (const workers of pools) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [], coreRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/tesseract-core.*\.(?:js|wasm)$/.test(request.url())) coreRequests.push(new URL(request.url()).pathname); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ url: '/npm/tesseract.js/dist/tesseract.min.js' });
    const started = performance.now();
    const setup = await page.evaluate(async count => {
      const pdfjs = await import('/pdfjs/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.min.mjs';
      const pdf = await pdfjs.getDocument({ data: await (await fetch('/input.pdf')).arrayBuffer() }).promise;
      const first = document.querySelector('#first'), firstPage = await pdf.getPage(1), viewport = firstPage.getViewport({ scale: 2 });
      first.width = Math.round(viewport.width); first.height = Math.round(viewport.height);
      await firstPage.render({ canvasContext: first.getContext('2d'), viewport }).promise;
      const scheduler = Tesseract.createScheduler();
      const workers = [];
      for (let i = 0; i < count; i++) {
        const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
          workerPath: '/npm/tesseract.js/dist/worker.min.js', corePath: '/npm/tesseract.js-core', langPath: '/language', gzip: false,
        });
        await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO, classify_enable_learning: '0', user_defined_dpi: '144' });
        scheduler.addWorker(worker); workers.push(worker);
      }
      globalThis.closeBenchmark = async () => { await scheduler.terminate(); await pdf.destroy(); };
      globalThis.runBenchmark = async () => {
        const target = document.querySelector('#document'); target.textContent = '';
        const output = Array.from({ length: pdf.numPages }, () => { const pre = document.createElement('pre'); target.append(pre); return pre; });
        const values = new Array(pdf.numPages), dimensions = new Array(pdf.numPages);
        let next = 1;
        const started = performance.now();
        const runner = async () => {
          while (next <= pdf.numPages) {
            const number = next++, canvas = document.createElement('canvas');
            try {
              const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 2 });
              canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
              if (number === 1) canvas.getContext('2d').drawImage(first, 0, 0);
              else await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
              dimensions[number - 1] = [canvas.width, canvas.height];
              const { data } = await scheduler.addJob('recognize', canvas, {}, { text: true, blocks: true });
              values[number - 1] = { text: data.text, lines: (data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines)).length };
              output[number - 1].textContent = data.text;
            } finally { canvas.width = canvas.height = 1; }
            await new Promise(requestAnimationFrame);
          }
        };
        await Promise.all(Array.from({ length: Math.min(count, pdf.numPages) }, runner));
        return { seconds: (performance.now() - started) / 1000, values, dimensions };
      };
      await Promise.all(workers.map(worker => worker.recognize(first, {}, { text: true, blocks: true })));
      return { pages: pdf.numPages, user_agent: navigator.userAgent, logical_cpus: navigator.hardwareConcurrency };
    }, workers);
    assert.equal(setup.pages, manifest.pages.length);
    const entry = { ...setup, workers, startup_and_first_page_seconds: (performance.now() - started) / 1000, available_memory_before: freemem(), core_requests: coreRequests, seconds: [] };
    const warmup = await page.evaluate(() => globalThis.runBenchmark());
    entry.first_document_seconds = warmup.seconds;
    console.log(`Tesseract.js Fast, ${workers} workers: warmed ${manifest.pages.length} pages`);
    for (let round = 0; round < rounds; round++) {
      const run = await page.evaluate(() => globalThis.runBenchmark());
      assert.deepEqual(run.values, warmup.values, 'Tesseract text must stay stable between warm passes');
      assert.deepEqual(run.dimensions, warmup.dimensions);
      entry.seconds.push(run.seconds);
      console.log(`Tesseract.js Fast, ${workers} workers, round ${round + 1}: ${(manifest.pages.length / run.seconds).toFixed(3)} pages/s`);
    }
    entry.median_seconds = [...entry.seconds].sort((a, b) => a - b)[Math.floor(rounds / 2)];
    entry.pages_per_second = manifest.pages.length / entry.median_seconds;
    entry.edits = warmup.values.reduce((sum, value, i) => sum + distance(manifest.pages[i].gold, normalized(value.text)), 0);
    entry.characters = manifest.pages.reduce((sum, value) => sum + Array.from(value.gold).length, 0);
    entry.cer = entry.edits / entry.characters;
    entry.pages = warmup.values;
    entry.dimensions = warmup.dimensions;
    assert.ok(entry.core_requests.some(path => path.includes('simd-lstm')), 'SIMD LSTM core was not selected');
    assert.deepEqual(errors, []);
    result.models[`tesseract-fast-${workers}`] = entry; save();
    console.log(`Tesseract.js Fast, ${workers} workers: ${entry.pages_per_second.toFixed(3)} pages/s, ${(entry.cer * 100).toFixed(3)}% CER`);
    await page.evaluate(() => globalThis.closeBenchmark());
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
