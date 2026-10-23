import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { browserOcrAssets } from '../../AuthoritiesHelper/modern/browser-ocr/package.mjs';

const root = resolve(import.meta.dirname, '../..');
const target = process.argv[3] || resolve(root, 'AuthoritiesHelper/modern/out/Authorities.html');
const kind = process.argv[4] || 'full', backend = process.argv[5] || 'auto';
assert.ok(['full', 'lite'].includes(kind)); assert.ok(['cpu', 'auto'].includes(backend));
const remote = /^https:\/\//u.test(target), html = remote ? null : resolve(target);
const output = resolve(process.argv[2] || 'benchmarks/local-data/ocr-candidate-screen/browser/packaging/latest/authorities');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = text => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
function distance(left, right) {
  const row = Array.from({length: right.length + 1}, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    let previous = row[0]; row[0] = i + 1;
    for (let j = 0; j < right.length; j++) {
      const old = row[j + 1];
      row[j + 1] = Math.min(old + 1, row[j] + 1, previous + Number(left[i] !== right[j])); previous = old;
    }
  }
  return row[right.length];
}
const expected = Object.fromEntries(Object.entries(await browserOcrAssets()).map(([name, value]) => [name, hash(Buffer.from(value, 'base64'))]));
mkdirSync(output, { recursive: true });
const require = createRequire(resolve(root, 'legal-browser-ocr/package.json'));
const {PDFDocument} = require('pdf-lib'), {createCanvas} = require('@napi-rs/canvas');
const fixtureFolder = resolve(root, 'benchmarks/local-data/ocr-candidate-screen/browser/consumers/inputs');
mkdirSync(fixtureFolder, {recursive: true});
const fixture = resolve(fixtureFolder, 'invented-inventory.pdf');
if (!existsSync(fixture)) {
  const pdf = await PDFDocument.create();
  // Independently invented inventory text; no user documents or legal facts.
  for (const amount of [482, 716]) {
    const canvas = createCanvas(1200, 1600), context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, 1200, 1600);
    context.fillStyle = 'black'; context.font = '36px serif';
    ['MAPLE RECORDS', 'Warehouse receipt', `Recorded amount ${amount}`, 'Keep this inventory for review.']
      .forEach((text, index) => context.fillText(text, 100, 160 + index * 95));
    const image = await pdf.embedPng(canvas.toBuffer('image/png'));
    pdf.addPage([600, 800]).drawImage(image, {x: 0, y: 0, width: 600, height: 800});
  }
  writeFileSync(fixture, await pdf.save());
  writeFileSync(resolve(fixtureFolder, 'source.json'), JSON.stringify({origin: 'machine_test', run_id: randomUUID(),
    input_origin: 'independently_invented', generator: 'experiments/ocr-candidate-screen/verify_authorities_runtime.mjs',
    sha256: hash(readFileSync(fixture)), regeneration: 'Remove this generated fixture and rerun the owning verifier.'}, null, 2) + '\n');
}
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
try {
  const context = await browser.newContext({ offline: !remote, viewport: { width: 1280, height: 900 } });
  try {
    await context.addInitScript(cpu => {
      if (cpu) Object.defineProperty(navigator, 'gpu', {get: () => undefined});
      globalThis.ocrProbeBackends = [];
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        postMessage(message, ...rest) {
          if (message?.type === 'init' && message.backend) globalThis.ocrProbeBackends.push(message.backend);
          return super.postMessage(message, ...rest);
        }
      };
    }, backend === 'cpu');
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(remote ? target : pathToFileURL(html).href);
    let delivered;
    if (remote) {
      assert.ok(response.ok());
      // Large inline applications exceed Chromium's response-body inspector cache.
      const download = await fetch(target); assert.ok(download.ok);
      delivered = Buffer.from(await download.arrayBuffer());
    } else delivered = readFileSync(html);
    await page.waitForFunction(() => document.readyState === 'complete' && globalThis.AUTHORITIES_ASSETS);
    const actual = await page.evaluate(async names => {
      const assets = globalThis.AUTHORITIES_ASSETS, values = {};
      for (const name of names) {
        const encoded = atob(assets[name]), bytes = Uint8Array.from(encoded, character => character.charCodeAt(0));
        const data = assets.gzip.includes(name)
          ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : bytes;
        values[name] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
      }
      return values;
    }, Object.keys(expected));
    assert.deepEqual(actual, expected, 'Standalone Authorities did not embed the released OCR assets');
    const recognized = await page.evaluate(async ({kind, pdf, sha256}) => {
      const signal = new AbortController().signal, data = Uint8Array.from(pdf);
      let pages;
      if (kind === 'full') {
        const role = 'source:inventory', id = 'machine_test-inventory';
        const product = {state: {bindings: {[role]: {lastSeen: {sha256}}}, authorityOrder: [id],
          authorities: {[id]: {source: {sources: [{bindingRole: role}]}}}}};
        await globalThis.AUTHORITIES_PDF_TEXT.prepare(product, role,
          new File([data], 'invented-inventory.pdf', {type: 'application/pdf'}), [1, 2], [1, 2], signal);
        pages = (await globalThis.AUTHORITIES_PDF_TEXT.read(sha256, [1, 2])).pages;
      } else {
        const doc = await globalThis.AuthoritiesApp.inspectPdf(data, globalThis.AuthoritiesApp.engine, () => {}, signal);
        if (!doc.pages.every(page => page.ocr)) throw Error('The invented scan was not recognized');
        pages = doc.pages;
      }
      return {pages: pages.map(page => ({width: page.width, height: page.height,
        texts: page.lines.map(line => line.text)})), backends: globalThis.ocrProbeBackends};
    }, {kind, pdf: Array.from(readFileSync(fixture)), sha256: hash(readFileSync(fixture))});
    assert.equal(recognized.pages.length, 2);
    const gold = [482, 716].map(amount => `MAPLE RECORDS Warehouse receipt Recorded amount ${amount} Keep this inventory for review.`);
    for (const [index, value] of recognized.pages.entries()) {
      assert.ok(value.width > 0 && value.height > 0);
      const text = normalized(value.texts.join('\n')), edits = distance(text, gold[index]);
      assert.ok(edits / gold[index].length < .08, 'OCR did not recover the independently invented scan');
      assert.ok(edits < distance(text, gold[1 - index]), 'Recognized text belongs to the wrong page');
      value.cer = edits / gold[index].length;
      assert.ok(value.texts.join('').length > 60);
    }
    assert.ok(recognized.backends.length > 0 && recognized.backends.every(value => ['wasm', 'webgpu'].includes(value)));
    if (backend === 'cpu') assert.ok(recognized.backends.every(value => value === 'wasm'));
    if (kind === 'full') {
      await page.reload();
      await page.waitForFunction(() => document.readyState === 'complete' && globalThis.AUTHORITIES_PDF_TEXT);
      const cached = await page.evaluate(async sha => (await globalThis.AUTHORITIES_PDF_TEXT.read(sha, [1, 2])).pages
        .map(page => ({width: page.width, height: page.height, texts: page.lines.map(line => line.text)})), hash(readFileSync(fixture)));
      assert.deepEqual(cached, recognized.pages.map(({cer, ...page}) => page), 'Recognized page text/geometry did not survive reload');
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(output, 'authorities.png') });
    const receipt = { origin: 'machine_test', run_id: randomUUID(), input_origin: 'independently_invented',
      fixture_sha256: hash(readFileSync(fixture)), kind, backend_requested: backend,
      html_sha256: hash(delivered), html_bytes: delivered.length, target: remote ? target : undefined,
      browser_version: browser.version(), offline: !remote, assets: actual, recognized, cache_reload_checked: kind === 'full',
      browser_errors: errors, passed: true };
    writeFileSync(resolve(output, 'results.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, kind, assets_verified: Object.keys(actual).length,
      html_bytes: receipt.html_bytes, backends: recognized.backends, recognized_pages: recognized.pages.length, cache_reload_checked: kind === 'full' }));
  } finally { await context.close(); }
} finally { await browser.close(); }
