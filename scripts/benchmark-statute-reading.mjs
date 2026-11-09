// Invented statutes through both native consumers. Save a pre-change report, then pass it as the
// second argument to compare every emitted outline field and UTF-16 offset, not just the timings.
// node scripts/benchmark-statute-reading.mjs REPORT_JSON [BASELINE_JSON]
import './background-work.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defaultNativeAddon } from '../shared/nativeAddonFile.mjs';
import { longStatuteRecord } from './authorities-stress/fixtures.mjs';

if (!process.argv[2]) throw new Error('Supply the report path; optionally supply a saved baseline report.');
const output = path.resolve(process.argv[2]);
const baselinePath = process.argv[3] && path.resolve(process.argv[3]);
assert.notEqual(output, baselinePath, 'The candidate report must not overwrite the baseline');
const baseline = baselinePath && JSON.parse(await readFile(baselinePath, 'utf8'));
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'backend/package.json'));
require('tsx/cjs');
const { structureNative } = require(path.join(root, 'backend/src/lib/structureNative.ts'));
const native = structureNative();
const hash = value => createHash('sha256').update(value).digest('hex');
const samples = [];
for (const [count, unicode] of [[40, false], [400, false], [5400, false], [400, true]]) {
  const record = longStatuteRecord(count);
  if (unicode) record.unofficial_text_en = '# Rivière 😀 — règlement\n\n' + record.unofficial_text_en;
  let start = performance.now();
  const document = await native.a2ajRecord(record, 'en', 'laws');
  const recordMs = performance.now() - start;
  assert.ok(document);
  const text = native.documentText(document.searchNative);
  const documentOutlineSha256 = hash(JSON.stringify(native.documentOutline(document.searchNative)));
  start = performance.now();
  const outline = native.textOutline(record.unofficial_text_en, 'laws');
  const outlineMs = performance.now() - start;
  const sample = { count, unicode, recordMs, outlineMs, characters: text.length,
    entries: outline.length, sourceSha256: hash(record.unofficial_text_en), textSha256: hash(text),
    documentOutlineSha256, textOutlineSha256: hash(JSON.stringify(outline)) };
  samples.push(sample);
  console.log(JSON.stringify(sample));
}
const report = { machine_test: true, runId: 'codex-parser-refactor-statute-reading',
  node: process.version, platform: `${process.platform}/${process.arch}`,
  addonSha256: hash(await readFile(process.env.LEGAL_STRUCTURE_NATIVE ??
    defaultNativeAddon(path.join(root, 'native/legal-structure-node')))), samples };
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
if (baseline) {
  const products = ({ recordMs, outlineMs, ...sample }) => sample;
  assert.deepEqual(samples.map(products), baseline.samples.map(products), 'Statute products changed');
}
