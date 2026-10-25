// Append a collection's rows ({sha256, path, mode, split, pages}) to the cohort manifest, leaving
// every existing row as it is and refusing a sha256 the manifest already holds.
//   node merge_manifest.mjs COHORT_MANIFEST ADDITION_MANIFEST
import fs from 'node:fs';
const [target, addition] = process.argv.slice(2);
const cohort = JSON.parse(fs.readFileSync(target, 'utf8'));
const known = new Set(cohort.documents.map(d => d.sha256));
let added = 0;
for (const d of JSON.parse(fs.readFileSync(addition, 'utf8')).documents) {
  if (known.has(d.sha256)) continue;
  cohort.documents.push({ path: d.path, mode: d.mode, split: d.split, sha256: d.sha256, pages: d.pages });
  known.add(d.sha256);
  added++;
}
fs.writeFileSync(target + '.tmp', JSON.stringify(cohort, null, 1));
fs.renameSync(target + '.tmp', target);
console.log(`${target}: ${added} rows added, ${cohort.documents.length} in all`);
