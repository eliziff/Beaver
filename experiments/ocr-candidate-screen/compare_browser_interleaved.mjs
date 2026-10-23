import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const [familyArg, outputArg] = process.argv.slice(2);
assert.ok(familyArg && outputArg, 'compare_browser_interleaved.mjs PRIVATE_FAMILY SUMMARY_JSON');
const family = resolve(familyArg), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const geometric = values => Math.exp(mean(values.map(Math.log)));
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
const total = (run, key) => run.stages.reduce((sum, page) => sum + (page[key] || 0), 0);
const trials = ['forward', 'reverse'].map(name => {
  const bytes = readFileSync(resolve(family, name, 'results.json')), receipt = JSON.parse(bytes), model = receipt.models['balanced-webgpu'];
  assert.equal(receipt.rounds, 24); assert.equal(model.runs.length, 24); assert.equal(model.queue_warmups.length, 2);
  assert.equal(model.pdf_gate.text_pages, 55); assert.equal(model.pdf_gate.first_page_pixels_identical, true);
  assert.equal(model.final_configuration.backend, 'webgpu');
  assert.equal(new Set(model.runs.map(run => run.lines_sha256)).size, 1);
  for (const [index, run] of model.runs.entries()) {
    assert.equal(run.queue_depth, receipt.interleaved_queue_order[index]);
    assert.equal(hash(Buffer.from(JSON.stringify(run.texts))), model.text_sha256);
    assert.equal(run.lines_sha256, model.lines_sha256);
    assert.equal(total(run, 'gpu_session_builds'), 0);
    for (const [key, expected] of Object.entries({model_batches: 156, executed_pixels: 49020928,
      experimental_queue_batches: run.queue_depth ? 156 : 0, experimental_queue_depth_batches: run.queue_depth * 156})) {
      assert.ok(Math.abs(total(run, key) - expected) < 1e-5, `${name} round ${index + 1}: ${key}`);
    }
  }
  const depth = Math.max(...receipt.interleaved_queue_order); assert.ok([2, 4].includes(depth));
  const blocks = Array.from({length: 6}, (_, index) => {
    const runs = model.runs.slice(index * 4, index * 4 + 4), order = runs.map(run => run.queue_depth ? 'B' : 'A').join('');
    assert.ok(['ABBA', 'BAAB'].includes(order));
    const control = runs.filter(run => !run.queue_depth), candidate = runs.filter(run => run.queue_depth);
    return {trial: name, block: index + 1, order, ratio: control.reduce((sum, run) => sum + run.seconds, 0) / candidate.reduce((sum, run) => sum + run.seconds, 0),
      control_pages_per_second: 110 / control.reduce((sum, run) => sum + run.seconds, 0), candidate_pages_per_second: 110 / candidate.reduce((sum, run) => sum + run.seconds, 0)};
  });
  return {name, receipt, model, summary: {name, receipt_sha256: hash(bytes), depth, blocks,
    geometric_mean_ratio: geometric(blocks.map(block => block.ratio)),
    runs: model.runs.map(run => ({queue_depth: run.queue_depth, seconds: run.seconds, pages_per_second: 55 / run.seconds,
      wall_started_ms: run.wall_started_ms, wall_finished_ms: run.wall_finished_ms,
      stages: Object.fromEntries(['render_seconds', 'layout_prepare_seconds', 'layout_model_seconds', 'layout_post_seconds', 'crop_pack_seconds',
        'model_seconds', 'decode_seconds', 'inference_seconds', 'model_batches', 'executed_pixels', 'gpu_session_builds', 'experimental_queue_batches',
        'experimental_queue_depth_batches'].map(key => [key, total(run, key)]))}))}};
});
const first = trials[0];
for (const trial of trials) {
  assert.deepEqual(trial.receipt.hardware, first.receipt.hardware); assert.equal(trial.receipt.browser_version, first.receipt.browser_version);
  assert.equal(trial.receipt.standalone.sha256, first.receipt.standalone.sha256); assert.equal(trial.receipt.input_pdf_sha256, first.receipt.input_pdf_sha256);
  assert.deepEqual(trial.model.configuration, first.model.configuration); assert.equal(trial.summary.depth, first.summary.depth);
  for (const key of ['text_sha256', 'lines_sha256', 'edits', 'characters', 'cer']) assert.equal(trial.model[key], first.model[key]);
  assert.equal(trial.model.pdf_gate.sha256, first.model.pdf_gate.sha256);
}
assert.deepEqual(trials[1].receipt.interleaved_queue_order, trials[0].receipt.interleaved_queue_order.map(depth => depth ? 0 : first.summary.depth));
const runs = trials.flatMap(trial => trial.summary.runs), controls = runs.filter(run => !run.queue_depth), candidates = runs.filter(run => run.queue_depth);
const blocks = trials.flatMap(trial => trial.summary.blocks), ratios = blocks.map(block => block.ratio);
const result = {origin: 'machine_test', run_id: randomUUID(), method: 'Two warmed browser sessions; six alternating ABBA/BAAB blocks per session; reverse starting order',
  hardware: first.receipt.hardware, browser_version: first.receipt.browser_version, standalone_sha256: first.receipt.standalone.sha256,
  input_pdf_sha256: first.receipt.input_pdf_sha256, depth: first.summary.depth, timed_pages: runs.length * 55, untimed_warmup_pages: 330,
  control_pages_per_second: controls.length * 55 / controls.reduce((sum, run) => sum + run.seconds, 0),
  candidate_pages_per_second: candidates.length * 55 / candidates.reduce((sum, run) => sum + run.seconds, 0),
  geometric_mean_block_ratio: geometric(ratios), median_block_ratio: median(ratios), min_block_ratio: Math.min(...ratios), max_block_ratio: Math.max(...ratios),
  winning_blocks: ratios.filter(ratio => ratio > 1).length, total_blocks: blocks.length,
  by_order: Object.fromEntries(['ABBA', 'BAAB'].map(order => [order, geometric(blocks.filter(block => block.order === order).map(block => block.ratio))])),
  cer: first.model.cer, edits: first.model.edits, characters: first.model.characters, text_sha256: first.model.text_sha256, lines_sha256: first.model.lines_sha256,
  pdf_sha256: first.model.pdf_gate.sha256, exact_outputs_and_work: true, trials: trials.map(trial => trial.summary)};
writeFileSync(resolve(outputArg), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({control_pages_per_second: result.control_pages_per_second, candidate_pages_per_second: result.candidate_pages_per_second,
  block_ratio: result.geometric_mean_block_ratio, block_range: [result.min_block_ratio, result.max_block_ratio], wins: result.winning_blocks,
  launch_ratios: result.trials.map(trial => trial.geometric_mean_ratio), by_order: result.by_order, exact_outputs_and_work: true}));
