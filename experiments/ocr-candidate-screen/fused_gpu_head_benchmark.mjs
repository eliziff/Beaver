import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve, sep} from 'node:path';
import {cpus} from 'node:os';

const root = resolve(import.meta.dirname, '../..'), owner = resolve(root, 'legal-browser-ocr');
const output = resolve(process.argv[2] || 'benchmarks/local-data/ocr-candidate-screen/browser/frontier2/fused-head/latest');
assert.ok(process.argv[3] === undefined || ['reuse', 'packed', 'captured'].includes(process.argv[3]));
assert.ok(process.argv[4] === undefined || process.argv[4] === 'reverse');
const reuseComparison = process.argv[3] === 'reuse', capturedComparison = process.argv[3] === 'captured', packedComparison = ['packed', 'captured'].includes(process.argv[3]), reverse = process.argv[4] === 'reverse';
const inputRoot = resolve(root, 'benchmarks/local-data/ocr-candidate-screen/speed-frontier/inputs');
const manifest = JSON.parse(readFileSync(resolve(inputRoot, 'manifest.json')));
const {chromium} = createRequire(resolve(root, 'package.json'))('playwright');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runId = randomUUID();
const models = {standard: 'gpu8croph', light: 'gpu64croph'};
const files = {'/kernel.js': resolve(owner, 'experiments/ocr-speed/fused-gpu-head.js'), '/argmax.js': resolve(owner, 'experiments/ocr-speed/gpu-argmax.js')};
if (capturedComparison) Object.assign(files, {'/captured-session.js': resolve(owner, 'experiments/ocr-speed/captured-session.js'),
  '/feature-session.js': resolve(owner, 'experiments/ocr-speed/feature-session.js'), '/captured-trials.mjs': resolve(root, 'experiments/ocr-candidate-screen/captured_head_trials.mjs')});
for (const [kind, name] of Object.entries(models)) for (const [key, path] of Object.entries({model: `${name}-capture/model.onnx`, features: `${name}-features/model.onnx`, classifier: `${name}-features/classifier.onnx`, head: `${name}-features/head.bin`})) {
  files[`/${kind}/${key}`] = resolve(owner, 'assets/indra-followup', path);
}
for (const entry of manifest.scales['1']) assert.equal(hash(readFileSync(resolve(inputRoot, entry.file))), entry.sha256);
const server = createServer((request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (name === '/') { response.writeHead(200, {'Content-Type': 'text/html'}).end('<title>Classifier fusion measurement</title>'); return; }
    let path = files[name];
    for (const [prefix, base] of [['/ort/', resolve(owner, 'node_modules/onnxruntime-web/dist')], ['/inputs/', inputRoot]]) if (name.startsWith(prefix)) {
      path = resolve(base, name.slice(prefix.length)); assert.ok(path.startsWith(base + sep));
    }
    assert.ok(path);
    response.writeHead(200, {'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(path) ? 'text/javascript' : 'application/octet-stream'}).end(readFileSync(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, channel: 'chromium'});
  const page = await browser.newPage(), errors = [];
  if (capturedComparison) {
    mkdirSync(output, {recursive: true});
    await page.exposeFunction('recordCapturedTrial', checkpoint => writeFileSync(resolve(output, 'checkpoint.json'), JSON.stringify({origin: 'machine_test', run_id: runId,
      status: 'partial', starting_order_reversed: reverse, browser_version: browser.version(), input_manifest_sha256: hash(readFileSync(resolve(inputRoot, 'manifest.json'))), ...checkpoint}, null, 2) + '\n'));
  }
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text().slice(0, 1000)); else if (message.text().startsWith('captured:')) console.log(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const measured = await page.evaluate(async ({manifest, reuseComparison, packedComparison, capturedComparison, reverse}) => {
    const ort = await import('/ort/ort.webgpu.min.mjs'), {FusedGpuHead} = await import('/kernel.js'), {GpuArgMax} = await import('/argmax.js');
    ort.env.wasm.numThreads = 1; ort.env.webgpu.powerPreference = 'high-performance';
    ort.env.wasm.wasmPaths = {mjs: '/ort/ort-wasm-simd-threaded.jsep.mjs', wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm'};
    const sessions = [], heads = [], checks = [], measurements = {};
    const create = async (path, key) => {
      const session = await ort.InferenceSession.create(path, {executionProviders: ['webgpu'], preferredOutputLocation: {[key]: 'gpu-buffer'}});
      sessions.push(session); return session;
    };
    try {
      const original = await create('/standard/model', 'logits'), device = ort.env.webgpu.device;
      const argmax = new GpuArgMax(device); await argmax.pipeline;
      for (const [channels, classes, steps, batches, tie] of [[64, 11, 1, 1, false], [128, 11, 19, 2, false], [64, 1679, 32, 1, false], [128, 1679, 19, 2, true]]) {
        const binary = new ArrayBuffer(16 + (channels + 1) * classes * 4);
        new Uint32Array(binary, 0, 4).set([channels, classes, 1, 0]);
        const weights = new Float32Array(binary, 16, channels * classes), biases = new Float32Array(binary, 16 + channels * classes * 4);
        weights.forEach((_, index) => { weights[index] = tie ? 0 : ((index * 3 % 5) - 2) / 8; });
        biases.forEach((_, index) => { biases[index] = tie ? 0 : index % 3 / 16; });
        const values = Float32Array.from({length: batches * channels * steps}, (_, index) => ((index * 7 % 5) - 2) / 8);
        const expected = [], margins = [];
        for (let n = 0; n < batches; n++) for (let t = 0; t < steps; t++) {
          const scores = Array.from({length: classes}, (_, k) => {
            let score = 0;
            for (let c = 0; c < channels; c++) score = Math.fround(score + Math.fround(values[(n * channels + c) * steps + t] * weights[c * classes + k]));
            return Math.fround(score + biases[k]);
          });
          let best = 0;
          for (let k = 1; k < classes; k++) if (scores[k] > scores[best]) best = k;
          expected.push(best); margins.push(scores[best] - Math.max(...scores.filter((_, k) => k !== best)));
        }
        const buffer = device.createBuffer({size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}); device.queue.writeBuffer(buffer, 0, values);
        const tensor = ort.Tensor.fromGpuBuffer(buffer, {dataType: 'float32', dims: [batches, channels, 1, steps]});
        try {
          for (const include of [false, true]) for (const reuseBuffers of [false, true]) for (const packedWeights of packedComparison ? [false, true] : [false]) {
            const head = await FusedGpuHead.create(device, binary, {margins: include, reuseBuffers, packedWeights});
            try {
              const verify = (actual, count) => {
                if (actual.ids.length !== count * steps || actual.ids.some((value, i) => value !== expected[i])) throw Error(`Independent IDs differ: ${channels},${classes},${steps},${batches},${include}`);
                if (include && actual.margins.some((value, i) => value !== margins[i])) throw Error('Independent top-two margins differ');
              };
              for (const count of reuseBuffers ? [1, batches, 1, batches] : [batches]) verify(await head.run(tensor, count), count);
              if (reuseBuffers) {
                const concurrent = await Promise.all([head.run(tensor), head.run(tensor, 1)]);
                verify(concurrent[0], batches); verify(concurrent[1], 1);
              }
              checks.push({channels, classes, steps, batches, ties: tie, margins: include, reuse_buffers: reuseBuffers, packed_weights: packedWeights, concurrent: reuseBuffers, exact: true});
            } finally { head.release(); }
          }
        } finally { buffer.destroy(); }
      }
      if (capturedComparison) {
        await original.release(); sessions.pop();
        const [{CapturedSession}, {FeatureSession}, {capturedHeadTrials}] = await Promise.all([
          import('/captured-session.js'), import('/feature-session.js'), import('/captured-trials.mjs')]);
        return {checks, measurements: await capturedHeadTrials({ort, manifest, reverse, CapturedSession, FeatureSession, FusedGpuHead, GpuArgMax})};
      }
      const inputs = [];
      for (const entry of manifest.scales['1']) {
        const image = new ort.Tensor('float32', new Float32Array(await (await fetch('/inputs/' + entry.file)).arrayBuffer()), entry.dims);
        const steps = Math.ceil(entry.dims[3] / 4), mask = new Float32Array(entry.dims[0] * steps);
        entry.widths.forEach((width, n) => mask.fill(1, n * steps, n * steps + Math.ceil(width / 4)));
        inputs.push({image, mask: new ort.Tensor('float32', mask, [entry.dims[0], 1, 1, steps])});
      }
      for (const kind of ['standard', 'light']) {
        const baseline = kind === 'standard' ? original : await create(`/${kind}/model`, 'logits');
        const features = await create(`/${kind}/features`, 'features');
        const classifier = await create(`/${kind}/classifier`, 'logits');
        const binary = await (await fetch(`/${kind}/head`)).arrayBuffer(), head = await FusedGpuHead.create(device, binary); heads.push(head);
        const packedHead = packedComparison ? await FusedGpuHead.create(device, binary, {packedWeights: true}) : undefined;
        if (packedHead) heads.push(packedHead);
        async function run(mode, feeds, inspect = false) {
          const fused = mode !== 'control'; head.reuseBuffers = mode === 'reused';
          const out = await (fused ? features : baseline).run(feeds);
          try {
            const ids = fused ? (await (mode === 'packed' ? packedHead : head).run(out.features)).ids : await argmax.run(out.logits);
            return inspect ? ids : undefined;
          } finally { Object.values(out).forEach(value => value.dispose()); }
        }
        let changed = 0, headChanged = 0, featureChanged = 0, packedChanged = 0, count = 0;
        for (const feed of inputs) {
          const a = await run('control', feed, true), feature = await features.run(feed);
          let logits;
          try {
            head.reuseBuffers = false;
            const b = (await head.run(feature.features)).ids;
            head.reuseBuffers = true;
            const reused = (await head.run(feature.features)).ids;
            if (reused.length !== b.length || reused.some((value, i) => value !== b[i])) throw Error('Buffer reuse changed classifier IDs');
            if (packedHead) {
              const packed = (await packedHead.run(feature.features)).ids;
              if (packed.length !== b.length) throw Error('Packed classifier output dimensions differ');
              packedChanged += packed.reduce((sum, value, i) => sum + Number(value !== b[i]), 0);
            }
            logits = await classifier.run({features: feature.features});
            const c = await argmax.run(logits.logits);
            if (a.length !== b.length || b.length !== c.length) throw Error('Classifier output dimensions differ');
            changed += a.reduce((sum, value, i) => sum + Number(value !== b[i]), 0);
            headChanged += c.reduce((sum, value, i) => sum + Number(value !== b[i]), 0);
            featureChanged += a.reduce((sum, value, i) => sum + Number(value !== c[i]), 0); count += a.length;
          } finally { Object.values(feature).forEach(value => value.dispose()); Object.values(logits || {}).forEach(value => value.dispose()); }
        }
        const modes = reuseComparison ? ['fresh', 'reused'] : packedComparison ? ['fresh', 'packed'] : ['control', 'fused'];
        const seconds = Object.fromEntries(modes.map(mode => [mode, []])), sample = inputs, passes = [], blockRatios = [];
        for (const mode of modes) for (const feed of sample) await run(mode, feed);
        for (let block = 0; block < 4; block++) {
          const [a, b] = modes, order = (block + Number(reverse)) % 2 ? [b, a, a, b] : [a, b, b, a];
          const sums = {[a]: 0, [b]: 0};
          for (const mode of order) {
            const activeHead = mode === 'packed' ? packedHead : head;
            const allocations = activeHead.workspaceAllocations, started = performance.now();
            for (const feed of sample) await run(mode, feed);
            const elapsed = (performance.now() - started) / 1000, newWorkspaces = activeHead.workspaceAllocations - allocations;
            if (mode === 'reused' && newWorkspaces) throw Error('Warmed buffer reuse allocated another workspace');
            seconds[mode].push(elapsed); sums[mode] += elapsed;
            passes.push({mode, seconds: elapsed, workspace_allocations: newWorkspaces});
          }
          blockRatios.push(sums[a] / sums[b]);
        }
        measurements[kind] = {changed_ids: changed, same_features_head_changed_ids: headChanged, separated_model_changed_ids: featureChanged,
          reuse_changed_ids: 0, ...(packedHead && {packed_changed_ids: packedChanged, original_weight_bytes: head.weight.size, packed_weight_bytes: packedHead.weight.size}),
          total_ids: count, samples: inputs.length, timed_batches_per_pass: sample.length, seconds, passes,
          matched_geometric_ratio: Math.exp(blockRatios.reduce((sum, value) => sum + Math.log(value), 0) / blockRatios.length),
          block_ratios: blockRatios, retained_workspace_bytes: head.workspace?.buffers.reduce((sum, buffer) => sum + buffer.size, 0) || 0};
      }
      for (const feed of inputs) Object.values(feed).forEach(value => value.dispose());
      return {checks, measurements};
    } finally { heads.forEach(head => head.release()); for (const session of sessions) await session.release(); }
  }, {manifest, reuseComparison, packedComparison, capturedComparison, reverse});
  assert.deepEqual(errors, []);
  const result = {origin: 'machine_test', run_id: runId, scope: capturedComparison ? 'Captured sixteen-line GPU batches; reuse/packing factorial, tails, padded-width and cache-pressure workloads; not pages/s' : reuseComparison ? 'Prepared development tensors; identical feature graph and classifier with fresh versus reused workspaces; not pages/s' : packedComparison ? 'Prepared development tensors; identical feature graph and FP32 classifier arithmetic with unpacked versus packed FP16 weights; not pages/s' : 'Prepared development tensors; full original graph versus feature graph plus fused classifier/ArgMax; not pages/s',
    buffer_reuse_comparison: reuseComparison, packed_weight_comparison: packedComparison, captured_comparison: capturedComparison, starting_order_reversed: reverse,
    hardware: {cpu: cpus()[0].model, logical_cpus: cpus().length}, browser_version: browser.version(), input_manifest_sha256: hash(readFileSync(resolve(inputRoot, 'manifest.json'))),
    files: Object.fromEntries(Object.entries(files).map(([name, path]) => [name, hash(readFileSync(path))])), ...measured};
  mkdirSync(output, {recursive: true}); writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  if (capturedComparison) console.log(JSON.stringify({checks: measured.checks.length, measurements: Object.fromEntries(Object.entries(measured.measurements).map(([name, value]) => [name,
    {pairs: value.pairs, pressure_ratio: value.pressure_ratio, steady_owned_buffers: value.steady_owned_buffers, pressure_owned_buffers: value.pressure_owned_buffers}]))}));
  else console.log(JSON.stringify({checks: measured.checks.length, measurements: Object.fromEntries(Object.entries(measured.measurements).map(([name, value]) => [name,
    {changed_ids: value.changed_ids, reuse_changed_ids: value.reuse_changed_ids, packed_changed_ids: value.packed_changed_ids,
      matched_geometric_ratio: value.matched_geometric_ratio, block_ratios: value.block_ratios, retained_workspace_bytes: value.retained_workspace_bytes,
      original_weight_bytes: value.original_weight_bytes, packed_weight_bytes: value.packed_weight_bytes}]))}));
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
