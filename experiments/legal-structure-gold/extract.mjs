// Export the installed parser's paired structure and extraction witnesses. No build.
//   node extract.mjs PDF OUTPUT_DIRECTORY digitalborn|ocr [REQUEST.json]   one PDF; prints its file
//   node extract.mjs --batch JOBS.json   many PDFs with the addon loaded once; JOBS is a list of
//     {pdf, output, mode, requestFile}; prints one JSON line per job, {pdf, mode, file, ms} or
//     {pdf, mode, error}.
// LEGAL_STRUCTURE_ADDON pins one built addon. LAYOUT_PACK (with LAYOUT_RUNTIME) parses with the
// ppdoc layout provider, cached beside the plain request. RESOLVER_DUMP=1 has the parser write
// each document's structure-engine inputs beside its result, for engine replay.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { defaultNativeAddon, nativeAddonFile } from '../../shared/nativeAddonFile.mjs';
import { structureEngineAddon } from '../../shared/structure-engine.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const addonRoot = path.join(root, 'native/legal-structure-node');
const binary = process.env.LEGAL_STRUCTURE_ADDON || defaultNativeAddon(addonRoot);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binarySha256 = hash(readFileSync(binary));
// Parse as the app does: its configured profile, which routes pages to OCR itself.
process.env.LEGALPDF_ENGINE_ROOT ||= path.join(root, 'legal-pdf-parser');
const module = { exports: {} };
process.dlopen(module, nativeAddonFile(binary, addonRoot));
const parser = structureEngineAddon(module.exports, { toBuffer: bytes => Buffer.from(bytes) });
const readGzip = filename => JSON.parse(gunzipSync(readFileSync(filename)));

async function extract(pdf, output, mode, requestFile) {
  if (!['digitalborn', 'ocr'].includes(mode)) throw new Error(`Unknown mode ${mode}`);
  const bytes = readFileSync(pdf), sha256 = hash(bytes);
  const request = requestFile ? JSON.parse(readFileSync(requestFile, 'utf8')) :
    { kind: 'pdf', ...(await import('../../backend/src/lib/pdfProfile.ts')).profileFor(undefined, undefined) };
  const layout = process.env.LAYOUT_PACK;
  const destination = path.resolve(output, sha256, binarySha256,
    hash(JSON.stringify(request)).slice(0, 16) + (layout ? '-layout' : ''));
  if (layout) request.layout = { provider: 'ppdoc', settings: { model_pack: layout, runtime: process.env.LAYOUT_RUNTIME, backend: 'cpu', threads: 2 } };
  mkdirSync(destination, { recursive: true });
  const dump = process.env.RESOLVER_DUMP ? path.join(destination, `resolver-${mode}.json`) : null;
  // The engine's inputs are written as the structure stage runs: a cached document skips it.
  if (dump) {
    process.env.LEGALPDF_RESOLVER_DUMP = dump;
    rmSync(path.join(destination, 'parse-v1/documents'), { recursive: true, force: true });
  }
  const summary = await parser.preparePdfDocument(bytes, {
    ...request, cache_dir: destination, expected_source_sha256: sha256,
  });
  const document = readGzip(path.join(destination, 'parse-v1/documents', `${summary.cacheKey}.json.gz`));
  const extractionRoot = path.join(destination, 'parse-v1/extractions');
  const cached = readdirSync(extractionRoot).filter(n => n.endsWith('.json.gz'))
    .map(n => readGzip(path.join(extractionRoot, n))).filter(v => v.source_sha256 === sha256);
  if (cached.length !== 1) throw new Error('Expected one matching native extraction cache');
  const pages = cached[0].extraction.pages;
  // Recognized geometry is retained in the final document, native typography in
  // the extraction cache. Its source IDs are the same IDs used by the structure.
  for (const recognized of document.recognized_pages ?? []) {
    if (!recognized.lines.length) continue;
    const page = pages[recognized.pageNumber - 1];
    page.source = recognized.source;
    page.lines = recognized.lines.map(line => ({
      id: line.id, text: line.text || line.words.map(w => w.text).join(' '), bbox: line.rect,
      spans: [], words: line.words.map(w => ({ text: w.text, bbox: w.rect })),
    }));
  }
  const result = {
    structure: document.structure, extraction: { source_sha256: sha256, pages },
    parser: { binary_sha256: binarySha256, cache_key: summary.cacheKey, request },
  };
  const filename = path.join(destination, `${mode}.json.gz`), temporary = `${filename}.${process.pid}.tmp`;
  try { writeFileSync(temporary, gzipSync(JSON.stringify(result))); renameSync(temporary, filename); }
  finally { rmSync(temporary, { force: true }); }
  return { file: filename, dump };
}

if (process.argv[2] === '--batch') {
  for (const { pdf, output, mode, requestFile } of JSON.parse(readFileSync(process.argv[3], 'utf8'))) {
    const began = performance.now();
    try {
      const { file, dump } = await extract(pdf, output, mode, requestFile);
      console.log(JSON.stringify({ pdf, mode, file, dump, ms: Math.round(performance.now() - began) }));
    } catch (error) {
      console.log(JSON.stringify({ pdf, mode, error: String(error?.message ?? error).slice(-600) }));
    }
  }
} else {
  const [pdf, output, mode = 'digitalborn', requestFile] = process.argv.slice(2);
  if (!pdf || !output) throw new Error('Usage: node extract.mjs PDF OUTPUT_DIRECTORY digitalborn|ocr [REQUEST.json]');
  console.log((await extract(pdf, output, mode, requestFile)).file);
}
