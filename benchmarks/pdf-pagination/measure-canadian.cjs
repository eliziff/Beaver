// Time the production, citation-aware page-binding operation on cached public originals.
// Acquisition and OCR are deliberately outside the timed region.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'tmp/pdf-pagination');
process.env.MIKE_LOCAL_DATA_DIR = path.join(out, 'measure-store');
const { documentProjectionService } = require('../../backend/dist/lib/documentProjectionService');
const argv = process.argv.slice(2);
const value = name => argv[argv.indexOf(name) + 1];
const runId = argv.includes('--run-id') ? value('--run-id') : null;
const phase = argv.includes('--phase') ? value('--phase') : 'cold';
if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId) || !['cold', 'reopen'].includes(phase))
  throw new Error('Use --run-id LETTERS-DIGITS and --phase cold|reopen');
const sourceRows = JSON.parse(fs.readFileSync(path.join(out, 'publisher-cached.json')));
const groups = new Map();
for (const row of sourceRows) {
  const group = groups.get(row.stratum) ?? [];
  group.push(row); groups.set(row.stratum, group);
}
for (const group of groups.values()) group.sort((a, b) => a.sha256.localeCompare(b.sha256));
const rows = [];
while (rows.length < 100 && [...groups.values()].some(group => group.length))
  for (const key of [...groups.keys()].sort()) {
    if (rows.length === 100) break;
    const row = groups.get(key).shift();
    if (row) rows.push(row);
  }
if (rows.length !== 100 || new Set(rows.map(row => row.sha256)).size !== 100)
  throw new Error('The cached Canadian pool does not contain 100 unique originals');

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 10) / 10;
};
(async () => {
  const results = [], batchStarted = performance.now();
  for (const [index, row] of rows.entries()) {
    const bytes = fs.readFileSync(row.path);
    const source = {
      documentId: `canadian-pagination:${runId}:${row.sha256}`,
      versionId: row.sha256, sourceSha256: row.sha256,
      fileType: 'pdf', readBytes: () => bytes,
      reporterOriginal: true,
    };
    const started = performance.now();
    try {
      const bindings = await documentProjectionService.pdfPagination(source, row.citations);
      results.push({ sha256: row.sha256, year: row.year, stratum: row.stratum,
        pages: row.page_count, ms: performance.now() - started,
        labelled: bindings.filter(binding => binding.label !== null).length,
        sources: [...new Set(bindings.map(binding => binding.source).filter(Boolean))],
        bindings: bindings.map(binding => ({ pdfPage: binding.pdfPage, label: binding.label,
          source: binding.source, status: binding.status })) });
    } catch (error) {
      results.push({ sha256: row.sha256, year: row.year, stratum: row.stratum,
        pages: row.page_count, ms: performance.now() - started, error: String(error) });
    }
    if ((index + 1) % 10 === 0) {
      console.log(`${phase}: ${index + 1}/100; RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MiB`);
      global.gc?.();
    }
  }
  const ms = results.map(result => result.ms);
  const summary = { runId, phase, documents: results.length,
    failed: results.filter(result => result.error).length,
    elapsedSeconds: Math.round((performance.now() - batchStarted) / 100) / 10,
    medianMs: percentile(ms, .5), p90Ms: percentile(ms, .9), p95Ms: percentile(ms, .95),
    rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    labelledDocuments: results.filter(result => result.labelled > 0).length };
  fs.writeFileSync(path.join(out, `canadian-product-${runId}-${phase}.json`),
    JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary));
})().catch(error => { console.error(error); process.exitCode = 1; });
