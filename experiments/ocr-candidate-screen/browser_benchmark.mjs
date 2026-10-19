import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, freemem, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const browserRoot = resolve(root, 'legal-browser-ocr');
const { chromium } = createRequire(resolve(root, 'package.json'))('playwright');
const { PDFDocument } = createRequire(resolve(browserRoot, 'package.json'))('pdf-lib');
const [manifestArg, outputArg, modelArg = 'kraken,crnn,indra', modeArg = '1', queryArg = '', deployment = 'hosted', roundsArg = '3'] = process.argv.slice(2);
if (!manifestArg || !outputArg) throw new Error('usage: node browser_benchmark.mjs INPUT_MANIFEST OUTPUT_DIR [kraken,crnn,indra] [1|.85|.76|.7] [URL_QUERY] [hosted|standalone] [3|7]');
const rounds = Number(roundsArg);
assert.ok([3, 7].includes(rounds));
assert.ok(['1', '.85', '.76', '.7'].includes(modeArg));
assert.ok(['hosted', 'standalone'].includes(deployment));
const query = new URLSearchParams(queryArg); query.set('timing', '1');
const packageVariant=query.get('package')||'';
const pack=query.get('pack');
const kernels=query.get('kernels');
const noPreviewsPackage=query.get('noPreviewsPackage')==='1';
const noPreviews=query.get('preview')==='none'||(!query.has('preview')&&noPreviewsPackage);
assert.ok(!kernels||['profiling','sgemm','xnnpack','tiles','fma','depthwise','fmadw','sgemm4dw'].includes(kernels));
assert.ok(!kernels||!packageVariant.includes('reduced'));
assert.ok(!kernels||!modelArg.split(',').includes('kraken'));
assert.ok(!pack||(/^[a-z0-9]+$/.test(pack)&&modelArg==='indra'&&!packageVariant.endsWith('-speed')));
assert.ok(['','reduced','detectors','reduced-detectors','reduced-detectors-speed'].includes(packageVariant));
assert.ok(!packageVariant.endsWith('-speed')||modelArg==='indra');
const manifestPath = resolve(manifestArg), inputRoot = dirname(manifestPath), output = resolve(outputArg);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = value => value.replace(/[\u00ad\u00ac]\r?\n/g, '').normalize('NFKC').replace(/[\u00ad\u00ac]/g, '').replace(/\s+/gu, ' ').trim();
function distance(a, b) {
  a = Array.from(a); b = Array.from(b);
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let previous = row[0]; row[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const old = row[j + 1];
      row[j + 1] = Math.min(row[j + 1] + 1, row[j] + 1, previous + Number(a[i] !== b[j])); previous = old;
    }
  }
  return row[b.length];
}
mkdirSync(output, { recursive: true });
const pdf = await PDFDocument.create();
for (const entry of manifest.pages) {
  const png = readFileSync(resolve(inputRoot, entry.png));
  assert.equal(hash(png), entry.png_sha256);
  assert.equal(hash(readFileSync(resolve(inputRoot, entry.xml))), entry.xml_sha256);
  const image = await pdf.embedPng(png), width = image.width * 72 / 200, height = image.height * 72 / 200;
  pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
}
pdf.setCreationDate(new Date('2000-01-01T00:00:00Z'));
pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));
const pdfPath = resolve(inputRoot, 'input.pdf');
writeFileSync(pdfPath, await pdf.save());
const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json', '.onnx': 'application/octet-stream', '.ort': 'application/octet-stream' };
const dist = resolve(browserRoot, 'dist');
const server = createServer((request, response) => {
  try {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (!path.startsWith(dist + sep)) { response.writeHead(403).end(); return; }
    const bytes = readFileSync(path);
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(query.get('browser') === 'chromium' && { channel: 'chromium' }) });
const result = { input_manifest_sha256: hash(readFileSync(manifestPath)), input_pdf_sha256: hash(readFileSync(pdfPath)),
  source_sha256:Object.fromEntries(['app.js','recognition-worker.js','recognizer.js','tesseract-layout.js','experiments/ocr-speed/preview.js','experiments/ocr-speed/session-options.js','experiments/ocr-speed/detector-worker.js','experiments/ocr-speed/detector-post.js'].map(name=>[name,hash(readFileSync(resolve(browserRoot,name)))])),
  hardware: { cpu: cpus()[0].model, logical_cpus: cpus().length, memory_bytes: totalmem() },
  protocol: { origin: 'machine_test', run_id: randomUUID(), deployment, pages: manifest.pages.length, rounds, pdf_render_dpi: 144, recognition_width_scale: Number(modeArg), query: Object.fromEntries(query), scope: 'real Recognize document button: PDF rendering, previews, layout, worker recognition, text assembly and UI; first-page preview is opened before timing; startup, file opening, first document and searchable-PDF export reported separately', warmup: 'one full document pass', model_order: modelArg.split(',') }, models: {} };
const save = () => writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
async function browserWorkingSet() {
  if (process.platform !== 'win32') return { unavailable: 'Windows process working-set sampling only' };
  const client = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await client.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map(info => Number(info.id)).filter(id => Number.isSafeInteger(id) && id > 0);
    assert.ok(ids.length);
    const sample = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object Count,Sum | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
    return { processes: sample.Count, bytes: sample.Sum, scope: 'sum of this Chromium instance process working sets; shared pages may be counted more than once; snapshot, not peak' };
  } catch (error) { return { unavailable: error.message }; }
  finally { await client.detach(); }
}
async function backgroundSnapshot() {
  const sum = () => cpus().reduce((value, cpu) => ({ idle: value.idle + cpu.times.idle, total: value.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
  const before = sum(); await new Promise(resolve => setTimeout(resolve, 1000)); const after = sum();
  return { available_memory_bytes: freemem(), cpu_busy_percent: 100 * (1 - (after.idle - before.idle) / (after.total - before.total)) };
}
async function ready(page) {
  await page.waitForFunction(() => /Model (ready|failed)/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 180000 });
  assert.match(await page.locator('#status').textContent(), /Model ready/);
}
async function upload(page, path) {
  await page.setInputFiles('#file', path);
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Page 1 ready.', null, { timeout: 120000 });
}
async function recognize(page) {
  const started = performance.now();
  await page.locator('#all').click();
  await page.waitForFunction(() => !document.querySelector('#all').disabled, null, { timeout: 300000 });
  const seconds = (performance.now() - started) / 1000;
  assert.equal(await page.locator('#download').isEnabled(), true, await page.locator('#status').textContent());
  const texts = [await page.locator('#text').textContent(), ...await page.locator('#document .pair pre').allTextContents()];
  return { seconds, texts, stages: await page.evaluate(() => window.krakenLiteLastDocumentTimings || null) };
}
try {
  for (const id of modelArg.split(',')) {
    assert.ok(['kraken', 'crnn', 'indra'].includes(id));
    const suffix = (id === 'kraken' ? '' : `-${id}`)+(packageVariant?`-${packageVariant}`:'')+(pack?'-'+pack:'')+(kernels?'-'+kernels:'')+(noPreviewsPackage?'-no-previews':''), packageName = `legal-browser-ocr${suffix}-runtime`;
    const context = await browser.newContext({ offline: deployment === 'standalone', acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const background = await backgroundSnapshot();
    const started = performance.now();
    const target=deployment==='standalone'?pathToFileURL(resolve(dist,`legal-browser-ocr${suffix}.html`)):new URL(`${origin}/${packageName}/index.html`);target.search=query.toString();
    await page.goto(target.href); await ready(page);
    await page.locator('#mode').selectOption(modeArg);
    const entry = { startup_seconds: (performance.now() - started) / 1000, background_before: background,
      browser: await page.evaluate(() => ({ user_agent: navigator.userAgent, logical_cpus: navigator.hardwareConcurrency, isolated: crossOriginIsolated })),
      model_sha256: hash(readFileSync(resolve(browserRoot, pack?`assets/indra-followup/${pack}/model.onnx`:id === 'kraken' ? 'assets/model.ort' : `assets/${id}${packageVariant.endsWith('-speed')?'-speed':''}/model.onnx`))),
      archive_bytes: statSync(resolve(dist, `${packageName}.tar.gz`)).size,
      standalone_bytes: statSync(resolve(dist, `legal-browser-ocr${suffix}.html`)).size };
    entry.standalone_sha256=hash(readFileSync(resolve(dist,`legal-browser-ocr${suffix}.html`)));
    entry.wasm_sha256=hash(readFileSync(resolve(browserRoot,kernels?`assets/indra-kernels/${kernels}/ort-wasm-simd-threaded.wasm`:packageVariant.includes('reduced')?'assets/reduced/ort-wasm-simd-threaded.wasm':id==='kraken'?'assets/ort.wasm':'dist/ort-wasm-simd-threaded.wasm')));
    console.log(`${id}: ready in ${entry.startup_seconds.toFixed(2)}s`);
    const openStarted=performance.now();
    await upload(page, pdfPath);
    entry.open_pdf_seconds=(performance.now()-openStarted)/1000;
    const warmup = await recognize(page);
    entry.first_document_seconds=warmup.seconds;
    entry.working_set_after_warmup=await browserWorkingSet();
    assert.equal(warmup.texts.length, manifest.pages.length);
    entry.runs = [];
    for (let round = 0; round < rounds; round++) {
      const run = await recognize(page);
      assert.equal(run.texts.length, manifest.pages.length);
      assert.deepEqual(run.texts, warmup.texts, 'recognition must remain stable across document passes');
      entry.runs.push(run);
      console.log(`${id}: round ${round + 1}: ${run.seconds.toFixed(2)}s (${(manifest.pages.length / run.seconds).toFixed(2)} pages/s)`);
    }
    entry.median_seconds = entry.runs.map(run => run.seconds).sort((a, b) => a - b)[Math.floor(rounds / 2)];
    entry.pages_per_second = manifest.pages.length / entry.median_seconds;
    entry.edits = warmup.texts.reduce((sum, text, i) => sum + distance(manifest.pages[i].gold, normalized(text)), 0);
    entry.characters = manifest.pages.reduce((sum, page) => sum + Array.from(page.gold).length, 0);
    entry.cer = entry.edits / entry.characters;
    entry.working_set_after_rounds=await browserWorkingSet();
    entry.layout_lines = await page.evaluate(() => window.krakenLiteLastDocumentLines);
    await page.waitForFunction(() => [...document.querySelectorAll('#document img')].every(img => img.complete && img.naturalWidth > 0));
    entry.previews = await page.locator('#document img').evaluateAll(images => images.map(img => ({ width: img.naturalWidth, height: img.naturalHeight })));
    assert.equal(entry.previews.length,noPreviews?0:manifest.pages.length-1,'document preview count');
    if (query.get('preview') === 'thumbnail') assert.ok(entry.previews.every(image => image.width <= 640));
    await page.screenshot({ path: resolve(output, `${id}.png`) });
    const exportStarted = performance.now(), downloadPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    const download = await downloadPromise;
    await download.saveAs(resolve(output, `${id}-searchable.pdf`));
    entry.export_seconds = (performance.now() - exportStarted) / 1000;
    const exported = await PDFDocument.load(readFileSync(resolve(output, `${id}-searchable.pdf`)));
    assert.equal(exported.getPageCount(), manifest.pages.length);
    // Compare the same first page through the production worker and main-thread paths.
    await upload(page, resolve(inputRoot, manifest.pages[0].png));
    entry.path_parity = await page.evaluate(async () => {
      const worker = await window.krakenLiteRecognizePage();
      const prepared = await window.krakenLitePreparePages([document.querySelector('#page')]);
      const main = await window.krakenLiteRecognizePreparedPages(prepared);
      const {text,...timing}=worker;
      return { equal: worker.text === main.pages[0].text, worker_characters: worker.text.length, main_characters: main.pages[0].text.length, serial_png_timing:timing };
    });
    assert.ok(entry.path_parity.equal, JSON.stringify(entry.path_parity));
    if(query.get('workerSmoke')==='1'){
      entry.shared_worker_regression={};
      for(const profile of ['kraken','crnn']){
        const model=readFileSync(resolve(browserRoot,profile==='kraken'?'assets/model.ort':`assets/${profile}/model.onnx`));
        const codec=JSON.parse(readFileSync(resolve(browserRoot,profile==='kraken'?'assets/codec.json':`assets/${profile}/codec.json`),'utf8'));
        const value=await page.evaluate(async({profile,model,codec})=>{
          const assets=globalThis.LEGAL_OCR_ASSETS,bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
          const url=URL.createObjectURL(new Blob([bytes(assets.recognitionWorker)],{type:'application/javascript'}));
          const worker=new Worker(url);
          const request=(data,transfer=[])=>new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error('Shared worker regression timed out')),60000);
            worker.onmessage=({data})=>{clearTimeout(timer);data.type==='error'?reject(new Error(data.message)):resolve(data)};
            worker.onerror=error=>{clearTimeout(timer);reject(new Error(error.message))};
            worker.postMessage(data,transfer);
          });
          try{
            await request({type:'init',runtimeMjs:`data:application/javascript;base64,${assets.ortMjs}`,runtimeWasm:`data:application/wasm;base64,${assets.ortWasm}`,
              model:bytes(model),codec,recognizer:profile,batchSize:profile==='kraken'?32:16,bucketSize:24,padding:16,sessionOptions:{graphOptimizationLevel:'all'}});
            const canvas=document.querySelector('#page'),prepared=await window.krakenLitePreparePages([canvas]);
            const lines=prepared.lines.map(({x,y,width,height})=>({x,y,width,height})),bitmap=await createImageBitmap(canvas);
            const result=await request({type:'recognize',scale:1,pages:[{bitmap,lines}]},[bitmap]);
            return {text:result.pages[0].text,lines:result.pages[0].lines.length,expected_lines:lines.length};
          }finally{worker.terminate();URL.revokeObjectURL(url)}
        },{profile,model:model.toString('base64'),codec});
        const cer=distance(manifest.pages[0].gold,normalized(value.text))/Array.from(manifest.pages[0].gold).length;
        assert.equal(value.lines,value.expected_lines);
        assert.ok(value.text.length>100&&cer<.15,profile+': shared worker recognition regressed');
        entry.shared_worker_regression[profile]={lines:value.lines,characters:value.text.length,cer,model_sha256:hash(model)};
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
    // A packaged HTML file must also work offline when opened directly from disk.
    const offline = await browser.newContext({ offline: true, acceptDownloads: true });
    const standalone = await offline.newPage();
    const standaloneUrl=pathToFileURL(resolve(dist, `legal-browser-ocr${suffix}.html`));standaloneUrl.search=query.toString();
    await standalone.goto(standaloneUrl.href); await ready(standalone);
    await standalone.locator('#mode').selectOption(modeArg);
    await upload(standalone, resolve(inputRoot, manifest.pages[0].png));
    const smoke = await recognize(standalone);
    assert.equal(smoke.texts.length, 1); assert.ok(smoke.texts[0].length > 100);
    entry.offline_standalone = { png_characters: smoke.texts[0].length, png_seconds: smoke.seconds };
    await offline.close();
    result.models[id] = entry; save();
    console.log(`${id}: CER ${(entry.cer * 100).toFixed(3)}%; packaged and offline checks passed`);
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
