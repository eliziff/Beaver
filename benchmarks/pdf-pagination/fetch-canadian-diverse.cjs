// Acquire public original judgments through the production PDF downloader.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const out = path.resolve('tmp/pdf-pagination');
process.env.MIKE_LOCAL_DATA_DIR = path.join(out, 'authorities-store');
const { downloadProviderOriginalPdf, PublisherVerificationRequired } =
  require('../../backend/dist/lib/providerPdfLibraryBridge');
const { PDFDocument } = require('../../backend/node_modules/pdf-lib');
const reporters = process.argv.includes('--reporters');
const rows = JSON.parse(fs.readFileSync(path.join(out, reporters
  ? 'canadian-reporter-fetch-candidates.json' : 'canadian-diverse-candidates.json')));
const folder = path.join(out, reporters ? 'canadian-reporter-originals' : 'canadian-diverse-originals');
const pdfFolder = path.join(folder, 'pdfs');
fs.mkdirSync(pdfFolder, { recursive: true });
const manifestFile = path.join(folder, 'manifest.json');
const cachedOriginals = fs.existsSync(manifestFile)
  ? JSON.parse(fs.readFileSync(manifestFile)).filter(row => row.outcome === 'original' && row.sourceReceipt)
  : [];
const batchArgument = process.argv.indexOf('--max-new');
const maxNew = batchArgument < 0 ? 20 : Number(process.argv[batchArgument + 1]);
if (!Number.isSafeInteger(maxNew) || maxNew < 1) throw new Error('Use --max-new POSITIVE_INTEGER');
const serviceArgument = process.argv.indexOf('--service');
const service = serviceArgument < 0 ? null : process.argv[serviceArgument + 1];
if (serviceArgument >= 0 && !service) throw new Error('Use --service WORKER_URL');

async function acquire(row) {
  const language = /\/fr\/item\//.test(row.sourceUrl) ? 'fr' : 'en';
  const request = { provider: 'a2aj', identity: `a2aj:document:${row.id}`,
    sourceUrl: row.sourceUrl, filename: `${row.id}.pdf`, title: row.citation,
    source: { provider: 'a2aj', id: row.citation, kind: 'case', citation: row.citation,
      title: row.citation, collection: row.court, language, url: row.sourceUrl } };
  try {
    const signal = AbortSignal.timeout(90_000);
    let original;
    if (service) {
      const { retrievePdf } = await import('../../AuthoritiesHelper/modern/authorities-lite/client.mjs');
      const bytes = Buffer.from(await retrievePdf(row.sourceUrl, { url: service }, () => {}, signal));
      original = { bytes, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), url: row.sourceUrl };
    } else original = await downloadProviderOriginalPdf(request, signal);
    if (!original) return { ...row, outcome: 'no_published_pdf' };
    if (original.bytes.subarray(0, 5).toString() !== '%PDF-')
      throw new Error('Publisher response is not a PDF');
    const sha256 = crypto.createHash('sha256').update(original.bytes).digest('hex');
    if (sha256 !== original.sourceSha256) throw new Error('Source digest mismatch');
    const filename = path.join(pdfFolder, `${sha256}.pdf`);
    if (!fs.existsSync(filename)) fs.writeFileSync(filename, original.bytes);
    let pageCount, parseError;
    try { pageCount = (await PDFDocument.load(original.bytes,
      { updateMetadata: false, ignoreEncryption: true })).getPageCount(); }
    catch (error) { parseError = String(error); }
    return { ...row, outcome: 'original', origin: 'original', sha256,
      path: filename, url: original.url, page_count: pageCount ?? null,
      ...(service ? { retrievalService: service } : {}),
      ...(parseError ? { parseError } : {}) };
  } catch (error) {
    if (error.code === 'pdf_not_found') return { ...row, outcome: 'no_published_pdf' };
    if (error.code === 'verification_required')
      return { ...row, outcome: 'challenge', verificationUrl: error.verificationUrl };
    if (error instanceof PublisherVerificationRequired)
      return { ...row, outcome: 'challenge', verificationUrl: error.pageUrl };
    return { ...row, outcome: 'error', error: String(error) };
  }
}

(async () => {
  const blocked = new Set(), receipts = [], originals = new Set();
  let fresh = 0;
  for (const row of rows) {
    const host = new URL(row.sourceUrl).hostname;
    const receipt = path.join(folder, `case-${row.id}.json`);
    const prior = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt)) : null;
    if (blocked.has(host) && !prior) continue;
    const retry = process.argv.includes('--retry-errors') && prior?.outcome === 'error' ||
      process.argv.includes('--retry-challenges') && prior?.outcome === 'challenge';
    if (!prior && fresh >= maxNew) continue;
    const shouldAcquire = (!prior || retry) && fresh < maxNew;
    const result = shouldAcquire ? await acquire(row) : prior;
    if (shouldAcquire) {
      fs.writeFileSync(receipt, JSON.stringify(result, null, 2)); fresh++;
      console.log(JSON.stringify({ id: row.id, court: row.court, outcome: result.outcome,
        pages: result.page_count, verificationUrl: result.verificationUrl, error: result.error }));
    }
    receipts.push(result);
    if (result.outcome === 'challenge') blocked.add(host);
    if (result.outcome === 'original') originals.add(result.sha256);
    if (originals.size >= (reporters ? 350 : 100)) break;
  }
  const present = new Set(receipts.map(row => row.sha256).filter(Boolean));
  receipts.push(...cachedOriginals.filter(row => !present.has(row.sha256)));
  fs.writeFileSync(manifestFile, JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify({ fresh, uniqueOriginals: originals.size,
    outcomes: receipts.reduce((counts, row) => {
      counts[row.outcome] = (counts[row.outcome] ?? 0) + 1; return counts;
    }, {}), blockedHosts: [...blocked] }));
})().catch(error => { console.error(error); process.exitCode = 1; });
