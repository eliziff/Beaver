// Export the installed parser's paired structure and extraction witnesses. No build.
//   node extract.mjs PDF OUTPUT_DIRECTORY digitalborn|ocr [REQUEST.json]   one PDF; prints its file
//   node extract.mjs --batch JOBS.json   many PDFs with the addon loaded once; JOBS is a list of
//     {pdf, output, mode, requestFile}; prints one JSON line per job, {pdf, mode, file, ms} or
//     {pdf, mode, error}.
// LEGAL_STRUCTURE_ADDON pins one built addon. LAYOUT_PACK (with LAYOUT_RUNTIME) parses with the
// ppdoc layout provider, cached beside the plain request. Each document's structure-engine inputs
// and witnesses are filed with its cached document, for engine replay and the composition search.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync, existsSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { createInterface } from 'node:readline';
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
  // The parse's witnesses, written as the structure stage runs and filed with the document it
  // derives, so a cached document keeps them.
  const fresh = { witnesses: path.join(destination, `witnesses-${mode}.jsonl`) };
  rmSync(fresh.witnesses, { force: true });
  // Dumps are written where asked (DUMP=1, the run a search starts from): every structure stage
  // pays for them otherwise.
  if (process.env.DUMP === '1') process.env.LEGALPDF_WITNESS_DUMP = fresh.witnesses;
  else delete process.env.LEGALPDF_WITNESS_DUMP;
  const parseStart = performance.now();
  // A build's parse cache is its own; the source's OCR is cached once beside them all, so no
  // rebuild OCRs a page again.
  const summary = await parser.preparePdfDocument(bytes, {
    ...request, cache_dir: destination, ocr_cache_dir: path.resolve(output, sha256, 'ocr'), expected_source_sha256: sha256,
  });
  const parseMs = performance.now() - parseStart;
  const documents = path.join(destination, 'parse-v1/documents');
  const filed = { witnesses: path.join(documents, `${summary.cacheKey}.witnesses.jsonl`) };
  try { renameSync(fresh.witnesses, filed.witnesses); } catch { /* a cached document: its dump is filed already */ }
  const witnesses = existsSync(filed.witnesses) ? filed.witnesses : null;
  const document = readGzip(path.join(documents, `${summary.cacheKey}.json.gz`));
  const extractionRoot = path.join(destination, 'parse-v1/extractions');
  // The extraction this parse used: an earlier build's, carried forward, may lie beside it under
  // another code's key; the parser touches the one it reads or writes.
  const newest = readdirSync(extractionRoot).filter(n => n.endsWith('.json.gz'))
    .map(n => ({ n, at: statSync(path.join(extractionRoot, n)).mtimeMs })).sort((a, b) => b.at - a.at)
    .map(({ n }) => readGzip(path.join(extractionRoot, n))).find(v => v.source_sha256 === sha256);
  if (!newest) throw new Error('Expected a matching native extraction cache');
  const pages = newest.extraction.pages;
  // Recognized geometry is retained in the final document, native typography in
  // the extraction cache. Its source IDs are the same IDs used by the structure.
  const exported = ({ rect, words, ...line }) => ({
    ...line, text: line.text ?? '', bbox: rect, words: (words ?? []).map(({ rect, ...word }) => ({ ...word, bbox: rect })),
  });
  for (const recognized of document.recognized_pages ?? []) {
    if (!recognized.lines.length) continue;
    const page = pages[recognized.pageNumber - 1];
    page.source = recognized.source;
    page.regions = recognized.regions ?? [];
    page.lines = recognized.lines.map(exported);
  }
  // A native page can also hold recognized lines (the text of an image on it, such as a scanner's
  // logo); the structure names them, so the page carries them beside its native lines.
  for (const passage of document.passage_pages ?? []) {
    const page = pages[passage.pageNumber - 1], known = new Set(page.lines.map(line => line.id));
    page.lines.push(...passage.lines.filter(line => !known.has(line.id)).map(exported));
  }
  const result = {
    structure: document.structure, extraction: { source_sha256: sha256, pages },
    parser: { binary_sha256: binarySha256, cache_key: summary.cacheKey, request },
  };
  const filename = path.join(destination, `${mode}.json.gz`), temporary = `${filename}.${process.pid}.tmp`;
  try { writeFileSync(temporary, gzipSync(JSON.stringify(result))); renameSync(temporary, filename); }
  finally { rmSync(temporary, { force: true }); }
  return { file: filename, witnesses, parseMs: Math.round(parseMs) };
}

if (process.argv[2] === '--batch') {
  for (const { pdf, output, mode, requestFile } of JSON.parse(readFileSync(process.argv[3], 'utf8'))) {
    const began = performance.now();
    try {
      const { file, dump, witnesses, parseMs } = await extract(pdf, output, mode, requestFile);
      console.log(JSON.stringify({ pdf, mode, file, dump, witnesses, parseMs, ms: Math.round(performance.now() - began) }));
    } catch (error) {
      console.log(JSON.stringify({ pdf, mode, error: String(error?.message ?? error).slice(-600) }));
    }
  }
} else {
  const [pdf, output, mode = 'digitalborn', requestFile] = process.argv.slice(2);
  if (!pdf || !output) throw new Error('Usage: node extract.mjs PDF OUTPUT_DIRECTORY digitalborn|ocr [REQUEST.json]');
  console.log((await extract(pdf, output, mode, requestFile)).file);
}
