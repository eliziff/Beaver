// Official current ABCA judgment PDFs, kept separate from reporter-original SCC cases.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const listingUrl = 'https://albertacourts.ca/ca/publications/recent-judgments';
const folder = path.resolve('tmp/pdf-pagination/canadian-official-direct');
const pdfFolder = path.join(folder, 'pdfs');
fs.mkdirSync(pdfFolder, { recursive: true });
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
  const listing = (await get(listingUrl, 1_000_000)).toString('utf8');
  const details = [...new Set([...listing.matchAll(
    /\bhref=["']([^"']*recent-judgments\/[^"']+)["']/giu
  )].map(match => new URL(match[1], listingUrl).toString()))].slice(0, 8);
  if (!details.length) throw new Error('No official recent-judgment links found');
  const rows = [];
  for (const sourceUrl of details) {
    const html = (await get(sourceUrl, 1_000_000)).toString('utf8');
    const citation = html.match(/20\d{2}\s+ABCA\s+\d+/u)?.[0] ?? null;
    const links = [...html.matchAll(/\bhref=["']([^"']+\.pdf(?:\?[^"']*)?)["']/giu)]
      .map(match => new URL(match[1].replaceAll('&amp;', '&'), sourceUrl));
    const pdf = links.find(url => /^(?:www\.)?albertacourts\.ca$/iu.test(url.hostname)
      && /^\/docs\/default-source\/ca\/20\d{2}abca\d+\.pdf$/iu.test(url.pathname));
    if (!citation || !pdf) throw new Error(`Judgment PDF unavailable: ${sourceUrl}`);
    const receipt = path.join(folder, `${citation.replaceAll(' ', '-')}.json`);
    if (fs.existsSync(receipt)) {
      rows.push(JSON.parse(fs.readFileSync(receipt)));
      continue;
    }
    try {
      const bytes = await get(pdf, 20_000_000);
      if (bytes.subarray(0, 5).toString() !== '%PDF-')
        throw new Error('Publisher response is not a PDF');
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const filename = path.join(pdfFolder, `${sha256}.pdf`);
      fs.writeFileSync(filename, bytes);
      const row = { citation, court: 'ABCA', jurisdiction: 'CA',
        origin: 'original', outcome: 'original', category: 'judgment',
        reporter: null, listingUrl, sourceUrl, url: pdf.toString(),
        sha256, bytes: bytes.length, path: filename, page_count: null };
      fs.writeFileSync(receipt, JSON.stringify(row, null, 2));
      rows.push(row);
      console.log(JSON.stringify({ citation, outcome: row.outcome, bytes: row.bytes }));
    } catch (error) {
      const row = { citation, court: 'ABCA', listingUrl, sourceUrl,
        url: pdf.toString(), outcome: 'error', error: String(error) };
      fs.writeFileSync(receipt, JSON.stringify(row, null, 2));
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(rows, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
