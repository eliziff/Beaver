import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { ocrTier } from '../../legal-browser-ocr/ocr-tiers.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), owner = resolve(root, 'legal-browser-ocr');
const require = createRequire(resolve(owner, 'package.json'));
const { chromium } = createRequire(resolve(root, 'package.json'))('playwright');
const { createCanvas } = require('@napi-rs/canvas');
const { getDocument } = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const [manifestArg, outputArg, casesArg = 'balanced:cpu,balanced:webgpu', roundsArg = '3', queryArg = ''] = process.argv.slice(2);
assert.ok(manifestArg && outputArg, 'usage: release_benchmark.mjs MANIFEST OUTPUT TIER:cpu|webgpu|auto,... [1|3|7]');
const interleaved = process.env.OCR_BENCH_QUEUE_ORDER?.split(',').map(Number);
const variants = process.env.OCR_BENCH_VARIANT_ORDER?.split(',');
const controlTier = process.env.OCR_BENCH_CONTROL_TIER;
if (controlTier) { ocrTier(controlTier); assert.ok(variants); }
const rounds = Number(roundsArg); assert.ok(variants ? rounds >= 4 && rounds <= 48 && rounds % 4 === 0 : interleaved ? rounds >= 8 && rounds <= 48 && rounds % 4 === 0 : [1, 3, 7].includes(rounds));
if (variants) {
  assert.ok(!interleaved && !process.env.OCR_BENCH_WINDOWS_SCHEDULE && !process.env.OCR_BENCH_CPU_LOAD);
  assert.equal(variants.length, rounds); assert.equal(new Set(variants).size, 2); assert.ok(variants.includes('control'));
  assert.ok(variants.every(value => ['control', 's8', 'u8', 'conv', 'head', 'cascade'].includes(value)));
  for (let i = 0; i < rounds; i += 4) { assert.equal(variants[i], variants[i + 3]); assert.equal(variants[i + 1], variants[i + 2]); assert.notEqual(variants[i], variants[i + 1]); }
}
if (interleaved) {
  assert.equal(interleaved.length, rounds);
  assert.ok(interleaved.every(n => [0, 2, 4].includes(n)));
  const depths = [...new Set(interleaved)]; assert.equal(depths.length, 2); assert.ok(depths.includes(0));
  for (let i = 0; i < rounds; i += 4) {
    const block = interleaved.slice(i, i + 4); assert.equal(block[0], block[3]); assert.equal(block[1], block[2]); assert.notEqual(block[0], block[1]);
  }
  assert.ok(!process.env.OCR_BENCH_WINDOWS_SCHEDULE && !process.env.OCR_BENCH_CPU_LOAD, 'Do not combine queue comparisons with scheduling/load experiments');
}
const schedule = process.env.OCR_BENCH_WINDOWS_SCHEDULE?.split(',');
if (schedule) { assert.equal(process.platform, 'win32'); assert.equal(schedule.length, rounds); }
const cpuLoad = process.env.OCR_BENCH_CPU_LOAD?.split(',').map(Number);
if (cpuLoad) { assert.equal(process.platform, 'win32'); assert.equal(cpuLoad.length, rounds); assert.ok(cpuLoad.every(n => Number.isInteger(n) && n >= 0 && n <= 4)); }
const cases = casesArg === 'hosted' ? [] : casesArg.split(',').map(key => { const [tier, backend] = key.split(':'); ocrTier(tier); assert.ok(['cpu', 'webgpu', 'auto'].includes(backend)); return { key: key.replace(':', '-'), tier, backend }; });
const manifestPath = resolve(manifestArg), inputs = dirname(manifestPath), output = resolve(outputArg), dist = resolve(owner, 'dist');
const standalonePath = resolve(dist, process.env.OCR_RELEASE_HTML || 'legal-browser-ocr.html');
const hosted = process.env.OCR_BENCH_HOSTED === '1', expectedTiers = Number(process.env.OCR_BENCH_EXPECT_TIERS || 5);
assert.ok([1, 4, 5].includes(expectedTiers));
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
  delivery_path: hosted ? 'loopback HTTP with COOP/COEP' : 'offline file', expected_tiers: expectedTiers,
  input_manifest_sha256: hash(readFileSync(manifestPath)), input_pdf_sha256: hash(readFileSync(pdfPath)),
  standalone: { bytes: statSync(standalonePath).size, sha256: hash(readFileSync(standalonePath)) },
  archive_sha256: hash(readFileSync(resolve(dist, 'legal-browser-ocr-runtime.tar.gz'))), models: {} };
if (interleaved) result.interleaved_queue_order = interleaved;
if (variants) result.interleaved_variants = variants;
if (controlTier) result.control_tier = controlTier;
const save = () => writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
async function ready(page) { await page.waitForFunction(() => /Model (ready|failed)/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 180000 }); assert.match(await page.locator('#status').textContent(), /Model ready/); }
async function upload(page, path) {
  await page.setInputFiles('#file',[]);
  await page.setInputFiles('#file', path);
  await page.waitForFunction(() => /^(Page 1 ready\.|Could not load file:)/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
  const status=await page.locator('#status').textContent();assert.ok(status==='Page 1 ready.',status.slice(0,600));
}
async function recognize(page, {documentLines = Boolean(interleaved || variants)} = {}) {
  const wall_started_ms = Date.now();
  const started = performance.now(); await page.locator('#all').click();
  await page.waitForFunction(() => !document.querySelector('#all').disabled, null, { timeout: 300000 });
  const seconds = (performance.now() - started) / 1000;
  assert.equal(await page.locator('#download').isEnabled(), true, await page.locator('#status').textContent());
  const run = { seconds, wall_started_ms, wall_finished_ms: Date.now(), texts: [await page.locator('#text').textContent(), ...await page.locator('#document .pair pre').allTextContents()],
    stages: await page.evaluate(() => window.legalOcrLastDocumentTimings) };
  if (documentLines) run.lines_sha256 = hash(Buffer.from(JSON.stringify(await page.evaluate(() => window.legalOcrLastDocumentLines))));
  if (variants) run.tier = await page.locator('#mode').inputValue();
  return run;
}
try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  result.browser_version=browser.version();
  const client = await browser.newBrowserCDPSession(); result.browser_gpu = (await client.send('SystemInfo.getInfo')).gpu; await client.detach();
  async function windowsSchedule(policy) {
    const cdp = await browser.newBrowserCDPSession();
    let processes;
    try { processes = (await cdp.send('SystemInfo.getProcessInfo')).processInfo; } finally { await cdp.detach(); }
    return JSON.parse(execFileSync('python', [resolve(root, 'experiments/ocr-candidate-screen/windows_ocr_scheduling.py'),
      '--processes', JSON.stringify(processes), '--saved', resolve(output, 'original-scheduling.json'), '--policy', policy], { encoding: 'utf8' }));
  }
  for (const entry of cases) {
    const context = await browser.newContext({ offline: !hosted, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(entry.key, message.text().slice(0, 500)); });
    const url = hosted ? new URL(`http://127.0.0.1:${server.address().port}/${standalonePath.split(/[\\/]/).at(-1)}`) : pathToFileURL(standalonePath), query=new URLSearchParams(queryArg);
    query.set('backend',entry.backend);query.set('tier',entry.tier);query.set('timing','1');url.search=query.toString();
    const started = performance.now(); await page.goto(url.href); await ready(page);
    const value = { ...entry, query: Object.fromEntries(query), startup_seconds: (performance.now() - started) / 1000, configuration: await page.evaluate(() => window.legalOcrConfiguration()), runs: [] };
    if (entry.backend === 'auto') assert.ok(['wasm', 'webgpu'].includes(value.configuration.backend));
    else assert.equal(value.configuration.backend, entry.backend === 'cpu' ? 'wasm' : 'webgpu');
    assert.equal(await page.locator('#mode').inputValue(), entry.tier);
    assert.equal(await page.locator('#mode option').count(), expectedTiers);
    console.log(`${entry.key}: ready in ${value.startup_seconds.toFixed(2)}s`);
    if(value.configuration.backend==='webgpu')value.requested_webgpu_adapter=await page.evaluate(async()=>{
      const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}),info=adapter?.info;
      return {vendor:info?.vendor,architecture:info?.architecture,device:info?.device,description:info?.description,
        fallback:info?.isFallbackAdapter??adapter?.isFallbackAdapter,jspi:typeof WebAssembly.Suspending};
    });
    await upload(page, pdfPath); value.document_configuration=await page.evaluate(()=>window.legalOcrConfiguration());
    if(value.document_configuration.explicitPdfPort)assert.equal(value.document_configuration.pdfWorkerActive,true);
    const setQueueDepth = depth => page.evaluate(value => { globalThis.legalOcrExperimentalQueueDepth = value; }, depth);
    const setVariant = async variant => {
      const target = variant === 'control' && controlTier ? controlTier : entry.tier;
      assert.equal(ocrTier(target).model, ocrTier(entry.tier).model, 'Tier comparisons must retain the same captured recognizer sessions');
      if (await page.locator('#mode').inputValue() !== target) {
        await page.locator('#mode').selectOption(target);
        await page.waitForFunction(() => !document.querySelector('#mode').disabled);
      }
      await page.evaluate(value => { globalThis.legalOcrExperimentalVariant = value; }, variant);
    };
    const variantReferences = new Map();
    if (interleaved) { assert.equal(value.configuration.backend, 'webgpu'); await setQueueDepth(interleaved[0]); }
    if (variants) { assert.equal(value.configuration.backend, 'webgpu'); await setVariant(variants[0]); }
    const warmup = await recognize(page); value.first_document_seconds = warmup.seconds;
    value.first_document_stages=warmup.stages;
    console.log(`${entry.key}: first document ${(manifest.pages.length / warmup.seconds).toFixed(3)} pages/s`);
    assert.equal(warmup.texts.length, manifest.pages.length);
    if (variants) {
      variantReferences.set(variants[0], warmup); value.variant_warmups = [];
      for (const variant of [...new Set(variants)].reverse()) {
        await setVariant(variant); const run = await recognize(page); run.variant = variant;
        if (variantReferences.has(variant)) {
          assert.deepEqual(run.texts, variantReferences.get(variant).texts); assert.equal(run.lines_sha256, variantReferences.get(variant).lines_sha256);
        }
        variantReferences.set(variant, run); value.variant_warmups.push(run);
      }
      console.log(`${entry.key}: both variants warmed; starting interleaved passes`);
    }
    if (interleaved) {
      value.first_document_queue_depth = interleaved[0]; value.queue_warmups = [];
      for (const depth of [...new Set(interleaved)].reverse()) {
        await setQueueDepth(depth); const run = await recognize(page); run.queue_depth = depth;
        assert.deepEqual(run.texts, warmup.texts); assert.equal(run.lines_sha256, warmup.lines_sha256);
        value.queue_warmups.push(run);
      }
      console.log(`${entry.key}: both queue paths warmed; starting interleaved passes`);
    }
    for (let round = 0; round < rounds; round++) {
      if (interleaved) await setQueueDepth(interleaved[round]);
      if (variants) await setVariant(variants[round]);
      const scheduling = schedule || cpuLoad ? await windowsSchedule(schedule?.[round] || 'inspect') : undefined;
      const loads = Array.from({ length: cpuLoad?.[round] || 0 }, () => spawn('python',
        [resolve(root, 'experiments/ocr-candidate-screen/windows_ocr_scheduling.py'), '--burn'], { stdio: 'ignore' }));
      const exited = loads.map(child => new Promise(resolve => child.once('exit', resolve)));
      let run;
      try {
        if (loads.length) await new Promise(resolve => setTimeout(resolve, 1000));
        run = await recognize(page);
        if (cpuLoad) run.controlled_load = { workers: loads.length, pids: loads.map(child => child.pid) };
      } finally {
        for (const child of loads) child.kill();
        await Promise.all(exited);
      }
      if (scheduling) run.scheduling = scheduling; value.runs.push(run);
      if (variants) {
        run.variant = variants[round]; const expected = variantReferences.get(run.variant);
        assert.equal(run.lines_sha256, expected.lines_sha256, 'Variant line geometry changed between repeated passes');
        const total = key => run.stages.reduce((sum, page) => sum + (page[key] || 0), 0);
        if (variants.some(name => ['s8', 'u8', 'conv'].includes(name))) {
          assert.equal(run.stages.filter(page => page.frontier_detector_variant !== undefined).length, manifest.pages.length);
          assert.equal(total('frontier_detector_variant'), manifest.pages.length * ({control: 0, s8: 1, u8: 2, conv: 3})[run.variant]);
        }
        if (variants.includes('head')) assert.ok(Math.abs(total('frontier_head_batches') - (run.variant === 'head' ? total('model_batches') : 0)) < 1e-5);
        if (variants.includes('cascade')) {
          assert.equal(total('frontier_cascade_lines') > 0, run.variant === 'cascade');
          if (run.variant === 'cascade') assert.ok(total('frontier_teacher_retry_lines') <= total('frontier_cascade_lines'));
        }
      }
      if (interleaved) {
        run.queue_depth = interleaved[round];
        assert.equal(run.lines_sha256, warmup.lines_sha256, 'Positioned lines changed between queue settings');
        const total = key => run.stages.reduce((sum, page) => sum + (page[key] || 0), 0);
        const baseline = key => warmup.stages.reduce((sum, page) => sum + (page[key] || 0), 0);
        for (const key of ['model_batches', 'executed_pixels']) assert.ok(Math.abs(total(key) - baseline(key)) < 1e-5, key + ' changed');
        assert.equal(total('gpu_session_builds'), 0, 'Timed passes must reuse warmed sessions');
        assert.ok(Math.abs(total('experimental_queue_batches') - (run.queue_depth ? total('model_batches') : 0)) < 1e-5, 'Queue path did not match requested mode');
        assert.ok(Math.abs(total('experimental_queue_depth_batches') - run.queue_depth * total('model_batches')) < 1e-5, 'Queue depth did not match requested mode');
      }
      const expectedRun = variants ? variantReferences.get(run.variant) : warmup;
      const changed=run.texts.flatMap((text,index)=>text===expectedRun.texts[index]?[]:[index+1]);
      if(changed.length){
        value.stability={passed:false,changed_pages:changed};value.first_document_texts=warmup.texts;
        result.models[entry.key]=value;save();
      }
      assert.equal(hash(Buffer.from(JSON.stringify(run.texts))),hash(Buffer.from(JSON.stringify(expectedRun.texts))),'OCR changed between warm passes; private receipt retains the affected page numbers');
      if ((interleaved || variants) && (round + 1) % 4 === 0) { result.models[entry.key] = value; save(); }
      console.log(`${entry.key}: round ${round + 1}${interleaved ? ' queue=' + run.queue_depth : variants ? ' variant=' + run.variant : ''}: ${(manifest.pages.length / run.seconds).toFixed(3)} pages/s`);
    }
    if (variants) value.variant_results = Object.fromEntries([...variantReferences].map(([variant, reference]) => {
      const runs = value.runs.filter(run => run.variant === variant), seconds = runs.reduce((sum, run) => sum + run.seconds, 0);
      const edits = reference.texts.reduce((sum, text, i) => sum + distance(manifest.pages[i].gold, normalized(text)), 0);
      const characters = manifest.pages.reduce((sum, page) => sum + Array.from(page.gold).length, 0);
      return [variant, {tier: reference.tier, pages_per_second: manifest.pages.length * runs.length / seconds, edits, characters, cer: edits / characters,
        text_sha256: hash(Buffer.from(JSON.stringify(reference.texts))), lines_sha256: reference.lines_sha256}];
    }));
    value.median_seconds = value.runs.map(run => run.seconds).sort((a, b) => a - b)[Math.floor(rounds / 2)];
    value.pages_per_second = manifest.pages.length / value.median_seconds;
    const exportTexts = variants ? value.runs.at(-1).texts : warmup.texts;
    value.edits = exportTexts.reduce((sum, text, i) => sum + distance(manifest.pages[i].gold, normalized(text)), 0);
    value.characters = manifest.pages.reduce((sum, page) => sum + Array.from(page.gold).length, 0); value.cer = value.edits / value.characters;
    value.text_sha256 = hash(Buffer.from(JSON.stringify(exportTexts)));
    value.lines_sha256 = hash(Buffer.from(JSON.stringify(await page.evaluate(() => window.legalOcrLastDocumentLines))));
    value.final_configuration = await page.evaluate(() => window.legalOcrConfiguration());
    result.models[entry.key]=value;save();
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
        assert.equal(text.replace(/\s/gu, ''), normalized(exportTexts[i]).replace(/\s/gu, ''), entry.key + ': exported text changed on page ' + (i + 1));
      }
      assert.ok((await pixels(exported)).equals(originalPixels), 'Original page pixels changed');
    } finally { await exported.destroy(); }
    value.pdf_gate = { text_pages: manifest.pages.length, first_page_pixels_identical: true, sha256: hash(readFileSync(exportedPath)) };
    save();
    if(value.document_configuration.explicitPdfPort){
      await upload(page,pdfPath);
      assert.equal((await page.evaluate(()=>window.legalOcrConfiguration())).pdfWorkerActive,true);
      value.pdf_gate.reopened_with_module_worker=true;
    }
    assert.deepEqual(errors, []);
    const cpu = result.models[entry.tier + '-cpu'];
    if (value.configuration.backend === 'webgpu' && cpu) assert.ok(value.cer <= cpu.cer + .0005, `${entry.key}: GPU exceeded +0.05 percentage point CER gate`);
    result.models[entry.key] = value; save();
    console.log(`${entry.key}: ${value.pages_per_second.toFixed(3)} pages/s, ${(value.cer * 100).toFixed(3)}% CER; ${hosted ? 'hosted' : 'offline'} and PDF gates passed`);
    await context.close();
  }
  for (const value of Object.values(result.models)) if (value.configuration.backend === 'webgpu') {
    const cpu = result.models[value.tier + '-cpu'];
    if (cpu) assert.ok(value.cer <= cpu.cer + .0005, `${value.key}: GPU exceeded +0.05 percentage point CER gate`);
  }
  result.hosted_png_smoke_skipped=process.env.OCR_BENCH_SKIP_HOSTED==='1';
  result.hosted_png_source={source:'frozen_pdf_first_page',dpi:144,sha256:hash(firstPagePng)};
  result.hosted_png_smoke={};
  save();
  for(const backend of result.hosted_png_smoke_skipped?[]:['cpu','auto']) {
    const context = await browser.newContext({ acceptDownloads: true }); const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/legal-browser-ocr-runtime/index.html?backend=${backend}`); await ready(page);
    await upload(page, {name:'benchmark-page.png',mimeType:'image/png',buffer:firstPagePng});
    result.hosted_png_smoke[backend] = { configuration:await page.evaluate(()=>window.legalOcrConfiguration()), characters: (await recognize(page, {documentLines: false})).texts[0].length };
    for (const tier of ['extreme', 'quality', 'fast', 'turbo', 'balanced']) {
      await page.locator('#mode').selectOption(tier); await page.waitForFunction(() => !document.querySelector('#mode').disabled);
      assert.equal(await page.locator('#download').isEnabled(), false, 'Tier change must invalidate the previous export');
      assert.equal((await page.evaluate(() => window.legalOcrConfiguration())).tier, tier);
      assert.ok((await recognize(page, {documentLines: false})).texts[0].length > 100);
    }
    await page.screenshot({path:resolve(output,`hosted-${backend}.png`)});
    await context.close(); save();
  }
} finally {
  if (browser) await browser.close();
  await original.destroy();
  await new Promise(resolve => server.close(resolve));
}
