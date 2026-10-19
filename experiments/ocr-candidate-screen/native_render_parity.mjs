import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const { PDFDocument, PDFName, PDFNumber, degrees } = createRequire(resolve(root, 'legal-browser-ocr/package.json'))('pdf-lib');
const [fixtureArg, outputArg, baselineArg] = process.argv.slice(2);
assert(fixtureArg && outputArg, 'usage: native_render_parity.mjs INVENTED_FIXTURE.pdf OUTPUT [V0.2.1_EXE]');
const output = resolve(outputArg), stage = resolve(root, 'legal-pdf-parser/dist/legal-ocr-runtime-windows-x64');
mkdirSync(output, { recursive: true });
const fixture = readFileSync(resolve(fixtureArg)), source = await PDFDocument.load(fixture), pdf = await PDFDocument.create();
for (let index = 0; index < 9; index++) {
  const [page] = await pdf.copyPages(source, [0]);
  pdf.addPage(page); page.setRotation(degrees((index % 4) * 90));
  if (index >= 4) page.setCropBox(12, 16, page.getWidth() - 24, page.getHeight() - 32);
  if (index >= 7) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
}
pdf.setCreationDate(new Date('2000-01-01T00:00:00Z')); pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));
const input = resolve(output, 'geometry.pdf'); writeFileSync(input, await pdf.save());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binaries = { before: resolve(baselineArg || resolve(root, 'legal-browser-ocr/dist/runtime-speed-baseline/legalocr.exe')), after: resolve(root, 'native/legal-structure-node/target/release/legalocr.exe') };
assert.equal(hash(readFileSync(binaries.before)), 'd8a370c1c746d5ba53955f67866527077b0ac166efee3bc0cf89ecdd58757f33', 'Use the original v0.2.1 executable for this control');
const values = {};
for (const [name, binary] of Object.entries(binaries)) {
  const destination = resolve(output, name + '.json');
  const run = spawnSync(binary, [input, '--model-pack', resolve(stage, 'runtime/indra'),
    '--runtime', resolve(stage, 'runtime/onnx/onnxruntime.dll'), '--backend', 'cpu',
    '--workers', '1', '--threads', '1', '--layout-workers', '1', '--batch-size', '16',
    '--width-bucket', '24', '--output', destination], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, run.stderr); values[name] = JSON.parse(readFileSync(destination, 'utf8'));
  assert.equal(values[name].pages.length, 9);
  assert(values[name].pages.every(page => page.lines.length > 0));
}
assert.deepEqual(values.after.pages, values.before.pages, 'Concurrent rendering changed page order, text, confidence or geometry');
const result = { origin: 'machine_test', run_id: randomUUID(), input_provenance: 'independently invented Lite fixture; authorities_lite_ocr.mjs',
  fixture_sha256: hash(fixture), input_sha256: hash(readFileSync(input)), pages: 9,
  binary_sha256: Object.fromEntries(Object.entries(binaries).map(([name, binary]) => [name, hash(readFileSync(binary))])),
  recognized_sha256: hash(Buffer.from(JSON.stringify(values.after.pages))), rotation_crop_user_unit_parity: true };
writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
