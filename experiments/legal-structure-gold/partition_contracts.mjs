// The contract expansion's splits, after the source/proceeding family review its manifests ask for:
// a contract cut from a cohort document takes that document's split; others go by proceeding (the
// folder of the source URL, else the parent record), each proceeding wholly to one split by its hash
// (60% train, 30% development, 10% test). Only contracts that passed the quality review are kept.
// Writes contracts/partition.json and contracts/split-manifest.json ({documents: [{sha256, path,
// mode, split, pages}]}) for the grader.
//   node partition_contracts.mjs GOLD_DIR
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const rows = new Map();
for (const f of ['contracts-manifest.json', 'contracts/manifest.json', 'contracts/additional-author-manifest.json', 'contracts/retry-manifest.json'])
  for (const d of read(f).documents) rows.set(d.sha256, { ...rows.get(d.sha256), ...d });
const cohort = new Map(read('cohort-manifest.json').documents.map(d => [d.sha256, d.split]));
const passed = read('contracts-review/quality-latest.json').records.filter(r => r.passed).map(r => r.sha256);
const share = key => parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 2 ** 32;
const decisions = [];
for (const sha of passed) {
  const d = rows.get(sha);
  if (!d) throw new Error(`${sha} has no manifest row`);
  if (cohort.has(sha)) continue;
  const parent = d.parent_sha256 && cohort.get(d.parent_sha256);
  const proceeding = d.source_url ? d.source_url.split('/').slice(0, -1).join('/') : `parent:${d.parent_sha256 ?? sha}`;
  const u = share(proceeding);
  const split = parent ?? (u < 0.6 ? 'train' : u < 0.9 ? 'development' : 'test');
  decisions.push({ sha256: sha, split, basis: parent ? `parent ${d.parent_sha256} is a cohort ${parent} document` : `proceeding ${proceeding}`,
                   path: d.path, mode: d.mode, pages: d.pages });
}
const counts = {};
for (const d of decisions) counts[`${d.split}/${d.mode}`] = (counts[`${d.split}/${d.mode}`] ?? 0) + 1;
fs.writeFileSync(path.join(dir, 'contracts/partition.json'), JSON.stringify({
  rule: 'A contract cut from a cohort document takes its split; otherwise its proceeding (source URL folder, else parent record) goes wholly to one split by sha256 of the proceeding: <0.6 train, <0.9 development, else test.',
  counts, decisions }, null, 1));
fs.writeFileSync(path.join(dir, 'contracts/split-manifest.json'), JSON.stringify({
  documents: decisions.map(({ sha256, path, mode, split, pages }) => ({ sha256, path, mode, split, pages })) }, null, 1));
console.log(decisions.length, 'contracts', counts, 'proceedings', new Set(decisions.map(d => d.basis)).size);
