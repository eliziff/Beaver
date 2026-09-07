// Production-build browser probe of the real PDF.js transport and document route.
// No model, native parser, cloud services or user documents.
// node scripts/test-pdf-range-loading.mjs [REPORT_DIR]; CHROMIUM_PATH selects Chromium.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = path.join(repo, 'frontend');
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const require = createRequire(path.join(repo, 'backend/package.json'));
require('tsx/cjs');
const express = require('express');
const { PDFDocument, PDFRawStream, StandardFonts } = require('pdf-lib');
const { chromium } = createRequire(path.join(repo, 'package.json'))('playwright');
const { build } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
const react = (await import(pathToFileURL(frontendRequire.resolve('@vitejs/plugin-react')).href)).default;
const output = path.resolve(process.argv[2] || path.join(repo, '.perf/pdf-ranges'));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'beaver-pdf-range-'));
process.env.AUTH_MODE = 'local'; process.env.MIKE_LOCAL_DATA_DIR = temporary;
const { createDocumentApplication } = require(path.join(repo, 'backend/src/lib/documentApplication.ts'));
const { documentRepository } = require(path.join(repo, 'backend/src/lib/relationalDocumentRepository.ts'));
const { createFilesystemObjectStorage } = require(path.join(repo, 'backend/src/lib/storage.ts'));
const { createDocumentsRouter } = require(path.join(repo, 'backend/src/routes/documentRoutes.ts'));
const { closeRelationalDatabase } = require(path.join(repo, 'backend/src/lib/relationalDatabase.ts'));
const objects = createFilesystemObjectStorage(path.join(temporary, 'objects'));
let blobReads = 0;
const get = objects.get.bind(objects); objects.get = key => { blobReads++; return get(key); };
const documents = createDocumentApplication(documentRepository, objects);
const owner = { userId: '00000000-0000-0000-0000-000000000001' };
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
// Keep page dictionaries together: range benefits depend on PDF object layout.
// Interleaved, large page dictionaries can require most chunks even to open.
const pages = Array.from({ length: 100 }, () => pdf.addPage([612, 792]));
for (let n = 1; n <= pages.length; n++) {
  const page = pages[n - 1];
  page.drawText(`Range transport page ${n}`, { x: 60, y: 710, size: 20, font });
  page.drawText('This page is readable before the entire document is transferred.', { x: 60, y: 675, size: 12, font });
  // Legal PDF comments make independently skippable, uncompressed stream bodies.
  // This is a controlled transfer fixture, not a natural-document size benchmark.
  const stream = PDFRawStream.of(pdf.context.obj({}), Buffer.from('% controlled fixture padding '.repeat(2400) + '\n'));
  page.node.addContentStream(pdf.context.register(stream));
}
const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
const doc = await documents.create(owner, { filename: 'Range fixture.pdf', fileType: 'pdf', bytes });
blobReads = 0;
const entry = await mkdtemp(path.join(frontend, '.pdf-range-'));
const dist = path.join(output, 'dist');
let server, browser;
const report = { bytes: bytes.length, checks: {}, requests: [], browserErrors: [] };
try {
  await writeFile(path.join(entry, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>');
  await writeFile(path.join(entry, 'main.tsx'), `
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PdfView } from '@/app/components/shared/views/PdfView';
import '@/app/globals.css';
function App() {
  const full = new URLSearchParams(location.search).has('full');
  const [bytes, setBytes] = useState();
  useEffect(() => { if (full) fetch('/full.pdf').then(r => r.arrayBuffer()).then(b => setBytes(new Uint8Array(b))); }, []);
  return <main style={{height:'100vh',display:'flex',flexDirection:'column'}}><PdfView
    doc={full ? null : {document_id:${JSON.stringify(doc.id)}, version_id:${JSON.stringify(doc.current_version_id)}}}
    bytes={bytes} loading={full && !bytes} /></main>;
}
createRoot(document.getElementById('root')).render(<App/>);`);
  await build({ root: frontend, configFile: false, plugins: [react()], resolve: { alias: { '@': path.join(frontend, 'src') } },
    build: { outDir: dist, emptyOutDir: true, modulePreload: { polyfill: false },
      rolldownOptions: { input: path.join(entry, 'index.html'), output: { strictExecutionOrder: true } } } });
  await cp(path.join(frontendRequire.resolve('pdfjs-dist/package.json'), '../standard_fonts'), path.join(dist, 'pdfjs-standard-fonts'), { recursive: true });
  const app = express();
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();
    if (req.path.startsWith('/api/')) res.on('finish', () => report.requests.push({ range: req.get('range'),
      ifMatch: req.get('if-match'), status: res.statusCode, bytes: Number(res.get('content-length') || 0) }));
    next();
  });
  app.get('/full.pdf', (_req, res) => res.type('pdf').send(bytes));
  app.use('/api/single-documents', createDocumentsRouter({}, documents));
  app.use(express.static(dist, { dotfiles: "allow" }));
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1080, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  const address = `${origin}/${path.basename(entry)}/index.html`;
  await page.goto(address);
  const first = page.locator('[data-page-number="1"] canvas');
  await first.waitFor();
  await page.getByText('Range transport page 1', { exact: true }).waitFor();
  const firstBitmap = await first.evaluate(canvas => canvas.toDataURL());
  const transferred = report.requests.filter(r => r.status === 206).reduce((sum, r) => sum + r.bytes, 0);
  assert.ok(transferred > 0 && transferred < bytes.length / 2, 'First page must precede most file transfer');
  assert.ok(report.requests.every(r => r.status === 206), 'Range loading must use real partial responses');
  assert.equal(blobReads, 1, 'Serving chunks must not repeatedly fetch/hash the entire blob');
  report.checks.firstPage = { transferredBytes: transferred, fileBytes: bytes.length, blobReads };
  await page.screenshot({ path: path.join(output, 'first-page-partial-transfer.png') });
  // Ordinary readers use scrolling; the editable page-number field is editor-only.
  const jump = number => page.locator(`[data-page-number="${number}"]`).evaluate(el => el.scrollIntoView({ block: 'start' }));
  await jump(75);
  await page.locator('[data-page-number="75"] canvas').waitFor();
  await page.getByText('Range transport page 75', { exact: true }).waitFor();
  assert.equal(blobReads, 1);
  assert.ok(report.requests.slice(1).every(r => /^"[a-f0-9]{64}"$/.test(r.ifMatch)), 'Subsequent chunks pin the exact representation');
  report.checks.deepPage = true;
  // Delete through the real store while the browser still holds a range session.
  await documents.deleteDocument(owner, doc.id);
  await jump(50);
  await page.locator('[role="alert"]').waitFor();
  assert.equal(await page.locator('[data-page-number]').count(), 0, 'Revocation failure removes old rendered content');
  report.checks.deletedDuringSession = true;
  await page.screenshot({ path: path.join(output, 'deleted-document-error.png') });
  await page.goto(`${address}?full`);
  await first.waitFor();
  assert.equal(await first.evaluate(canvas => canvas.toDataURL()), firstBitmap, 'Partial/full bytes yield identical raster output');
  report.checks.bitmapIdentical = true;
  assert.deepEqual(report.browserErrors, []);
  await context.close();
  console.log(JSON.stringify(report, null, 2));
} catch (error) { report.failure = error.stack; throw error; }
finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await closeRelationalDatabase();
  await rm(entry, { recursive: true, force: true }); await rm(temporary, { recursive: true, force: true });
}
