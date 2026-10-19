import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '../..');
const rounds=Number(process.env.OCR_BENCH_ROUNDS||3);assert.ok([1,3,7].includes(rounds));
const [manifestArg, outputArg, casesArg = 'balanced:cpu,balanced:directml,balanced:auto,quality:auto', kind = 'pdf'] = process.argv.slice(2);
assert.ok(manifestArg && outputArg, 'usage: native_runtime_benchmark.mjs MANIFEST OUTPUT [tier:backend,...] [pdf|images|first-page]');
assert.ok(['pdf', 'images', 'first-page'].includes(kind));
const manifestPath = resolve(manifestArg), inputs = dirname(manifestPath), output = resolve(outputArg);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let pdf = resolve(inputs, 'input.pdf');
assert.equal(hash(readFileSync(pdf)), '039410bc7219449184726a09e261724c3a0f52b050e844f4649fc3ee605bb8a8');
const packaged = process.env.OCR_BENCH_RUNTIME_ROOT ? resolve(process.env.OCR_BENCH_RUNTIME_ROOT) : null;
const binary = packaged ? resolve(packaged, 'legalocr.exe') : resolve(root, 'native/legal-structure-node/target/release/legalocr.exe');
const owner = resolve(root, 'legal-pdf-parser');
const models = resolve(packaged ?? owner, 'runtime/indra');
const runtime = resolve(packaged ?? owner, 'runtime/onnx/onnxruntime.dll');
mkdirSync(output, { recursive: true });
if (kind === 'first-page') {
  const { PDFDocument } = createRequire(resolve(root, 'legal-browser-ocr/package.json'))('pdf-lib');
  const source = await PDFDocument.load(readFileSync(pdf)), first = await PDFDocument.create();
  const [page] = await first.copyPages(source, [0]); first.addPage(page);
  first.setCreationDate(new Date('2000-01-01T00:00:00Z'));
  first.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  pdf = resolve(output, 'first-page.pdf');
  writeFileSync(pdf, await first.save({ useObjectStreams: false }));
  manifest = { ...manifest, pages: manifest.pages.slice(0, 1) };
}
const list = resolve(output, 'images.json');
if (kind === 'images') {
  for (const page of manifest.pages) assert.equal(hash(readFileSync(resolve(inputs, page.png))), page.png_sha256);
  writeFileSync(list, JSON.stringify(manifest.pages.map(page => relative(output, resolve(inputs, page.png)))));
}
const normalized = value => value.replace(/[\u00ad\u00ac]\r?\n/g, '').normalize('NFKC').replace(/[\u00ad\u00ac]/g, '').replace(/\s+/gu, ' ').trim();
function distance(a, b) {
  a = Array.from(a); b = Array.from(b); const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) { let previous = row[0]; row[0] = i + 1; for (let j = 0; j < b.length; j++) { const old = row[j + 1]; row[j + 1] = Math.min(old + 1, row[j] + 1, previous + Number(a[i] !== b[j])); previous = old; } }
  return row[b.length];
}
const result = { origin: 'machine_test', run_id: randomUUID(), hardware: { cpu: cpus()[0].model, logical_cpus: cpus().length },
  input_manifest_sha256: hash(readFileSync(manifestPath)), input_pdf_sha256: hash(readFileSync(pdf)),
  binary_sha256: hash(readFileSync(binary)), kind, rounds, models: {} };
for (const entry of casesArg.split(',')) {
  const [tier, backend] = entry.split(':'), key = `${tier}-${backend}`;
  assert.ok(['quality', 'balanced', 'fast', 'turbo', 'extreme'].includes(tier));
  assert.ok(['auto', 'cpu', 'directml', 'cuda'].includes(backend));
  const path = resolve(output, key+'.json');
  const args = [kind === 'images' ? list : pdf, '--model-pack', models, '--runtime', runtime,
    '--tier', tier, '--backend', backend, '--repeat', String(kind === 'first-page' ? 1 : rounds), '--output', path];
  // Optional explicit plans are benchmark controls, not installed defaults.
  for (const name of ['workers', 'threads', 'layout-workers', 'batch-size', 'width-bucket']) {
    const value = process.env[`OCR_BENCH_${name.toUpperCase().replaceAll('-', '_')}`];
    if (value) args.push('--'+name, value);
  }
  const started = performance.now();
  const child = spawnSync(binary, args, { windowsHide: true, timeout: 600000, encoding: 'utf8', maxBuffer: 1024*1024 });
  const processSeconds = (performance.now() - started) / 1000;
  assert.equal(child.status, 0, child.stderr?.slice(-6000));
  const value = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(value.pages.length, manifest.pages.length);
  let edits = 0, characters = 0;
  for (let index = 0; index < manifest.pages.length; index++) {
    const gold = normalized(manifest.pages[index].gold);
    const text = normalized(value.pages[index].lines.map(line => line.text).join('\n'));
    edits += distance(text, gold); characters += Array.from(gold).length;
  }
  result.models[key] = { runtime: value.runtime, identity: value.identity, startup_seconds: value.startup_seconds,
    first_document_seconds: value.first_document_seconds, first_document_with_startup_seconds: value.startup_seconds + value.first_document_seconds,
    process_seconds: processSeconds, recognized_sha256: hash(Buffer.from(JSON.stringify(value.pages))),
    runs: value.runs, seconds: value.seconds,
    pages_per_second: value.pages_per_second, profile: value.profile, edits, characters, cer: edits / characters };
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify({ case: key, pages_per_second: value.pages_per_second, cer: edits/characters, runtime: value.runtime, startup_seconds: value.startup_seconds }));
}
if (result.models['balanced-cpu'] && result.models['balanced-directml']) assert.ok(result.models['balanced-directml'].cer <= result.models['balanced-cpu'].cer + .0005, 'GPU CER exceeds CPU by more than 0.05 percentage points');
