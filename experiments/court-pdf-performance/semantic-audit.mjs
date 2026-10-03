import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, HOME, args, json, saveJson, sha256, canonical } from './common.mjs';

const options = args();
const split = options.split ?? 'dev';
if (split === 'holdout' && options.unseal !== 'final-incumbent') throw new Error('Holdout sealed');
const { getDocument, GlobalWorkerOptions } = await import(pathToFileURL(resolve(ROOT, 'frontend/node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = await import(pathToFileURL(resolve(ROOT, 'frontend/node_modules/pdf-lib/cjs/index.js')).href);
GlobalWorkerOptions.workerSrc = pathToFileURL(resolve(ROOT, 'frontend/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
const frozen = await json(resolve(HOME, 'fixtures', split, options.workload, 'input.json'));
const expected = await json(resolve(HOME, 'oracles', split, options.workload + '.json'));
const summary = { workload: options.workload, split, artifacts: [], checked_markers: 0,
  source_pages: frozen.sources.reduce((sum, source) => sum + source.pageCount, 0) };
let fullText = '', allStreams = '', allPages = 0, labels = [];
for (let index = 0; index < expected.artifacts.length; index++) {
  const bytes = new Uint8Array(await readFile(resolve(HOME, 'oracles', split, options.workload, `${index}.pdf`)));
  assert.equal(sha256(bytes), expected.artifacts[index].actualSha256);
  const rawPdf = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const page of rawPdf.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() },
      (_value, offset) => contents.lookup(offset, PDFRawStream)) : contents instanceof PDFRawStream ? [contents] : [];
    for (const stream of streams) allStreams += new TextDecoder().decode(decodePDFRawStream(stream).decode()) + '\n';
  }
  const task = getDocument({ data: bytes, standardFontDataUrl: resolve(ROOT, 'frontend/node_modules/pdfjs-dist/standard_fonts') + '/',
    useSystemFonts: false, isEvalSupported: false, disableFontFace: true });
  const document = await task.promise;
  assert.equal(document.numPages, expected.artifacts[index].pageCount);
  const pageLabels = await document.getPageLabels();
  assert(pageLabels && pageLabels.length === document.numPages);
  labels.push(...pageLabels);
  const pages = [];
  for (let pageIndex = 0; pageIndex < document.numPages; pageIndex++) {
    const page = await document.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const text = content.items.flatMap((item) => 'str' in item ? [item.str] : []).join(' ');
    fullText += text + '\n';
    const annotations = await page.getAnnotations();
    const links = [];
    for (const annotation of annotations.filter((item) => item.subtype === 'Link')) {
      let dest = annotation.dest;
      if (typeof dest === 'string') dest = await document.getDestination(dest);
      const pageTarget = Array.isArray(dest) ? typeof dest[0] === 'number' ? dest[0] : await document.getPageIndex(dest[0]) : null;
      if (pageTarget !== null) assert(pageTarget >= 0 && pageTarget < document.numPages, 'Internal destination resolves within its volume');
      links.push({ rect: annotation.rect, url: annotation.url ?? null, target: pageTarget });
    }
    pages.push({ pageIndex, rotation: page.rotate, view: page.view, text_sha256: sha256(text), links });
  }
  const walk = async (items) => Promise.all((items ?? []).map(async (item) => {
    let dest = item.dest;
    if (typeof dest === 'string') dest = await document.getDestination(dest);
    const pageIndex = dest ? typeof dest[0] === 'number' ? dest[0] : await document.getPageIndex(dest[0]) : null;
    assert(pageIndex !== null && pageIndex >= 0 && pageIndex < document.numPages);
    return { title: item.title, pageIndex, children: await walk(item.items) };
  }));
  const outlines = await walk(await document.getOutline());
  assert(outlines.length > 0);
  summary.artifacts.push({ filename: expected.artifacts[index].filename, pages, labels: pageLabels, outlines });
  allPages += document.numPages;
  await task.destroy();
}
assert(allPages >= summary.source_pages, 'Every source page plus generated pages retained');
assert.deepEqual(labels, labels.map((_label, index) => String(index + 1)), 'Continuous PDF labels across volumes');
for (const marker of frozen.markers ?? []) {
  const text = typeof marker === 'string' ? marker : marker.text;
  if (!fullText.includes(text)) {
    // Baseline OCR is invisible and some lines lie below the viewport. Require
    // its exact stored text operators without claiming visible extraction.
    const entry = frozen.input.entries.find((entry) => entry.id === marker.entryId);
    assert(entry?.ocrTextByPage?.some((value) => value.includes(text)), `Native source marker extracts: ${text}`);
    assert(allStreams.includes(Buffer.from(text, 'ascii').toString('hex').toUpperCase()), `Hidden OCR marker stored: ${text}`);
    summary.hidden_ocr_markers = (summary.hidden_ocr_markers ?? 0) + 1;
  }
  summary.checked_markers++;
}
summary.summary_sha256 = sha256(canonical(summary));
await saveJson(resolve(HOME, 'oracles', split, options.workload + '.semantic.json'), summary);
process.stdout.write(JSON.stringify({ workload: options.workload, pages: allPages,
  source_pages: summary.source_pages, markers: summary.checked_markers,
  artifacts: summary.artifacts.length, semantic_sha256: summary.summary_sha256 }) + '\n');
