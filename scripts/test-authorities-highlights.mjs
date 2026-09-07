/** Real PDF.js pointer/keyboard interaction -> native geometry -> editable PDF export. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'backend/package.json'));
const express = require('express'), pdf = require('pdf-lib');
const { structureNative, pdfPassageGeometry } = require('../backend/dist/lib/structureNative');
const { prepareAuthorityAnnotations, buildAuthorities } = require('../backend/dist/lib/authoritiesBuild');
const { reduceAuthoritiesDraft } = require('../backend/dist/lib/authoritiesDomain');
const output = path.resolve(process.env.AUTHORITIES_HIGHLIGHT_OUTPUT || '/tmp/authorities-highlight-results');
await mkdir(output, { recursive: true });
const api = express(); api.use(express.json({ limit: '20mb' }));
let preparations = 0;
api.post('/prepare', async (req, res, next) => {
  try {
    const { product, authorityId, bindingRole } = req.body, bytes = Buffer.from(req.body.bytes, 'base64');
    const authority = product.state.authorities[authorityId], source = authority.source.sources.find(s => s.bindingRole === bindingRole);
    const document = await pdf.PDFDocument.load(bytes), native = await structureNative().derivePdfDocument(bytes, {});
    const targets = authorityId === 'text' ? [{ id: '42', locatorKind: 'paragraph', locator: '42',
      exactQuotes: ['First independent quote', 'Second independent quote'] }] : [];
    const passageGeometry = targets.length ? await pdfPassageGeometry(native, bytes, targets) : undefined;
    preparations++;
    res.json(prepareAuthorityAnnotations(pdf, document, product.state, authority, source, { passageGeometry }, true));
  } catch (error) { next(error); }
});
// Real deterministic findings, so the dialog can only show what the backend actually produces.
const { findAuthoritiesDiscrepancies } = require('../backend/dist/lib/authoritiesDiscrepancy');
function quotationFindings(id, body, pinpoint, cited) {
  const note = `2024 SCC 1 at para ${pinpoint}`;
  const occurrence = { id, unitId: 'footnote:1', start: 0, end: note.length, text: note,
    authoritySpan: { start: 0, end: note.length, text: note },
    coreSpan: { start: 0, end: 10, text: '2024 SCC 1' },
    pinpointSpan: { start: note.indexOf(pinpoint), end: note.length, text: pinpoint },
    kind: 'case', citation: '2024 SCC 1', authorityId: 'text', reference: null,
    pinpoints: [{ kind: 'paragraph', text: pinpoint }], evidenceIds: [],
    sourceTextSha256: 'a'.repeat(64), localOrdinal: 0, reviewed: true };
  const draft = { occurrences: { [id]: occurrence }, units: [
    { id: 'body:1', kind: 'body', ordinal: 1, footnoteId: null, footnoteRefs: [[1, body.length]],
      pageNumbers: [], text: body, occurrenceIds: [] },
    { id: 'footnote:1', kind: 'footnote', ordinal: 1, footnoteId: 1, footnoteRefs: [],
      pageNumbers: [], text: note, occurrenceIds: [id] }] };
  const locator = { kind: 'paragraph', label: pinpoint };
  return findAuthoritiesDiscrepancies(draft, [{ occurrenceId: id, sourceVersion: 'b'.repeat(64),
    cited: { locator, text: cited }, alternatives: [{ locator, text: cited }] }]);
}
const quotationCases = {
  // The owner's report: the authored trailing comma is not a wording difference.
  ownerComma: quotationFindings('owner', 'It imposes "a regime of strict liability," on the operator.', '65',
    'The Court held that this is a regime of strict liability for example, and the appellant cannot escape it.'),
  diacritics: quotationFindings('accents', 'The court wrote “Le défendeur a agi de bonne foi — sans erreur”.', '12',
    'Au paragraphe 12: le defendeur a agi de bonne foi - sans erreur, dit la Cour.'),
  difference: quotationFindings('wording',
    'The Board explained that "the landlord may deliver a written notice to terminate the lease within seven calendar days" before any hearing may be scheduled.', '42',
    'If rent is unpaid, the landlord may deliver a written notice to terminate the lease not less than seven business days after receipt of the notice by the tenant.'),
  missingOne: quotationFindings('missing-1', 'The panel confirmed that "the deadline is seven business days" in every case.', '43',
    'A different paragraph begins.'),
  missingTwo: quotationFindings('missing-2', 'It added that "an operator bears the whole of the risk" without exception.', '44',
    'Nothing in these reasons addresses the allocation of commercial risk between parties.'),
};
api.get('/discrepancies', (_req, res) => res.json([...quotationCases.difference,
  ...quotationCases.missingOne, ...quotationCases.missingTwo]));
api.post('/save', (req, res, next) => {
  try {
    const { product, action, revision } = req.body;
    assert.equal(product.revision, revision);
    res.json({ ...product, revision: revision + 1, state: reduceAuthoritiesDraft(product.state, action) });
  } catch (error) { next(error); }
});
api.post('/build', async (req, res, next) => {
  try {
    const { product, files } = req.body;
    const built = await buildAuthorities({ draft: product.state, title: product.title,
      workProduct: { id: product.id, revision: product.revision },
      sources: Object.fromEntries(Object.entries(files).map(([role, bytes]) => [role, { bytes: Buffer.from(bytes, 'base64') }])) });
    res.type('application/pdf').send(built.artifacts.book.bytes);
  } catch (error) { next(error); }
});
api.use((error, _req, res, _next) => { console.error(error); res.status(500).send(error.message); });
const server = await createServer({ root: path.join(root, 'frontend'), server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'annotation-test-api', configureServer(server) { server.middlewares.use('/api/test-annotations', api); } }] });
let browser, page;
try {
  await server.listen(); const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/tests/authorities-highlights/`);
  await page.getByRole('button', { name: 'Edit in PDF' }).click();
  const cards = page.getByRole('complementary', { name: 'Highlights' }).locator('li');
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toContainText('First independent quote');
  assert.equal(await page.getByRole('combobox', { name: 'Remove highlighting' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /regenerate/i }).count(), 0);
  await cards.nth(1).locator('button').first().click();
  const wrapper = page.locator('[data-page-number="2"]');
  await expect(wrapper.locator('canvas')).toBeVisible();
  const canvasSize = await wrapper.locator('canvas').evaluate(node => ({ pixels: node.width, css: node.clientWidth }));
  assert.ok(canvasSize.pixels >= canvasSize.css * 1.9, 'Render at device resolution');
  assert.ok((await cards.first().boundingBox()).height < 90, 'Cards must remain compact');
  const margin = await wrapper.locator('svg g').first().locator('rect').evaluate(node => ({ x: +node.getAttribute('x'), height: +node.getAttribute('height') }));
  assert.ok(margin.x < 72 / 612 && margin.height > 30 / 792, 'Left line covers both sentences');
  await page.screenshot({ path: path.join(output, 'highlights-desktop.png') });
  // Click a rendered mark and delete it, rather than using an erase mode.
  const rect = await wrapper.locator('svg g').nth(2).locator('rect').boundingBox();
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.press('Delete'); await expect(cards).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(cards).toHaveCount(3);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(cards).toHaveCount(2);
  // A real text selection produces exact line fragments and an excerpt.
  await page.getByRole('button', { name: 'Highlight text', exact: true }).click();
  const text = wrapper.locator('.pdf-text-layer span').filter({ hasText: 'Uncited passage on page 2.' }).first();
  await text.scrollIntoViewIfNeeded(); const box = await text.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
  await expect(cards).toHaveCount(3); await expect(cards.last()).toContainText('Uncited passage');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await page.getByRole('button', { name: 'Edit in PDF' }).click();
  await expect(cards).toHaveCount(3); assert.equal(preparations, 1, 'Reopening must not regenerate reviewed marks');
  // A scanned PDF still supports arbitrary manual rectangle highlights.
  await page.getByRole('combobox', { name: 'Authority PDF' }).selectOption('scan-en');
  const scanPage = page.locator('[data-page-number="1"]'); await expect(scanPage.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Draw highlight', exact: true }).click();
  const scanBox = await scanPage.boundingBox();
  await page.mouse.move(scanBox.x + 60, scanBox.y + 250); await page.mouse.down();
  await page.mouse.move(scanBox.x + 260, scanBox.y + 290, { steps: 5 }); await page.mouse.up();
  await expect(cards).toHaveCount(1);
  await page.getByRole('button', { name: 'Save and close' }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Build test book' }).click();
  const exported = await download; await exported.saveAs(path.join(output, 'highlight-export.pdf'));
  const { readFile } = await import('node:fs/promises');
  const book = await pdf.PDFDocument.load(await readFile(path.join(output, 'highlight-export.pdf')));
  const annotations = book.getPages().flatMap(p => p.node.lookupMaybe(pdf.PDFName.of('Annots'), pdf.PDFArray)?.asArray()
    .map(ref => book.context.lookup(ref, pdf.PDFDict)) ?? []);
  assert.ok(annotations.some(a => a.get(pdf.PDFName.of('Subtype'))?.toString() === '/Highlight'));
  assert.ok(annotations.some(a => a.get(pdf.PDFName.of('QuadPoints'))));
  await page.getByRole('button', { name: 'Edit in PDF' }).click(); await expect(cards).toHaveCount(3);
  while (await cards.count()) await cards.first().getByRole('button', { name: /^Delete / }).click();
  await page.getByRole('button', { name: 'Save and close' }).click();
  const beforeReopen = preparations;
  await page.getByRole('button', { name: 'Edit in PDF' }).click(); await expect(cards).toHaveCount(0);
  assert.equal(preparations, beforeReopen, 'A deliberately empty set stays empty');
  await page.getByRole('button', { name: 'Save and close' }).click();
  // Meaningless differences never reach the dialog at all.
  assert.deepEqual(quotationCases.ownerComma, [], 'A quote the cited passage contains is not a finding');
  assert.deepEqual(quotationCases.diacritics, [], 'Diacritics, case and dashes are not differences');
  assert.equal(quotationCases.difference.length, 1);
  // The review is an inline step: the same section element survives recheck and completion.
  await page.getByRole('button', { name: 'Review test quotations' }).click();
  const panel = page.getByRole('region', { name: 'Check quotations' });
  assert.equal(await page.getByRole('dialog').count(), 0, 'The review is a step, not a modal');
  await panel.evaluate(node => { node.dataset.reviewIdentity = 'same-section'; });
  await expect(panel.getByText('1 / 2')).toBeVisible();
  await expect(panel.getByText(/The Board explained that/)).toBeVisible();
  await page.screenshot({ path: path.join(output, 'quotation-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'quotation-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('radio', { name: 'Use the source wording (edits your .docx)' }).check();
  await page.getByRole('button', { name: 'Apply correction' }).click();
  // The two quotations that were not found are one batch, with no per-quote decision.
  await expect(panel.getByRole('list').locator('li')).toHaveCount(2);
  assert.equal(await panel.getByRole('radio').count(), 0, 'No adjudication for unfound quotations');
  assert.equal(await panel.locator('ins,del').count(), 0);
  await expect(panel).toHaveAttribute('data-review-identity', 'same-section');
  await page.screenshot({ path: path.join(output, 'quotation-unlocated.png') });
  // Open source is a button, and it lands the PDF on the paragraph the quotation is missing from.
  await panel.getByRole('button', { name: 'Open source' }).first().click();
  const preview = page.getByRole('region', { name: 'Source PDF' });
  await expect(preview.locator('.pdf-text-highlight').first()).toBeVisible({ timeout: 30_000 });
  await expect(preview.locator('.pdf-text-highlight').first()).toContainText('A different paragraph');
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'quotation-open-source.png') });
  // Exactly one exit control, in the header.
  assert.equal(await panel.getByRole('button', { name: 'Done', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(panel).toHaveCount(0);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, preparations, assertions: [
    'left full-paragraph geometry', 'compact excerpts', 'HiDPI raster', 'click-delete-undo-redo',
    'text selection', 'scan drawing', 'persisted deletion', 'editable PDF export', 'stable quotation review', 'unlocated batch', 'mobile footer'
  ] }, null, 2));
  console.log(`Authorities highlight browser checks passed: ${output}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.txt'), String(error.stack || error));
  throw error;
} finally { await browser?.close(); await server.close(); }
