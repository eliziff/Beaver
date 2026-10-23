import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const family = resolve(process.argv[2] || 'benchmarks/local-data/ocr-candidate-screen/browser/frontier2/captured-heads/latest');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const geometric = values => Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
const cases = ['screen', 'reverse'].map(name => {
  const bytes = readFileSync(resolve(family, name, 'results.json'));
  return {name, sha256: hash(bytes), data: JSON.parse(bytes)};
});
assert.deepEqual(cases[0].data.files, cases[1].data.files);
assert.equal(cases[0].data.starting_order_reversed, false);
assert.equal(cases[1].data.starting_order_reversed, true);
const sources = {
  '/kernel.js': 'legal-browser-ocr/experiments/ocr-speed/fused-gpu-head.js',
  '/argmax.js': 'legal-browser-ocr/experiments/ocr-speed/gpu-argmax.js',
  '/captured-session.js': 'legal-browser-ocr/experiments/ocr-speed/captured-session.js',
  '/feature-session.js': 'legal-browser-ocr/experiments/ocr-speed/feature-session.js',
  '/captured-trials.mjs': 'experiments/ocr-candidate-screen/captured_head_trials.mjs',
};
mkdirSync(resolve(family, 'sources'), {recursive: true});
for (const [key, path] of Object.entries(sources)) {
  const source = resolve(root, path);
  assert.equal(hash(readFileSync(source)), cases[0].data.files[key]);
  copyFileSync(source, resolve(family, 'sources', key.slice(1)));
}
copyFileSync(resolve(import.meta.dirname, 'fused_gpu_head_benchmark.mjs'), resolve(family, 'sources/harness.mjs'));
const first = cases[0].data;
const result = {origin: 'machine_test', run_id: randomUUID(), scope: first.scope, hardware: first.hardware,
  browser_version: first.browser_version, input_manifest_sha256: first.input_manifest_sha256,
  receipts: Object.fromEntries(cases.map(value => [value.name, value.sha256])), files: first.files, models: {}};
for (const kind of ['standard', 'light']) {
  const a = first.measurements[kind], b = cases[1].data.measurements[kind];
  assert.deepEqual(a.profiles, b.profiles);
  assert.deepEqual(a.checks, b.checks);
  const pairs = a.pairs.map(pair => {
    const other = b.pairs.find(value => value.profile === pair.profile && value.control === pair.control && value.candidate === pair.candidate);
    assert.ok(other);
    const ratios = [...pair.block_ratios, ...other.block_ratios];
    return {profile: pair.profile, control: pair.control, candidate: pair.candidate,
      matched_ratio: geometric(ratios), winning_blocks: ratios.filter(value => value > 1).length,
      blocks: ratios.length, session_ratios: [pair.matched_ratio, other.matched_ratio]};
  });
  const pressure = cases.map(value => value.data.measurements[kind].pressure_ratio);
  result.models[kind] = {checks: a.checks, profiles: a.profiles, pairs,
    cache_pressure_ratio: geometric(pressure), cache_pressure_session_ratios: pressure,
    steady_owned_buffers: a.steady_owned_buffers,
    cache_pressure_runs: cases.map(value => ({session: value.name,
      runs: value.data.measurements[kind].runs.filter(run => run.phase !== 'steady'),
      inventory: value.data.measurements[kind].pressure_owned_buffers}))};
}
writeFileSync(resolve(family, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.models).map(([name, value]) => [name,
  {pairs: value.pairs, pressure: value.cache_pressure_ratio, owned: value.steady_owned_buffers}]))));
