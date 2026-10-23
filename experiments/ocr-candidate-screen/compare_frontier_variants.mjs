import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const family = resolve(process.argv[2] || ''); assert.ok(process.argv[2], 'compare_frontier_variants.mjs PRIVATE_FAMILY');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sum = values => values.reduce((a, b) => a + b, 0);
const median = values => { values = [...values].sort((a, b) => a - b); return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2; };
const geometric = values => Math.exp(sum(values.map(Math.log)) / values.length);
const total = (run, key) => sum(run.stages.map(page => page[key] || 0));
const cases = ['screen', 'reverse'].map(name => {
  const bytes = readFileSync(resolve(family, name, 'results.json')), receipt = JSON.parse(bytes);
  const models = Object.entries(receipt.models); assert.equal(models.length, 1, 'Compare one tier per family');
  const [modelKey, model] = models[0];
  assert.equal(receipt.interleaved_variants.length, receipt.rounds); assert.equal(model.runs.length, receipt.rounds);
  assert.equal(model.configuration.backend, 'webgpu'); assert.equal(model.pdf_gate.text_pages, 55); assert.equal(model.pdf_gate.first_page_pixels_identical, true);
  for (const [index, run] of model.runs.entries()) {
    assert.equal(run.variant, receipt.interleaved_variants[index]);
    assert.equal(hash(Buffer.from(JSON.stringify(run.texts))), model.variant_results[run.variant].text_sha256);
    assert.equal(run.lines_sha256, model.variant_results[run.variant].lines_sha256);
  }
  const blocks = Array.from({length: receipt.rounds / 4}, (_, index) => {
    const runs = model.runs.slice(index * 4, index * 4 + 4), a = runs.filter(run => run.variant === 'control'), b = runs.filter(run => run.variant !== 'control');
    assert.equal(a.length, 2); assert.equal(b.length, 2); assert.equal(runs[0].variant, runs[3].variant); assert.equal(runs[1].variant, runs[2].variant);
    return {session: name, order: runs[0].variant === 'control' ? 'ABBA' : 'BAAB', ratio: sum(a.map(run => run.seconds)) / sum(b.map(run => run.seconds))};
  });
  return {name, receipt, model, modelKey, receipt_sha256: hash(bytes), blocks};
});
const first = cases[0], variant = Object.keys(first.model.variant_results).find(name => name !== 'control');
assert.ok(['s8', 'u8', 'head', 'cascade', 'conv'].includes(variant));
assert.deepEqual(cases[1].receipt.interleaved_variants, first.receipt.interleaved_variants.map(name => name === 'control' ? variant : 'control'));
for (const entry of cases) {
  assert.deepEqual(entry.receipt.hardware, first.receipt.hardware); assert.equal(entry.receipt.browser_version, first.receipt.browser_version);
  assert.equal(entry.receipt.input_pdf_sha256, first.receipt.input_pdf_sha256); assert.equal(entry.receipt.standalone.sha256, first.receipt.standalone.sha256);
  assert.equal(entry.receipt.control_tier, first.receipt.control_tier);
  assert.deepEqual(entry.model.configuration, first.model.configuration);
  assert.equal(entry.modelKey, first.modelKey);
  for (const name of ['control', variant]) for (const key of ['tier', 'edits', 'characters', 'cer', 'text_sha256', 'lines_sha256']) {
    assert.equal(entry.model.variant_results[name][key], first.model.variant_results[name][key], `${name}: ${key}`);
  }
}
const runs = cases.flatMap(entry => entry.model.runs), blocks = cases.flatMap(entry => entry.blocks);
if (['head', 'cascade'].includes(variant) && !first.receipt.control_tier) {
  const boxes = hash(Buffer.from(JSON.stringify(runs[0].stages.map(page => page.layout_boxes))));
  for (const run of runs) assert.equal(hash(Buffer.from(JSON.stringify(run.stages.map(page => page.layout_boxes)))), boxes);
}
if (variant === 'head') for (const run of runs) for (const key of ['model_batches', 'executed_pixels']) assert.ok(Math.abs(total(run, key) - total(runs[0], key)) < 1e-5);
const stageKeys = ['layout_prepare_seconds', 'layout_model_seconds', 'model_seconds', 'model_batches', 'recognition_lines', 'executed_pixels', 'gpu_session_builds',
  'frontier_cascade_lines', 'frontier_teacher_retry_lines', 'frontier_small_batches', 'frontier_teacher_batches'];
const scope = first.receipt.control_tier
  ? `${first.receipt.control_tier} control versus balanced ${variant}, browser WebGPU, full 55-page PDF, warmed same-session alternating modes; two sessions in reverse order`
  : `${first.model.configuration.tier} browser WebGPU, full 55-page PDF, warmed same-session alternating modes; two sessions in reverse order`;
const result = {origin: 'machine_test', run_id: randomUUID(), variant, scope,
  hardware: first.receipt.hardware, browser_version: first.receipt.browser_version, html_sha256: first.receipt.standalone.sha256, html_bytes: first.receipt.standalone.bytes,
  input_pdf_sha256: first.receipt.input_pdf_sha256, control_tier: first.receipt.control_tier, timed_pages: runs.length * 55, untimed_pages: cases.length * 165,
  measurements: Object.fromEntries(['control', variant].map(name => {
    const selected = runs.filter(run => run.variant === name);
    return [name, {...first.model.variant_results[name], pages_per_second: selected.length * 55 / sum(selected.map(run => run.seconds)),
      warm_passes: selected.length, seconds: selected.map(run => run.seconds), stages: Object.fromEntries(stageKeys.map(key => [key, median(selected.map(run => total(run, key)))]))}];
  })),
  matched_geometric_ratio: geometric(blocks.map(block => block.ratio)), block_range: [Math.min(...blocks.map(block => block.ratio)), Math.max(...blocks.map(block => block.ratio))],
  winning_blocks: blocks.filter(block => block.ratio > 1).length, blocks,
  by_session: Object.fromEntries(cases.map(entry => [entry.name, geometric(entry.blocks.map(block => block.ratio))])),
  by_order: Object.fromEntries(['ABBA', 'BAAB'].map(order => [order, geometric(blocks.filter(block => block.order === order).map(block => block.ratio))])),
  pdf_exports: cases.map(entry => ({variant: entry.model.runs.at(-1).variant, sha256: entry.model.pdf_gate.sha256, text_pages: 55, first_page_pixels_identical: true})),
  receipts: Object.fromEntries(cases.map(entry => [entry.name, entry.receipt_sha256])), native_measured: false, desktop_measured: false};
writeFileSync(resolve(family, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({variant, control_pages_per_second: result.measurements.control.pages_per_second, candidate_pages_per_second: result.measurements[variant].pages_per_second,
  matched_ratio: result.matched_geometric_ratio, session_ratios: result.by_session, block_range: result.block_range, wins: result.winning_blocks,
  control_cer: result.measurements.control.cer, candidate_cer: result.measurements[variant].cer, stages: result.measurements[variant].stages}));
