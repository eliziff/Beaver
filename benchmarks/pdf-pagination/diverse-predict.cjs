/** Compare production non-OCR pagination with citation-blind margin readings. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const folderArg = process.argv.indexOf('--folder');
const folder = folderArg < 0 ? path.join(root, 'tmp/pdf-pagination/canadian-diverse-originals')
  : path.resolve(process.argv[folderArg + 1]);
process.env.MIKE_LOCAL_DATA_DIR = path.join(folder, 'non-ocr-store');
process.env.MIKE_PDF_OCR_PROVIDER = 'none';
process.env.MIKE_PDF_LAYOUT_PROVIDER = 'none';
const { documentProjectionService } = require('../../backend/dist/lib/documentProjectionService');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(folder, 'manifest.json'));
const assessmentBytes = fs.readFileSync(path.join(folder, 'folio-assessment.json'));
const rows = JSON.parse(manifestBytes).filter(row => row.outcome === 'original');
const assessment = JSON.parse(assessmentBytes);
const readings = new Map(assessment.readings.map(reading => [reading.sha256, reading]));
if (new Set(rows.map(row => row.sha256)).size !== rows.length ||
    readings.size !== rows.length || rows.some(row =>
      !readings.has(row.sha256) || !Array.isArray(readings.get(row.sha256).duplicate_labels))) {
  throw new Error('Folio assessment does not cover this exact original-PDF manifest; rerun assess-diverse.py');
}
const only = process.argv.indexOf('--only');
const selected = only < 0 ? rows : rows.filter(row => row.sha256 === process.argv[only + 1]);
if (!selected.length) throw new Error('No matching original PDF');
const outputArg = process.argv.indexOf('--output');
const output = outputArg < 0 ? path.join(folder, only < 0 ? 'production-non-ocr.json' :
  `production-non-ocr-${selected[0].sha256.slice(0, 12)}.json`) : path.resolve(process.argv[outputArg + 1]);
if (fs.existsSync(output)) throw new Error(`Receipt already exists: ${output}; pass --output for a fresh run`);
fs.mkdirSync(path.dirname(output), { recursive: true });

async function main() {
  const { printedPageIndices, resolvePrintedPages } = await import('../../shared/pdf-page-binding.mjs');
  const receipt = {
    method: 'documentProjectionService.pdfPagination, reporterOriginal=false, OCR/layout disabled',
    manifestSha256: hash(manifestBytes),
    assessmentSha256: hash(assessmentBytes),
    projectionSha256: hash(fs.readFileSync(path.join(root, 'backend/dist/lib/documentProjectionService.js'))),
    bindingSha256: hash(fs.readFileSync(path.join(root, 'shared/pdf-page-binding.mjs'))),
    selectedOriginals: selected.length, manifestOriginals: rows.length,
    complete: false, results: [],
  };
  for (const row of selected) {
    const reading = readings.get(row.sha256);
    const bytes = fs.readFileSync(row.path);
    if (hash(bytes) !== row.sha256) throw new Error(`Original PDF hash changed: ${row.sha256}`);
    const started = performance.now();
    const result = { sha256: row.sha256, court: row.court, sourceUrl: row.sourceUrl ?? row.url,
      sampledPages: [], duplicateLabels: [] };
    try {
      const bindings = await documentProjectionService.pdfPagination({
        documentId: row.sha256, versionId: row.sha256, sourceSha256: row.sha256,
        fileType: 'pdf', reporterOriginal: false, readBytes: () => bytes,
      });
      if (bindings.length !== row.page_count) throw new Error('Production page count differs from original PDF');
      const indices = printedPageIndices(bindings.map(binding => binding.label));
      result.bindings = bindings;
      result.sampledPages = reading.pages.map(page => {
        const binding = bindings[page.pdf_page - 1];
        return { pdfPage: page.pdf_page, independentStatus: page.status,
          independentLabel: page.label, productLabel: binding.label,
          productSource: binding.source, productStatus: binding.status,
          outcome: page.status !== 'readable' ? 'unscored' :
            binding.label === page.label ? 'exact' :
              binding.label === null ? 'abstained' : 'disagreed' };
      });
      result.duplicateLabels = (reading.duplicate_labels ?? []).map(item => {
        const destinations = resolvePrintedPages(item.label, indices, bindings.length).map(index => index + 1);
        const productPages = (indices.get(item.label) ?? []).map(index => index + 1);
        return { label: item.label, independentPdfPages: item.pdf_pages,
          productPdfPages: productPages, destinations,
          detectedAtAllIndependentPages: item.pdf_pages.every(page => productPages.includes(page)),
          unsafeUniqueDestination: destinations.length > 0 };
      });
    } catch (error) {
      result.error = String(error);
    }
    result.elapsedMs = Math.round(performance.now() - started);
    receipt.results.push(result);
    const outcomes = receipt.results.flatMap(item => item.sampledPages.map(page => page.outcome));
    receipt.summary = {
      attemptedOriginals: receipt.results.length,
      successfulOriginals: receipt.results.filter(item => !item.error).length,
      failedOriginals: receipt.results.filter(item => item.error).length,
      sampledOutcomes: Object.fromEntries([...new Set(outcomes)].sort().map(value =>
        [value, outcomes.filter(item => item === value).length])),
      duplicateLabelGroups: receipt.results.reduce((sum, item) => sum + item.duplicateLabels.length, 0),
      fullyDetectedDuplicateGroups: receipt.results.reduce((sum, item) =>
        sum + item.duplicateLabels.filter(label => label.detectedAtAllIndependentPages).length, 0),
      unsafeUniqueDestinations: receipt.results.reduce((sum, item) =>
        sum + item.duplicateLabels.filter(label => label.unsafeUniqueDestination).length, 0),
    };
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ sha256: row.sha256, court: row.court,
      elapsedMs: result.elapsedMs, error: result.error,
      outcomes: result.sampledPages.map(page => page.outcome),
      duplicateLabels: result.duplicateLabels.length }));
  }
  receipt.complete = true;
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt.summary));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
