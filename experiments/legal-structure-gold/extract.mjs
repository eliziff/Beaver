// Export the installed parser's paired structure and extraction witnesses. No build.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { defaultNativeAddon, nativeAddonFile } from '../../shared/nativeAddonFile.mjs';
import { structureEngineAddon } from '../../shared/structure-engine.mjs';

const [pdf, output, mode = 'digitalborn', requestFile] = process.argv.slice(2);
if (!pdf || !output || !['digitalborn', 'ocr'].includes(mode))
  throw new Error('Usage: node extract.mjs PDF OUTPUT_DIRECTORY digitalborn|ocr');
const root = path.resolve(import.meta.dirname, '../..');
const addonRoot = path.join(root, 'native/legal-structure-node');
// LEGAL_STRUCTURE_ADDON pins one built addon while other builds replace the newest.
const binary = process.env.LEGAL_STRUCTURE_ADDON || defaultNativeAddon(addonRoot);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(pdf), sha256 = hash(bytes), binarySha256 = hash(readFileSync(binary));
// Parse as the app does: its configured profile, which routes pages to OCR itself.
process.env.LEGALPDF_ENGINE_ROOT ||= path.join(root, 'legal-pdf-parser');
const request = requestFile ? JSON.parse(readFileSync(requestFile, 'utf8')) :
  { kind: 'pdf', ...(await import('../../backend/src/lib/pdfProfile.ts')).profileFor(undefined, undefined) };
const destination = path.resolve(output, sha256, binarySha256, hash(JSON.stringify(request)).slice(0,16));
mkdirSync(destination, { recursive: true });
const module = { exports: {} };
process.dlopen(module, nativeAddonFile(binary, addonRoot));
const parser = structureEngineAddon(module.exports, { toBuffer: bytes => Buffer.from(bytes) });
const summary = await parser.preparePdfDocument(bytes, {
  ...request, cache_dir: destination, expected_source_sha256: sha256,
});
const readGzip = filename => JSON.parse(gunzipSync(readFileSync(filename)));
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
console.log(filename);
