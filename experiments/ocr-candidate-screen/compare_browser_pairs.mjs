import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const [folderArg, outputArg, candidate = 'queued4'] = process.argv.slice(2);
assert.ok(folderArg && outputArg, 'compare_browser_pairs.mjs PRIVATE_FAMILY SUMMARY_JSON');
assert.ok(['queued2', 'queued4'].includes(candidate));
const folder = resolve(folderArg), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
const order = ['a1-control', 'b1-queued4', 'b2-queued4', 'a2-control', 'b3-queued4', 'a3-control', 'a4-control', 'b4-queued4'].map(name => name.replace('queued4', candidate));
const cases = order.map(name => {
  const bytes = readFileSync(resolve(folder, name, 'results.json')), receipt = JSON.parse(bytes), model = receipt.models['balanced-webgpu'];
  assert.equal(receipt.rounds, 3); assert.equal(model.runs.length, 3);
  assert.equal(model.pdf_gate.text_pages, 55); assert.equal(model.pdf_gate.first_page_pixels_identical, true);
  assert.equal(model.final_configuration.backend, 'webgpu');
  const totals = run => Object.fromEntries(['layout_read_seconds', 'layout_prepare_seconds', 'layout_model_seconds', 'model_seconds', 'model_batches', 'executed_pixels', 'gpu_session_builds'].map(key => [key, run.stages.reduce((sum, page) => sum + (page[key] || 0), 0)]));
  return {name, receipt, model, summary: {name, receipt_sha256: hash(bytes), html_sha256: receipt.standalone.sha256,
    median_pages_per_second: model.pages_per_second, warm_pages_per_second: model.runs.map(run => 55 / run.seconds),
    first_document_seconds: model.first_document_seconds, initialization_seconds: model.startup_seconds,
    cer: model.cer, edits: model.edits, characters: model.characters,
    text_sha256: model.text_sha256, lines_sha256: model.lines_sha256, pdf_sha256: model.pdf_gate.sha256,
    stages: Object.fromEntries(Object.keys(totals(model.runs[0])).map(key => [key, median(model.runs.map(run => totals(run)[key]))]))}};
});
const first = cases[0];
for (const entry of cases) {
  assert.deepEqual(entry.receipt.hardware, first.receipt.hardware);
  assert.equal(entry.receipt.browser_version, first.receipt.browser_version);
  assert.equal(entry.receipt.input_pdf_sha256, first.receipt.input_pdf_sha256);
  for (const key of ['text_sha256', 'lines_sha256', 'cer', 'edits', 'characters']) assert.equal(entry.model[key], first.model[key], `${entry.name}: ${key}`);
  assert.equal(entry.model.pdf_gate.sha256, first.model.pdf_gate.sha256);
  assert.deepEqual(entry.model.configuration, first.model.configuration);
  for (const key of ['model_batches', 'executed_pixels']) assert.ok(Math.abs(entry.summary.stages[key] - first.summary.stages[key]) < 1e-5, `${entry.name}: ${key}`);
  assert.equal(entry.summary.stages.gpu_session_builds, 0);
}
const controls = cases.filter(row => row.name.includes('control')), candidates = cases.filter(row => !row.name.includes('control'));
assert.equal(new Set(controls.map(row => row.summary.html_sha256)).size, 1);
assert.equal(new Set(candidates.map(row => row.summary.html_sha256)).size, 1);
assert.notEqual(controls[0].summary.html_sha256, candidates[0].summary.html_sha256);
const pairs = Array.from({length: 4}, (_, index) => {
  const control = controls.find(row => row.name === `a${index + 1}-control`), trial = candidates.find(row => row.name === `b${index + 1}-${candidate}`);
  return {control: control.name, candidate: trial.name, order: order.indexOf(control.name) < order.indexOf(trial.name) ? 'control-candidate' : 'candidate-control',
    ratio: trial.model.pages_per_second / control.model.pages_per_second};
});
const result = {origin: 'machine_test', run_id: randomUUID(), candidate, hardware: first.receipt.hardware, browser_version: first.receipt.browser_version,
  timed_pages: 55 * 3 * cases.length, first_document_pages: 55 * cases.length, input_pdf_sha256: first.receipt.input_pdf_sha256,
  control_median_pages_per_second: 55 / median(controls.flatMap(row => row.model.runs.map(run => run.seconds))),
  candidate_median_pages_per_second: 55 / median(candidates.flatMap(row => row.model.runs.map(run => run.seconds))),
  paired_geometric_mean_ratio: Math.exp(pairs.reduce((sum, pair) => sum + Math.log(pair.ratio), 0) / pairs.length), pairs,
  exact_text_geometry_and_pdf: true, cer: first.model.cer, edits: first.model.edits, characters: first.model.characters,
  cases: cases.map(row => row.summary)};
writeFileSync(resolve(outputArg), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({control_pages_per_second: result.control_median_pages_per_second, candidate_pages_per_second: result.candidate_median_pages_per_second,
  paired_ratio: result.paired_geometric_mean_ratio, pair_ratios: pairs.map(pair => pair.ratio), cer: result.cer, exact_outputs: true}));
