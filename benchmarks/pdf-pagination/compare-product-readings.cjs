// Compare production bindings with independent saved folio readings on cached originals.
const fs = require('node:fs');
const path = require('node:path');

const out = path.resolve('tmp/pdf-pagination');
const run = process.argv[2] || 'candidate1';
const measured = JSON.parse(fs.readFileSync(path.join(out, `canadian-product-${run}-cold.json`)));
const source = JSON.parse(fs.readFileSync(path.join(out, 'publisher-cached.json')));
const byHash = new Map(source.map(row => [row.sha256, row]));
const counts = { documents: 0, sampled: 0, readable: 0, resolved: 0,
  correct: 0, wrong: 0, unknown: 0, unreadable: 0 };
const exceptions = [];
const unknownExamples = [];
const byBatch = {};
for (const result of measured.results) {
  const row = byHash.get(result.sha256);
  const visualPath = path.join(out, `${result.sha256}.visual.json`);
  if (!fs.existsSync(visualPath)) continue;
  counts.documents++;
  const visual = JSON.parse(fs.readFileSync(visualPath));
  const batch = visual.batch || visual.method || 'unspecified';
  const group = byBatch[batch] ??= { readable: 0, resolved: 0, correct: 0, unknown: 0 };
  for (const page of visual.pages) {
    counts.sampled++;
    if (page.status !== 'readable') { counts.unreadable++; continue; }
    counts.readable++;
    group.readable++;
    const binding = result.bindings?.[page.pdf_page - 1];
    const labels = page.labels.map(label => label.text);
    if (!binding?.label) {
      counts.unknown++; group.unknown++;
      if (unknownExamples.length < 12) unknownExamples.push({ citation: row.citation,
        pdfPage: page.pdf_page, labels, batch });
      continue;
    }
    counts.resolved++;
    group.resolved++;
    if (labels.includes(binding.label)) { counts.correct++; group.correct++; }
    else {
      counts.wrong++;
      exceptions.push({ citation: row.citation, sha256: row.sha256,
        pdfPage: page.pdf_page, predicted: binding.label, labels,
        source: binding.source });
    }
  }
}
const result = { run, counts, byBatch, exceptions, unknownExamples };
fs.writeFileSync(path.join(out, `canadian-product-${run}-comparison.json`),
  JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
