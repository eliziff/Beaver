import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeIndra, decodePaddle } from '../../legal-browser-ocr/experiments/ocr-speed/detector-post.js';

const root = resolve(import.meta.dirname, '../..');
const fixture = resolve(root, 'benchmarks/local-data/ocr-candidate-screen/browser/detector-parity');
const output = resolve(process.argv[2] || 'benchmarks/local-data/ocr-candidate-screen/browser/post-kernel/latest');
const controlPath = resolve(root, 'legal-browser-ocr/dist/detector-post-control.mjs');
const control = await import(pathToFileURL(controlPath).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reference = JSON.parse(readFileSync(resolve(fixture, 'reference.json'), 'utf8'));
const native = {};
for (const name of ['indra', 'paddle']) {
  const bytes = readFileSync(resolve(fixture, name + '-output.f32'));
  const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const [height, width] = reference[name].output_shape.slice(-2);
  const before = name === 'indra' ? control.decodeIndra : control.decodePaddle;
  const after = name === 'indra' ? decodeIndra : decodePaddle;
  const expected = before(data, width, height, reference[name].config);
  assert.deepEqual(after(data, width, height, reference[name].config), expected, name);
  assert.equal(expected.length, reference[name].boxes.length);
  const remaining = new Set(expected.map(box => name === 'paddle' ? Object.fromEntries(Object.entries(box)
    .map(([key, value]) => [key, Math.round(Math.max(0, Math.min(key.startsWith('x') ? width : height, value)))])) : box));
  let maximumCoordinateError = 0;
  for (const coordinates of reference[name].boxes) {
    const difference = box => Math.max(...['x0', 'y0', 'x1', 'y1'].map((key, i) => Math.abs(box[key] - coordinates[i])));
    const closest = [...remaining].sort((a, b) => difference(a) - difference(b))[0];
    assert.ok(closest); const error = difference(closest); remaining.delete(closest);
    maximumCoordinateError = Math.max(maximumCoordinateError, error);
    assert.ok(error <= (name === 'indra' ? .001 : 2), `${name}: independent native coordinates differ`);
  }
  native[name] = { data, width, height, sha256: hash(bytes), boxes: expected.length, maximum_coordinate_error: maximumCoordinateError };
}
// Independently invented masks exercise boundaries, diagonal contacts, noise,
// large components and fractional distances without publishing document data.
for (const [width, height] of [[13, 17], [173, 91], [512, 392]]) {
  const plane = width * height, data = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    const x = i % width, y = Math.floor(i / width);
    data[i] = x < 3 || y % 19 < 4 || (x + y) % 43 === 0 ? 1 : -1;
    data[plane + i] = 3.125 + (i % 13) / 7;
    data[plane * 2 + i] = 4.25 + (i % 17) / 11;
  }
  assert.deepEqual(decodeIndra(data, width, height), control.decodeIndra(data, width, height));
}
const { data, width, height } = native.indra;
for (let i = 0; i < 10; i++) { control.decodeIndra(data, width, height); decodeIndra(data, width, height); }
const timings = { control: [], fused: [] }, iterations = 100;
for (let round = 0; round < 7; round++) {
  for (const [name, decode] of round % 2 ? [['fused', decodeIndra], ['control', control.decodeIndra]] : [['control', control.decodeIndra], ['fused', decodeIndra]]) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) decode(data, width, height);
    timings[name].push((performance.now() - started) / iterations);
  }
}
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = { origin: 'machine_test', run_id: randomUUID(), scope: 'Native detector output plus invented boundary masks; component timing only',
  control_sha256: hash(readFileSync(controlPath)), candidate_sha256: hash(readFileSync(resolve(root, 'legal-browser-ocr/experiments/ocr-speed/detector-post.js'))),
  native: Object.fromEntries(Object.entries(native).map(([name, { data, ...value }]) => [name, value])),
  exact_coordinate_parity: true, invented_masks: 3, iterations_per_round: iterations, milliseconds_per_decode: timings,
  median_ms: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, median(values)])) };
mkdirSync(output, { recursive: true }); writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ exact_coordinate_parity: true, median_ms: result.median_ms }));
