import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const folder = resolve(root, process.argv[2] || 'legal-browser-ocr/assets/indra-kernels/hswish');
const factory = (await import(pathToFileURL(resolve(folder, 'validation.mjs')).href)).default;
const binary = readFileSync(resolve(folder, 'validation.wasm'));
const module = await factory({ wasmBinary: binary });
const values = new Float32Array(10009), bits = new Uint32Array(values.buffer);
let seed = 41729;
for (let i = 0; i < values.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bits[i] = seed; }
values.set([0, -0, -3, 3, -2.999999761581421, 2.999999761581421, Infinity, -Infinity, NaN, 1e-38, -1e-38]);
const input = module._malloc(values.byteLength), output = module._malloc(values.byteLength + 16);
const reference = Float32Array.from(values, x => Math.fround(x * Math.max(0, Math.min(1, Math.fround(Math.fround(Math.fround(1 / 6) * x) + .5)))));
const checks = [];
try {
  for (const count of [...Array.from({ length: 18 }, (_, i) => i), values.length]) for (const inplace of [false, true]) {
    module.HEAPF32.set(values, input / 4); module.HEAPF32.fill(123.125, output / 4, output / 4 + values.length + 4);
    const target = inplace ? input : output;
    module._ocr_hardswish(input, target, count);
    const result = module.HEAPF32.subarray(target / 4, target / 4 + count);
    for (let i = 0; i < count; i++) assert.ok(Number.isNaN(reference[i]) ? Number.isNaN(result[i]) : Object.is(result[i], reference[i]), `Value ${i}, count ${count}, inplace ${inplace}`);
    if (!inplace) assert.ok(module.HEAPF32.subarray(output / 4 + count, output / 4 + count + 4).every(value => value === 123.125));
    else if (count < values.length) assert.equal(module.HEAPU32[(input / 4) + count], bits[count]);
    checks.push({ count, inplace, all_values_exact: true });
  }
} finally { module._free(input); module._free(output); }
const result = { origin: 'machine_test', run_id: randomUUID(), scope: 'Independent float32 ONNX function-body arithmetic; random bit patterns, boundaries, tails, guards and in-place aliasing; NaN payloads unconstrained',
  wasm_sha256: createHash('sha256').update(binary).digest('hex'),
  source_sha256: Object.fromEntries(['ocr_hardswish_wasm.h', 'hardswish_kernel.cpp', 'build_hardswish_kernel.sh'].map(name => [name,
    createHash('sha256').update(readFileSync(resolve(import.meta.dirname, name))).digest('hex')])), checks };
writeFileSync(resolve(folder, 'validation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ checks: checks.length, all_values_exact: true, wasm_sha256: result.wasm_sha256 }));
