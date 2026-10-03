import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { HOME, fixedDate, saveJson, sha256, canonical } from './common.mjs';

fixedDate();
const { createWorkloads, FAMILY_SPLIT_MANIFEST } = await import('./fixtures.mjs');
await mkdir(resolve(HOME, 'fixtures'), { recursive: false });
const manifest = { schema: 'beaver.court-cloud-fixtures.v1', fixed_date: new Date().toISOString(),
  family_split: FAMILY_SPLIT_MANIFEST, development: {}, holdout_sealed: {} };
for (const [generatorSplit, split] of [['development', 'dev'], ['holdout', 'holdout']]) {
  // Holdout is generated and sealed without assembling, evaluating, or printing any content.
  const workloads = await createWorkloads(generatorSplit);
  for (const workload of workloads) {
    const { id, input, ...metadata } = workload;
    const directory = resolve(HOME, 'fixtures', split, id);
    await mkdir(directory, { recursive: true });
    const sourceRows = [];
    const encodedInput = { ...input, entries: [] };
    const files = {};
    for (const [index, entry] of input.entries.entries()) {
      const bytes = Buffer.from(await entry.file.arrayBuffer());
      const path = `source-${String(index + 1).padStart(3, '0')}.pdf`;
      const hash = sha256(bytes);
      await writeFile(resolve(directory, path), bytes, { mode: 0o444 });
      files[path] = hash;
      sourceRows.push({ entryId: entry.id, sha256: hash, byteCount: bytes.byteLength, pageCount: entry.pageCount });
      encodedInput.entries.push({ ...entry, file: { path, name: entry.file.name,
        type: entry.file.type, size: bytes.byteLength, sha256: hash } });
    }
    assert.equal(input.entries.length, Number(id.split('-').at(-1)));
    assert.equal(new Set(sourceRows.map((source) => source.sha256)).size, input.entries.length, 'Unique source PDF bytes within workload');
    const serialized = { id, split, input: encodedInput, sources: sourceRows, ...metadata };
    await saveJson(resolve(directory, 'input.json'), serialized);
    await chmod(resolve(directory, 'input.json'), 0o444);
    files['input.json'] = sha256(await readFile(resolve(directory, 'input.json')));
    const row = { files, sha256: sha256(canonical(files)), source_count: sourceRows.length,
      source_pages: sourceRows.reduce((sum, source) => sum + source.pageCount, 0),
      unique_source_count: new Set(sourceRows.map((source) => source.sha256)).size };
    (split === 'dev' ? manifest.development : manifest.holdout_sealed)[id] = row;
  }
}
// This manifest carries hashes and counts only; holdout content remains unopened until the final incumbent.
await saveJson(resolve(HOME, 'fixture-manifest.json'), manifest);
await chmod(resolve(HOME, 'fixture-manifest.json'), 0o444);
process.stdout.write(JSON.stringify({ fixture_manifest_sha256: sha256(await readFile(resolve(HOME, 'fixture-manifest.json'))),
  development_workloads: Object.keys(manifest.development), holdout_workloads_sealed: Object.keys(manifest.holdout_sealed),
  holdout_evaluations: 0 }) + '\n');
