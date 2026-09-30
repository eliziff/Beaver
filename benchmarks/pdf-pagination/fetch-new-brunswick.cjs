// Sample original NBCA judgment PDFs across the court's monthly public indexes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const indexUrl = 'https://www.gnb.ca/content/cour/en/appeal/content/decisions.html';
const folder = path.resolve('tmp/pdf-pagination/canadian-new-brunswick-direct');
const pdfFolder = path.join(folder, 'pdfs');
const perMonth = Number(process.argv[process.argv.indexOf('--per-month') + 1] || 4);
if (!Number.isSafeInteger(perMonth) || perMonth < 1 || perMonth > 20)
  throw new Error('Use --per-month 1..20');
fs.mkdirSync(pdfFolder, { recursive: true });

async function get(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok || new URL(response.url).hostname !== 'www.gnb.ca')
    throw new Error(`Unexpected response ${response.status}: ${response.url}`);
  if (Number(response.headers.get('content-length')) > limit)
    throw new Error(`Response too large: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(`Response too large: ${url}`);
  return bytes;
}

(async () => {
  const index = (await get(indexUrl, 1_000_000)).toString('utf8');
  const listings = [...new Set([...index.matchAll(
    /href="([^"]*\/decisions\/202[456]\/[^"/]+\.html)"/g
  )].map(match => new URL(match[1], indexUrl).href))].sort();
  if (listings.length < 24) throw new Error('NBCA monthly index is incomplete');
  const results = [];
  for (const listingUrl of listings) {
    const html = (await get(listingUrl, 1_000_000)).toString('utf8');
    const candidates = [...html.matchAll(/<a\s+href="([^"]+\.pdf)">([^<]+)<\/a>/gi)]
      .map(([, href, label]) => ({
        citation: label.match(/20\d{2}\s+NBCA\s+\d+/i)?.[0],
        url: new URL(href, listingUrl).href,
      })).filter(row => row.citation &&
        /^https:\/\/www\.gnb\.ca\/content\/dam\/courts\/pdf\/appeal-appel\/decisions\/20\d{2}\//.test(row.url));
    for (const candidate of candidates.slice(0, perMonth)) {
      const receipt = path.join(folder, `${candidate.citation.replaceAll(' ', '-')}.json`);
      if (fs.existsSync(receipt)) {
        const prior = JSON.parse(fs.readFileSync(receipt));
        if (prior.outcome !== 'error' || !process.argv.includes('--retry-errors')) {
          results.push(prior);
          continue;
        }
      }
      let row = { ...candidate, court: 'NBCA', jurisdiction: 'CA',
        reporter: null, category: 'judgment', listingUrl };
      try {
        const bytes = await get(candidate.url, 20_000_000);
        if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Not a PDF');
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const filename = path.join(pdfFolder, `${sha256}.pdf`);
        if (!fs.existsSync(filename)) fs.writeFileSync(filename, bytes);
        row = { ...row, origin: 'original', outcome: 'original', sha256,
          bytes: bytes.length, path: filename };
      } catch (error) { row = { ...row, outcome: 'error', error: String(error) }; }
      fs.writeFileSync(receipt, JSON.stringify(row, null, 2));
      results.push(row);
      console.log(JSON.stringify({ citation: row.citation, outcome: row.outcome }));
    }
  }
  const uniqueResults = [...new Map(results.map(row => [row.citation, row])).values()];
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(uniqueResults, null, 2));
  console.log(JSON.stringify({ listings: listings.length,
    duplicateListings: results.length - uniqueResults.length,
    originals: uniqueResults.filter(r => r.outcome === 'original').length,
    errors: uniqueResults.filter(r => r.outcome === 'error').length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
