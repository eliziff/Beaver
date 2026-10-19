import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const [htmlArg, manifestArg, outputArg] = process.argv.slice(2);
assert(htmlArg && manifestArg && outputArg, 'usage: authorities_browser_ocr.mjs Authorities.html MANIFEST OUTPUT');
const html = path.resolve(htmlArg), manifestPath = path.resolve(manifestArg), output = path.resolve(outputArg);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const count = Number(process.env.OCR_AUTHORITY_PAGES || 3), rounds = Number(process.env.OCR_AUTHORITY_ROUNDS || 0);
const parallel = Number(process.env.OCR_AUTHORITY_POOL || 0);
const backends = (process.env.OCR_AUTHORITY_BACKENDS || 'cpu,auto').split(',');
assert(Number.isInteger(count) && count >= 1 && count <= manifest.pages.length);
assert([0, 3].includes(rounds) && [0, 1, 2, 4].includes(parallel));
assert(backends.every(value => ['cpu', 'auto'].includes(value)));
const input = readFileSync(path.join(path.dirname(manifestPath), 'input.pdf'));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(input), '039410bc7219449184726a09e261724c3a0f52b050e844f4649fc3ee605bb8a8');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const results = { origin: 'machine_test', run_id: randomUUID(), html_sha256: hash(readFileSync(html)), cases: [] };
try {
  for (const backend of backends) {
    const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(({ cpu, parallel }) => {
      if (cpu) Object.defineProperty(navigator, 'gpu', { get: () => undefined });
      if (parallel) {
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => parallel * 2 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      }
      globalThis.ocrBackends = [];
      const OriginalWorker = globalThis.Worker;
      globalThis.Worker = new Proxy(OriginalWorker, { construct(Target, args) {
        const worker = new Target(...args), post = worker.postMessage.bind(worker);
        worker.postMessage = (message, transfer) => {
          if (message.type === 'init' && message.recognizer === 'indra') globalThis.ocrBackends.push(message.backend);
          return post(message, transfer);
        };
        return worker;
      } });
    }, { cpu: backend === 'cpu', parallel });
    try {
      await page.goto(pathToFileURL(html).href, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForFunction(() => !!globalThis.AUTHORITIES_PDF_TEXT, null, { timeout: 90000 });
      const value = await page.evaluate(async ({ base64, sourceSha256, count, rounds }) => {
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const file = new File([bytes], 'machine-test-scan.pdf', { type: 'application/pdf' });
        const product = { state: { bindings: { scan: { lastSeen: { sha256: sourceSha256 } } }, authorityOrder: [], authorities: {} } };
        const controller = new AbortController(), progress = [];
        const selected = Array.from({ length: count }, (_, index) => index + 1);
        const start = performance.now();
        await globalThis.AUTHORITIES_PDF_TEXT.prepare(product, 'scan', file, [1], selected, controller.signal,
          count => progress.push(count));
        const seconds = (performance.now() - start) / 1000;
        const recognized = await globalThis.AUTHORITIES_PDF_TEXT.read(sourceSha256, selected), runs = [];
        for (let round = 0; round < rounds; round++) {
          const trial = new File([bytes, `\n% machine_test OCR throughput ${crypto.randomUUID()}\n`], 'machine-test-scan.pdf');
          const trialSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await trial.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
          const trialProduct = { state: { ...product.state, bindings: { scan: { lastSeen: { sha256: trialSha } } } } };
          const begin = performance.now();
          await globalThis.AUTHORITIES_PDF_TEXT.prepare(trialProduct, 'scan', trial, [1], selected, controller.signal, () => {});
          runs.push((performance.now() - begin) / 1000);
          const trialPages = await globalThis.AUTHORITIES_PDF_TEXT.read(trialSha, selected);
          if (trialPages.pages.length !== count) throw new Error('A timed pass lost a page.');
        }
        const again = performance.now();
        await globalThis.AUTHORITIES_PDF_TEXT.prepare(product, 'scan', file, [1], selected, controller.signal, () => {});
        const cachedSeconds = (performance.now() - again) / 1000;
        return { ...recognized, seconds, runs, cachedSeconds, progress, backends: globalThis.ocrBackends };
      }, { base64: input.toString('base64'), sourceSha256: hash(input), count, rounds });
      assert.equal(value.pages.length, count);
      assert.equal(value.progress.at(-1), count);
      assert(value.backends.length && value.backends.every(item => item === value.backends[0]));
      if (backend === 'cpu') assert.equal(value.backends[0], 'wasm');
      writeFileSync(path.join(output, 'measurement.json'), JSON.stringify({ origin: 'machine_test', run_id: results.run_id,
        requested_backend: backend, actual_backend: value.backends[0], seconds: value.seconds,
        parallel_control: parallel || null, warm_runs: value.runs, validation_complete: false }, null, 2) + '\n');
      let edits = 0, characters = 0, lines = 0;
      const ordered = [...value.pages].sort((a, b) => a.pageNumber - b.pageNumber);
      for (let index = 0; index < ordered.length; index++) {
        const page = ordered[index];
        assert.equal(page.pageNumber, index + 1);
        if (normalized(manifest.pages[index].gold)) assert(page.lines.length > 0, 'a page with gold text needs recognized lines');
        for (const line of page.lines) {
          assert(line.rect.every(Number.isFinite));
          assert(line.rect[0] >= 0 && line.rect[1] >= 0 && line.rect[2] <= page.width && line.rect[3] <= page.height);
          assert(line.rect[2] > line.rect[0] && line.rect[3] > line.rect[1]); lines++;
        }
        const gold = normalized(manifest.pages[index].gold);
        edits += distance(normalized(page.lines.map(line => line.text).join('\n')), gold);
        characters += Array.from(gold).length;
      }
      assert(edits / characters < .06, 'packaged browser inference must retain readable text');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, backend + '.png') });
      results.cases.push({ requested_backend: backend, actual_backend: value.backends[0], seconds: value.seconds,
        parallel_control: parallel || null, warm_runs: value.runs,
        ...(rounds && { warm_pages_per_second: count / [...value.runs].sort((a, b) => a - b)[1] }),
        cached_seconds: value.cachedSeconds, pages: value.pages.length, lines, edits, characters, cer: edits / characters });
      writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
      console.log(JSON.stringify(results.cases.at(-1)));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

function normalized(value) { return value.replace(/[\u00ad\u00ac]\r?\n/g, '').normalize('NFKC').replace(/[\u00ad\u00ac]/g, '').replace(/\s+/gu, ' ').trim(); }
function distance(a, b) {
  const left = Array.from(a), right = Array.from(b), row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    let previous = row[0]; row[0] = i + 1;
    for (let j = 0; j < right.length; j++) {
      const old = row[j + 1]; row[j + 1] = Math.min(old + 1, row[j] + 1, previous + Number(left[i] !== right[j])); previous = old;
    }
  }
  return row[right.length];
}
