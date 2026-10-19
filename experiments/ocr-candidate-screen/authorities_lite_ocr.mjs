import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';

const [htmlArg, outputArg] = process.argv.slice(2);
assert(htmlArg && outputArg, 'usage: authorities_lite_ocr.mjs Authorities-lite.html OUTPUT');
const html = path.resolve(htmlArg), output = path.resolve(outputArg);
mkdirSync(output, { recursive: true });
const owner = createRequire(new URL('../../legal-browser-ocr/package.json', import.meta.url));
const { createCanvas } = owner('@napi-rs/canvas');
const { getDocument } = await import(pathToFileURL(owner.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
// Independently invented text, rendered as an image-only PDF; no corpus or real case facts.
const text = ['Northlake Observatory Society', '2032 ABKB 731',
  '[1] Four astronomy clubs borrowed one weather balloon.',
  'The blue locker held a brass lens and three empty notebooks.',
  '[2] Saturday observing time belonged to the western telescope.',
  'The schedule allowed visitors to bring ordinary thermometers.',
  '[3] The disputed key opened a drawer beneath the notice board.',
  'No club had agreed to exchange its spare instruments.',
  '[4] The appeal is dismissed. Each club must label its own boxes.'];
const canvas = createCanvas(1224, 1584), context = canvas.getContext('2d');
context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = 'black'; context.font = '30px serif';
text.forEach((line, index) => context.fillText(line, 90, 110 + index * 65));
const png = canvas.toBuffer('image/png');
writeFileSync(path.join(output, 'synthetic-scan.png'), png);
writeFileSync(path.join(output, 'synthetic-gold.txt'), text.join('\n') + '\n');
const pdf = await PDFDocument.create(), image = await pdf.embedPng(png);
pdf.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
const input = await pdf.save();
writeFileSync(path.join(output, 'synthetic-scan.pdf'), input);
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
try {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => Object.defineProperty(navigator, 'gpu', { get: () => undefined }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(90000);
  await page.goto(pathToFileURL(html).href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'List of citations' }).fill('2032 ABKB 731 at para 1');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await (await chooser).setFiles({ name: '2032abkb731.pdf', mimeType: 'application/pdf', buffer: Buffer.from(input) });
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.locator('#page-wrap .textLayer span').first().waitFor();
  const recognized = (await page.locator('#page-wrap .textLayer').allTextContents()).join(' ');
  for (const word of ['balloon', 'notebooks', 'telescope']) assert(recognized.toLowerCase().includes(word), `OCR missed ${word}`);
  await page.screenshot({ path: path.join(output, 'lite.png') });
  const downloading = page.waitForEvent('download');
  await page.locator('#viewer-download').click();
  const download = await downloading;
  await download.saveAs(path.join(output, 'searchable.pdf'));
  const exported = await getDocument({ data: new Uint8Array(readFileSync(path.join(output, 'searchable.pdf'))) }).promise;
  try {
    assert.equal(exported.numPages, 1);
    const content = await (await exported.getPage(1)).getTextContent();
    const text = content.items.filter(item => 'str' in item).map(item => item.str).join(' ');
    for (const word of ['balloon', 'notebooks', 'telescope']) assert(text.toLowerCase().includes(word), `PDF export lost ${word}`);
  } finally { await exported.destroy(); }
  assert.deepEqual(errors, []);
  const result = { origin: 'machine_test', run_id: randomUUID(), html_sha256: createHash('sha256').update(readFileSync(html)).digest('hex'),
    input_sha256: createHash('sha256').update(input).digest('hex'), offline_cpu_ocr: true, searchable_pdf_roundtrip: true };
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
