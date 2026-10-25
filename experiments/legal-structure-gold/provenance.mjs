// Every gold PDF's provenance, one record per source: the collection and run it was authored in,
// its split and mode, and what it is and where it came from (genre, source family, proceeding,
// jurisdiction, parent record), read from the cohort manifest's paths and the collections' own
// manifests. For weighing results by source and genre, and for training or routing by document type.
//   node provenance.mjs GOLD_DIR      writes GOLD_DIR/provenance.json
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const exists = f => fs.existsSync(path.join(dir, f));
const contracts = new Map();
for (const f of ['contracts-manifest.json', 'contracts/manifest.json', 'contracts/additional-author-manifest.json', 'contracts/retry-manifest.json'])
  if (exists(f)) for (const d of read(f).documents) contracts.set(d.sha256, { ...contracts.get(d.sha256), ...d });
const partition = exists('contracts/partition.json') ? new Map(read('contracts/partition.json').decisions.map(d => [d.sha256, d])) : new Map();

/** Genre, country, source family from a corpus path. */
function fromPath(p) {
  const parts = p.replaceAll('\\', '/').split('/');
  const at = name => parts.indexOf(name);
  if (at('pdfs') >= 0) {
    const [country, born, genre, family] = parts.slice(at('pdfs') + 1);
    return { country, genre, source_family: family, mode_folder: born };
  }
  if (at('court-practice') >= 0) {
    const [country, genre] = parts.slice(at('court-practice') + 1);
    return { country, genre, source_family: `court-practice/${country}` };
  }
  if (at('canadian-contract-excerpts') >= 0) {
    const [province] = parts.slice(at('canadian-contract-excerpts') + 1);
    return { country: 'ca', province, genre: 'contract', source_family: 'canadian-contract-excerpts' };
  }
  if (at('court-record-exhibits') >= 0) return { country: null, genre: 'court-record-exhibit', source_family: 'court-record-exhibits' };
  return { country: null, genre: null, source_family: parts.slice(-3, -1).join('/') };
}

const records = [];
for (const d of read('cohort-manifest.json').documents) {
  // A contract of the expansion is one its partition placed; a cohort source it also named stays the cohort's.
  const contract = partition.has(d.sha256) ? contracts.get(d.sha256) : undefined;
  const receiptFile = path.join('v4', d.sha256, 'receipt.json');
  const receipt = exists(receiptFile) ? read(receiptFile) : {};
  const record = {
    sha256: d.sha256, split: d.split, mode: d.mode, pages: d.pages, path: d.path,
    collection: contract ? 'contracts-2026-10-21' : 'cohort-2026-10-18',
    authoring: { model: receipt.model ?? null, effort: receipt.effort ?? null, status: receipt.status ?? null,
                 postcorrections: receipt.postcorrections ?? 0 },
    ...fromPath(d.path),
  };
  if (contract) {
    let host = null;
    try { host = new URL(contract.source_url).host; } catch { /* a local source */ }
    Object.assign(record, {
      genre: 'contract', contract_kind: contract.kind ?? contract.contract_family ?? null, title: contract.title ?? null,
      jurisdiction: contract.jurisdiction ?? null, source_family: host ?? record.source_family,
      proceeding: partition.get(d.sha256)?.basis ?? null, parent_sha256: contract.parent_sha256 ?? null,
      source_url: contract.source_url ?? null, run_id: contract.run_id ?? null,
    });
  }
  records.push(record);
}
const count = key => records.reduce((c, r) => (c[r[key] ?? 'unknown'] = (c[r[key] ?? 'unknown'] ?? 0) + 1, c), {});
fs.writeFileSync(path.join(dir, 'provenance.json'), JSON.stringify({
  fields: 'sha256, split, mode, pages, path, collection, authoring, country, province, genre, source_family, mode_folder; contracts also contract_kind, title, jurisdiction, proceeding, parent_sha256, source_url',
  records }, null, 1));
console.log(records.length, 'records; collections', count('collection'), '; genres', Object.keys(count('genre')).length,
  '; source families', Object.keys(count('source_family')).length);
