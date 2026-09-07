// Focused real-compiler benchmark. No native parser, models or network services.
// node scripts/benchmark-document-text.mjs BASELINE_CHECKOUT [REPORT_JSON]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(self), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const repeats = 8;

if (process.argv[2] === '--sample') {
  const target = path.resolve(process.argv[3]), format = process.argv[4];
  const home = await mkdtemp(path.join(os.tmpdir(), 'beaver-text-bench-'));
  process.env.AUTH_MODE = 'local'; process.env.MIKE_LOCAL_DATA_DIR = home;
  const require = createRequire(path.join(target, 'backend/package.json'));
  require('tsx/cjs');
  const { createDocumentApplication } = require(path.join(target, 'backend/src/lib/documentApplication.ts'));
  const { documentRepository } = require(path.join(target, 'backend/src/lib/relationalDocumentRepository.ts'));
  const { createFilesystemObjectStorage } = require(path.join(target, 'backend/src/lib/storage.ts'));
  const { closeRelationalDatabase } = require(path.join(target, 'backend/src/lib/relationalDatabase.ts'));
  const { documentProjectionService: projections } = require(path.join(target, 'backend/src/lib/documentProjectionService.ts'));
  const scope = { userId: randomUUID() };
  const objects = createFilesystemObjectStorage(path.join(home, 'objects'));
  const documents = createDocumentApplication(documentRepository, objects);
  let sourceReads = 0, track = false;
  const get = objects.get.bind(objects);
  objects.get = key => { if (track) sourceReads++; return get(key); };
  try {
    let bytes;
    if (format === 'xlsx') {
      const { utils, write } = require('xlsx'), workbook = utils.book_new();
      utils.book_append_sheet(workbook, utils.aoa_to_sheet([
        ['Clause', 'Party', 'Amount', 'Notice days'],
        ...Array.from({ length: 1_000 }, (_, n) => [`Clause ${n + 1}`, `Party ${n % 17}`, 250 + n, n % 31]),
      ]), 'Terms');
      bytes = write(workbook, { bookType: 'xlsx', type: 'buffer' });
    } else if (format === 'eml') {
      bytes = Buffer.from('From: sender@example.test\r\nSubject: Notice\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
        'A contractual notice with exact amounts and Unicode 😀.\n'.repeat(2_000));
    } else throw new Error(`Unsupported fixture ${format}`);
    const create = () => documents.create(scope, { filename: `Fixture.${format}`, fileType: format, bytes });
    const first = await create(), concurrent = await create();
    const read = async document => {
      const source = await documents.projectionSource(scope, document.id, null);
      assert.ok(source); return projections.text(source);
    };
    // Setup/import/publication time is excluded; every timed read still obtains a
    // fresh authorized descriptor through the real SQLite document repository.
    track = true;
    const coldStart = performance.now(), expected = await read(first);
    const coldMs = performance.now() - coldStart, coldSourceReads = sourceReads;
    sourceReads = 0;
    const warmStart = performance.now();
    for (let i = 0; i < repeats; i++) assert.equal(await read(first), expected);
    const repeatedMs = performance.now() - warmStart, repeatedSourceReads = sourceReads;
    sourceReads = 0;
    const concurrentStart = performance.now();
    const results = await Promise.all(Array.from({ length: repeats }, () => read(concurrent)));
    results.forEach(text => assert.equal(text, expected));
    const concurrentMs = performance.now() - concurrentStart;
    console.log(JSON.stringify({ format, repeats, coldMs, repeatedMs, concurrentMs,
      coldSourceReads, repeatedSourceReads, concurrentSourceReads: sourceReads,
      inputBytes: bytes.length, outputBytes: Buffer.byteLength(expected), outputSha256: hash(expected) }));
  } finally { await closeRelationalDatabase(); await rm(home, { recursive: true, force: true }); }
} else {
  if (!process.argv[2]) throw new Error('Supply the baseline checkout (with locked backend dependencies installed).');
  const baseline = path.resolve(process.argv[2]), samples = [], summary = [];
  for (const format of ['xlsx', 'eml']) {
    for (let n = 0; n < 5; n++) {
      for (const variant of n % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const output = execFileSync(process.execPath, [self, '--sample', variant === 'baseline' ? baseline : root, format],
          { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        samples.push({ variant, sample: n, ...JSON.parse(output.trim().split('\n').at(-1)) });
      }
    }
    const matching = samples.filter(sample => sample.format === format);
    assert.equal(new Set(matching.map(sample => sample.outputSha256)).size, 1, 'Both compilers must return identical text');
    const metrics = ['coldMs', 'repeatedMs', 'concurrentMs', 'coldSourceReads', 'repeatedSourceReads', 'concurrentSourceReads'];
    summary.push({ format, ...Object.fromEntries(['baseline', 'candidate'].map(variant => [variant,
      Object.fromEntries(metrics.map(metric => [metric, median(matching.filter(sample => sample.variant === variant).map(sample => sample[metric]))])),
    ])) });
  }
  const report = { node: process.version, platform: `${process.platform}/${process.arch}`, samplesPerVariant: 5,
    notes: 'Real SQLite/filesystem, XLSX/PostalMime compilers; fresh process per sample; sequential repeat count and concurrency are 8; setup excluded. Not a live model, network, PDF or native DOCX benchmark.',
    summary, samples };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3]) {
    const output = path.resolve(process.argv[3]); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
}
