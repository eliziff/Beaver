import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve, sep} from 'node:path';
import {cpus} from 'node:os';

const root = resolve(import.meta.dirname, '../..'), owner = resolve(root, 'legal-browser-ocr');
const folder = resolve(root, 'benchmarks/local-data/ocr-candidate-screen/browser/frontier2/cascade-dev');
const inputs = resolve(root, 'benchmarks/local-data/ocr-candidate-screen/speed-frontier/inputs');
const manifest = JSON.parse(readFileSync(resolve(inputs, 'manifest.json'))), gold = JSON.parse(readFileSync(resolve(folder, 'gold.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(gold.manifest_sha256, hash(readFileSync(resolve(inputs, 'manifest.json')))); assert.equal(gold.split, 'development');
const {chromium} = createRequire(resolve(root, 'package.json'))('playwright');
const files = {'/captured.js': 'experiments/ocr-speed/captured-session.js', '/margin.js': 'experiments/ocr-speed/gpu-margin-argmax.js',
  '/policy.js': 'experiments/ocr-speed/cascade-policy.js', '/recognizer.js': 'recognizer.js', '/experiments/ocr-speed/gpu-argmax.js': 'experiments/ocr-speed/gpu-argmax.js',
  '/small.onnx': 'assets/indra-followup/gpu64croph-capture/model.onnx', '/teacher.onnx': 'assets/indra-followup/gpu8croph-capture/model.onnx'};
const codec = JSON.parse(readFileSync(resolve(owner, 'assets/indra-followup/student8cropids/codec.json')));
assert.deepEqual(codec, JSON.parse(readFileSync(resolve(owner, 'assets/indra-followup/student10c64cropids/codec.json'))));
for (const entry of manifest.scales['1']) assert.equal(hash(readFileSync(resolve(inputs, entry.file))), entry.sha256);
const server = createServer((request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (name === '/') { response.writeHead(200, {'Content-Type': 'text/html'}).end('<title>Development recognition cascade</title>'); return; }
    let path = files[name] && resolve(owner, files[name]);
    for (const [prefix, base] of [['/ort/', resolve(owner, 'node_modules/onnxruntime-web/dist')], ['/inputs/', inputs]]) if (name.startsWith(prefix)) {
      path = resolve(base, name.slice(prefix.length)); assert.ok(path.startsWith(base + sep));
    }
    assert.ok(path);
    response.writeHead(200, {'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream'}).end(readFileSync(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, channel: 'chromium'}); const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text().slice(0, 800)); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const measured = await page.evaluate(async ({manifest, gold, codec}) => {
    const ort = await import('/ort/ort.webgpu.min.mjs'), {CapturedSession} = await import('/captured.js');
    const {GpuMarginArgMax} = await import('/margin.js'), {GpuArgMax} = await import('/experiments/ocr-speed/gpu-argmax.js');
    const {decodeClassIds} = await import('/recognizer.js'), {emissionMargins, needsTeacher} = await import('/policy.js');
    ort.env.wasm.numThreads = 1; ort.env.webgpu.powerPreference = 'high-performance';
    ort.env.wasm.wasmPaths = {mjs: '/ort/ort-wasm-simd-threaded.jsep.mjs', wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm'};
    const labels = Object.fromEntries(Object.entries(codec).flatMap(([character, ids]) => ids.map(id => [id, character]))), classes = Math.max(...Object.keys(labels).map(Number)) + 1;
    const create = async name => CapturedSession.create(ort, new Uint8Array(await (await fetch('/' + name + '.onnx')).arrayBuffer()), {}, 16, classes, true, 8);
    const teacher = await create('teacher'), small = await create('small'), device = ort.env.webgpu.device;
    const reduce = new GpuArgMax(device); await reduce.pipeline; const margin = await GpuMarginArgMax.create(device), checks = [];
    try {
      for (const [rows, classes] of [[5, 33], [37, 1679]]) {
        const values = Float32Array.from({length: rows * classes}, (_, index) => (index * 11 % 31 - 15) / 8), ids = [], margins = [];
        for (let row = 0; row < rows; row++) {
          values[row * classes] = 4; if (row % 2) values[row * classes + classes - 1] = 4;
          const scores = Array.from(values.subarray(row * classes, (row + 1) * classes)); let best = 0;
          for (let k = 1; k < classes; k++) if (scores[k] > scores[best]) best = k;
          ids.push(best); margins.push(Math.fround(scores[best] - Math.max(...scores.filter((_, k) => k !== best))));
        }
        const buffer = device.createBuffer({size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}); device.queue.writeBuffer(buffer, 0, values);
        try {
          const actual = await margin.run(ort.Tensor.fromGpuBuffer(buffer, {dataType: 'float32', dims: [rows, classes]}));
          if (actual.ids.some((value, i) => value !== ids[i]) || actual.margins.some((value, i) => value !== margins[i])) throw Error('Top-two margin kernel failed independent numeric check');
          checks.push({rows, classes, exact_ids_and_margins: true});
        } finally { buffer.destroy(); }
      }
      const lines = [];
      for (const entry of manifest.scales['1']) {
        const data = new Float32Array(await (await fetch('/inputs/' + entry.file)).arrayBuffer()), [, , height, width] = entry.dims;
        entry.indices.forEach((index, n) => {
          const actual = entry.widths[n], image = new Float32Array(height * actual);
          for (let y = 0; y < height; y++) image.set(data.subarray((n * height + y) * width, (n * height + y) * width + actual), y * actual);
          lines.push({index, width: actual, image});
        });
      }
      function feeds(selected) {
        const sorted = [...selected].sort((a, b) => a.width - b.width), groups = [];
        for (let offset = 0; offset < sorted.length; offset += 16) {
          const batch = sorted.slice(offset, offset + 16), width = Math.ceil(Math.max(...batch.map(line => line.width)) / 256) * 256;
          const data = new Float32Array(batch.length * 32 * width);
          batch.forEach((line, n) => { for (let y = 0; y < 32; y++) data.set(line.image.subarray(y * line.width, (y + 1) * line.width), (n * 32 + y) * width); });
          groups.push({batch, input: {image: new ort.Tensor('float32', data, [batch.length, 1, 32, width]), widths: new ort.Tensor('int64', BigInt64Array.from(batch, line => BigInt(line.width)), [batch.length])}});
        }
        return groups;
      }
      async function runModel(session, selected, scores) {
        const groups = feeds(selected), result = [];
        try {
          for (const {batch, input} of groups) {
            const out = await session.run(input);
            try {
              const predicted = scores ? await margin.run(out.logits) : {ids: await reduce.run(out.logits)}, steps = out.logits.dims[1];
              batch.forEach((line, n) => {
                const length = Number(out.lengths.data[n]);
                result.push({index: line.index, width: line.width, text: decodeClassIds({data: predicted.ids, dims: [batch.length, steps]}, n, length, labels).text,
                  ...(scores && emissionMargins(predicted.ids, predicted.margins, n * steps, length))});
              });
            } finally { Object.values(out).forEach(value => value.dispose()); }
          }
        } finally { for (const {input} of groups) Object.values(input).forEach(value => value.dispose()); }
        return result;
      }
      const normalize = value => value.replace(/[\u00ad\u00ac]\r?\n/g, '').normalize('NFKC').replace(/[\u00ad\u00ac]/g, '').replace(/\s+/gu, ' ').trim();
      function distance(a, b) {
        a = Array.from(a); b = Array.from(b); const row = Array.from({length: b.length + 1}, (_, i) => i);
        for (let i = 0; i < a.length; i++) { let previous = row[0]; row[0] = i + 1; for (let j = 0; j < b.length; j++) { const old = row[j + 1]; row[j + 1] = Math.min(old + 1, row[j] + 1, previous + Number(a[i] !== b[j])); previous = old; } }
        return row[b.length];
      }
      const a = (await runModel(small, lines, true)).sort((a, b) => a.index - b.index), b = (await runModel(teacher, lines, false)).sort((a, b) => a.index - b.index);
      const rows = a.map((line, index) => ({...line, gold: gold.gold[index], small_edits: distance(normalize(line.text), gold.gold[index]),
        teacher_text: b[index].text, teacher_edits: distance(normalize(b[index].text), gold.gold[index]), characters: Array.from(gold.gold[index]).length}));
      const characters = rows.reduce((sum, row) => sum + row.characters, 0), teacherEdits = rows.reduce((sum, row) => sum + row.teacher_edits, 0);
      const work = selected => {
        const sorted = [...selected].sort((a, b) => a.width - b.width); let pixels = 0;
        for (let i = 0; i < sorted.length; i += 16) pixels += Math.ceil(sorted[Math.min(i + 15, sorted.length - 1)].width / 256) * 256 * 16 * 32;
        return pixels;
      };
      const curve = [];
      for (const metric of ['mean', 'minimum', 'lowerQuartile']) {
        const ordered = rows.map(row => row[metric]).sort((a, b) => a - b);
        const thresholds = [...new Set([0, ...Array.from({length: 17}, (_, i) => ordered[Math.floor(i * (ordered.length - 1) / 16)]), ordered.at(-1) + 1])];
        for (const threshold of thresholds) {
          const policy = {metric, threshold}, selected = rows.filter(row => needsTeacher(row, policy));
          const edits = rows.reduce((sum, row) => sum + (needsTeacher(row, policy) ? row.teacher_edits : row.small_edits), 0);
          curve.push({...policy, retry_lines: selected.length, retry_pixels: work(selected), edits, cer: edits / characters});
        }
      }
      const selected = Object.fromEntries([['accurate', .001], ['fast', .005]].map(([name, allowance]) => {
        const choices = curve.filter(row => row.cer <= teacherEdits / characters + allowance).sort((a, b) => a.retry_pixels - b.retry_pixels || a.edits - b.edits);
        return [name, {...choices[0], development_cer_allowance: allowance}];
      }));
      async function route(name) {
        if (name === 'control') return runModel(teacher, lines, false);
        const predictions = await runModel(small, lines, true), retry = predictions.filter(row => needsTeacher(row, selected[name]));
        const indices = new Set(retry.map(row => row.index)), rerun = await runModel(teacher, lines.filter(line => indices.has(line.index)), false);
        const replacements = new Map(rerun.map(row => [row.index, row]));
        return predictions.map(row => replacements.get(row.index) || row);
      }
      for (const name of ['control', 'accurate', 'fast']) await route(name);
      const runs = [];
      for (let repeat = 0; repeat < 2; repeat++) for (const name of repeat ? ['accurate', 'control', 'control', 'accurate', 'control', 'fast', 'fast', 'control'] : ['control', 'accurate', 'accurate', 'control', 'fast', 'control', 'control', 'fast']) {
        const builds = small.createdSlots + teacher.createdSlots, started = performance.now(), actual = await route(name), seconds = (performance.now() - started) / 1000;
        const edits = actual.reduce((sum, line) => sum + distance(normalize(line.text), gold.gold[line.index]), 0);
        if (edits !== (name === 'control' ? teacherEdits : selected[name].edits)) throw Error('Cascade predictions changed after calibration');
        runs.push({name, seconds, edits, gpu_session_builds: small.createdSlots + teacher.createdSlots - builds});
      }
      return {checks, characters, teacher_cer: teacherEdits / characters, small_cer: rows.reduce((sum, row) => sum + row.small_edits, 0) / characters,
        small_full_pass_pixels: work(rows), selected, curve, rows, runs};
    } finally { await small.release(); await teacher.release(); }
  }, {manifest, gold, codec});
  assert.deepEqual(errors, []);
  const result = {origin: 'machine_test', run_id: randomUUID(), hardware: {cpu: cpus()[0].model, logical_cpus: cpus().length}, browser_version: browser.version(),
    scope: 'Development-only 128-line prepared-tensor cascade; includes small model, gate, selected teacher retries, input packing/upload and decoding; no page-speed claim',
    gold_sha256: hash(readFileSync(resolve(folder, 'gold.json'))), files: Object.fromEntries(Object.entries(files).map(([name, path]) => [name, hash(readFileSync(resolve(owner, path)))])), ...measured};
  mkdirSync(folder, {recursive: true}); writeFileSync(resolve(folder, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({checks: measured.checks.length, characters: measured.characters, teacher_cer: measured.teacher_cer, small_cer: measured.small_cer, selected: measured.selected,
    mean_seconds: Object.fromEntries(['control', 'accurate', 'fast'].map(name => { const rows = measured.runs.filter(run => run.name === name); return [name, rows.reduce((sum, row) => sum + row.seconds, 0) / rows.length]; }))}));
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
