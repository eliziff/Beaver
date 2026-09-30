// Direct original judgment PDFs from Manitoba Courts' current public indexes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = 'https://www.manitobacourts.mb.ca';
const sources = [
  { court: 'MBCA', listingUrl: `${base}/court-of-appeal/recent-judgments/` },
  { court: 'MBKB', listingUrl: `${base}/court-of-queens-bench/recent-judgments/` },
];
const folder = path.resolve('tmp/pdf-pagination/canadian-manitoba-direct');
const pdfFolder = path.join(folder, 'pdfs');
fs.mkdirSync(pdfFolder, { recursive: true });
const index = process.argv.indexOf('--max-per-court');
const maxPerCourt = index < 0 ? 12 : Number(process.argv[index + 1]);
if (!Number.isSafeInteger(maxPerCourt) || maxPerCourt < 1 || maxPerCourt > 50)
  throw new Error('Use --max-per-court 1..50');
async function get(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  if (Number(response.headers.get('content-length')) > maxBytes)
    throw new Error(`Response too large: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Response too large: ${url}`);
  return bytes;
}
(async () => {
  const receipts = [];
  for (const source of sources) {
    const html = (await get(source.listingUrl, 1_000_000)).toString('utf8');
    const candidates = [];
    for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
      const row = match[1];
      const citation = row.match(new RegExp(`20\\d{2}\\s+${source.court}\\s+\\d+`, 'u'))?.[0];
      const link = row.match(/\bhref=["']([^"']+\.pdf)["']/iu)?.[1];
      if (!citation || !link) continue;
      const url = new URL(link.replaceAll('&amp;', '&'), source.listingUrl);
      if (url.hostname !== 'www.manitobacourts.mb.ca' ||
          !/^\/site\/assets\/files\/\d+\/[^/]+\.pdf$/iu.test(url.pathname))
        throw new Error(`Unexpected publisher link: ${url}`);
      candidates.push({ ...source, citation, url: url.toString() });
    }
    if (!candidates.length) throw new Error(`No judgment PDFs on ${source.listingUrl}`);
    for (const candidate of candidates.slice(0, maxPerCourt)) {
      const receipt = path.join(folder, `${candidate.citation.replaceAll(' ', '-')}.json`);
      if (fs.existsSync(receipt)) {
        receipts.push(JSON.parse(fs.readFileSync(receipt)));
        continue;
      }
      try {
        const bytes = await get(candidate.url, 20_000_000);
        if (bytes.subarray(0, 5).toString() !== '%PDF-')
          throw new Error('Publisher response is not a PDF');
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const filename = path.join(pdfFolder, `${sha256}.pdf`);
        fs.writeFileSync(filename, bytes);
        const row = { ...candidate, jurisdiction: 'CA', reporter: null,
          category: 'judgment', origin: 'original', outcome: 'original',
          sha256, bytes: bytes.length, path: filename, page_count: null };
        fs.writeFileSync(receipt, JSON.stringify(row, null, 2));
        receipts.push(row);
        console.log(JSON.stringify({ citation: row.citation, outcome: row.outcome,
          bytes: row.bytes }));
      } catch (error) {
        const row = { ...candidate, outcome: 'error', error: String(error) };
        fs.writeFileSync(receipt, JSON.stringify(row, null, 2));
        receipts.push(row);
        console.log(JSON.stringify(row));
        if (/HTTP 403/u.test(String(error))) break;
      }
    }
  }
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(receipts, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
