/** Real PDF.js pointer/keyboard interaction -> native geometry -> editable PDF export. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
const { createServer } = await import(pathToFileURL(createRequire(new URL('../frontend/package.json', import.meta.url)).resolve('vite')).href);
const root = path.resolve(import.meta.dirname, '..');
// Match the app build's source-scanning root instead of scanning repository data.
process.chdir(path.join(root, 'frontend'));
const require = createRequire(path.join(root, 'backend/package.json'));
const express = require('express'), pdf = require('pdf-lib');
const { structureNative } = require('../backend/dist/lib/structureNative');
const { sha256 } = require('../backend/dist/lib/hash');
const { prepareAuthorityAnnotations, buildAuthorities } = require('../backend/dist/lib/authoritiesBuild');
const { reduceAuthoritiesDraft } = require('../backend/dist/lib/authoritiesDomain');
const keepOutputs = process.argv.includes('--keep-outputs') || !!process.env.AUTHORITIES_HIGHLIGHT_OUTPUT;
const quotationsOnly = process.argv.includes('--quotations-only');
const output = path.resolve(process.env.AUTHORITIES_HIGHLIGHT_OUTPUT || path.join(root, '.tmp/authorities-highlight-results'));
if (!process.env.AUTHORITIES_HIGHLIGHT_OUTPUT) await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const api = express(); api.use(express.json({ limit: '20mb' }));
api.post('/prepare', async (req, res, next) => {
  try {
    const { product, authorityId, bindingRole } = req.body, bytes = Buffer.from(req.body.bytes, 'base64');
    const authority = product.state.authorities[authorityId], source = authority.source.sources.find(s => s.bindingRole === bindingRole);
    const document = await pdf.PDFDocument.load(bytes), native = await structureNative().openSource(bytes, { documentId: 'highlights',
      versionId: sha256(bytes), fileType: 'pdf', sourceSha256: sha256(bytes), pdf: {} });
    const targets = authorityId === 'text' ? [{ id: '42', locatorKind: 'paragraph', locator: '42',
      exactQuotes: ['First independent quote', 'Second independent quote'] }] : [];
    const passageGeometry = targets.length ? await structureNative().pdfPassageGeometry(native, targets) : undefined;
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
const longQuote = 'The landlord must deliver written notice at least seven business days before the hearing. ' +
  'The tenant must have a reasonable opportunity to respond to the evidence and to make submissions on the application. '.repeat(16);
const longFinding = quotationFindings('long-wording', `The court held that "${longQuote.replace('business', 'calendar')}".`, '52', longQuote);
const caseFinding = { kind: 'different_case', id: 'different-case', occurrenceId: 'different-case', authorityId: 'text',
  footnoteId: 4, citation: 'North v Harbour, 2024 SCC 1', text: 'See North v Harbour, 2024 SCC 1.',
  cited: { citation: '2024 SCC 1', name: 'Pine v Mason' }, named: { citation: '2024 SCC 2', name: 'North v Harbour' },
  actions: ['use_named_case', 'use_cited_name', 'keep_cited_case', 'ignore'] };
api.get('/discrepancies', (_req, res) => res.json([...quotationCases.difference, ...longFinding, caseFinding,
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
const server = await createServer({ root: path.join(root, 'frontend'), cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'annotation-test-api', configureServer(server) { server.middlewares.use('/api/test-annotations', api); } }] });
let browser, page;
async function closeEditor(authorityId, role, count) {
  await expect.poll(() => page.evaluate(({ authorityId, role }) =>
    window.annotationTestProduct.state.authorities[authorityId].annotations?.[role]?.marks.length,
  { authorityId, role })).toBe(count);
  await page.getByRole('dialog', { name: 'Highlights', exact: true }).getByRole('button', { name: 'Close highlights', exact: true }).click();
}
try {
  await server.listen(); const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/tests/authorities-highlights/`, { waitUntil: 'domcontentloaded' });
  if (!quotationsOnly) {
  await page.getByRole('button', { name: 'Edit in PDF' }).click();
  const cards = page.getByRole('complementary', { name: 'Highlights' }).locator('li');
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toContainText('First independent quote');
  await cards.nth(1).locator('button').first().click();
  const wrapper = page.locator('[aria-label="Authority PDF editor"]:not([aria-hidden]) [data-page-number="2"]');
  await expect(wrapper.locator('canvas')).toBeVisible();
  const canvasSize = await wrapper.locator('canvas').evaluate(node => ({ pixels: node.width, css: node.clientWidth }));
  assert.ok(canvasSize.pixels >= canvasSize.css * 1.9, 'Render at device resolution');
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
  await closeEditor('text', 'text-en', 3);
  await page.getByRole('button', { name: 'Edit in PDF' }).click();
  await expect(cards).toHaveCount(3); await expect(cards.last()).toContainText('Uncited passage');
  // A scanned PDF still supports arbitrary manual rectangle highlights.
  await page.getByRole('combobox', { name: 'Authority PDF' }).selectOption('scan-en');
  const scanPage = page.locator('[aria-label="Authority PDF editor"]:not([aria-hidden]) [data-page-number="1"]'); await expect(scanPage.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Draw highlight', exact: true }).click();
  const scanBox = await scanPage.boundingBox();
  await page.mouse.move(scanBox.x + 60, scanBox.y + 250); await page.mouse.down();
  await page.mouse.move(scanBox.x + 260, scanBox.y + 290, { steps: 5 }); await page.mouse.up();
  await expect(cards).toHaveCount(1);
  await closeEditor('scan', 'scan-en', 1);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Build test book' }).click();
  const exported = await download; await exported.saveAs(path.join(output, 'highlight-export.pdf'));
  const { readFile } = await import('node:fs/promises');
  const book = await pdf.PDFDocument.load(await readFile(path.join(output, 'highlight-export.pdf')));
  const annotations = book.getPages().flatMap(p => p.node.lookupMaybe(pdf.PDFName.of('Annots'), pdf.PDFArray)?.asArray()
    .map(ref => book.context.lookup(ref, pdf.PDFDict)) ?? []);
  assert.ok(annotations.some(a => a.get(pdf.PDFName.of('Subtype'))?.toString() === '/Highlight'));
  assert.ok(annotations.some(a => a.get(pdf.PDFName.of('QuadPoints'))));
  // Marks carry no author or comment: the passage selected by hand is a highlight beside the quote's.
  assert.ok(annotations.filter(a => a.get(pdf.PDFName.of('Subtype'))?.toString() === '/Highlight' && a.get(pdf.PDFName.of('QuadPoints'))).length >= 3,
    'The user-selected passage survives as an editable exported highlight');
  assert.ok(annotations.every(a => !a.has(pdf.PDFName.of('Contents')) && !a.has(pdf.PDFName.of('T'))), 'Marks carry no author or comment');
  assert.ok(book.getPages().at(-1).node.lookupMaybe(pdf.PDFName.of('Annots'), pdf.PDFArray)?.size(),
    'The scanned page retains its manually drawn annotation');
  await page.getByRole('button', { name: 'Edit in PDF' }).click(); await expect(cards).toHaveCount(3);
  while (await cards.count()) await cards.first().getByRole('button', { name: /^Delete / }).click();
  await closeEditor('text', 'text-en', 0);
  await page.getByRole('button', { name: 'Edit in PDF' }).click(); await expect(cards).toHaveCount(0);
  await closeEditor('text', 'text-en', 0);
  }
  // Meaningless differences never reach the dialog at all.
  assert.deepEqual(quotationCases.ownerComma, [], 'A quote the cited passage contains is not a finding');
  assert.deepEqual(quotationCases.diacritics, [], 'Diacritics, case and dashes are not differences');
  assert.equal(quotationCases.difference.length, 1);
  assert.equal(longFinding.length, 1);
  await page.getByRole('button', { name: 'Review test quotations' }).click();
  const panel = page.getByRole('region', { name: 'Check quotations and citations', exact: true });
  const details = panel.getByRole('region', { name: 'Finding details' });
  const geometry = async (action = 'Apply') => ({ panel: await panel.boundingBox(),
    heading: await panel.getByRole('heading', { name: 'Check quotations and citations', exact: true }).boundingBox(),
    action: await panel.getByRole('button', { name: action, exact: true }).boundingBox(),
    scroll: await page.evaluate(() => window.scrollY) });
  const stable = (before, after) => {
    for (const key of ['panel', 'heading', 'action']) for (const dimension of ['x', 'y', 'width', 'height'])
      assert.ok(Math.abs(before[key][dimension] - after[key][dimension]) < 1, `${key} ${dimension} stays put`);
    assert.equal(after.scroll, before.scroll, 'Reviewing a finding does not scroll the page');
  };
  await expect(panel.getByText(/The Board explained that/)).toBeVisible();
  await expect(details).toBeFocused();
  const original = await geometry();
  assert.equal(original.panel.width, 900, 'A wide window keeps a readable comparison width');
  assert.ok(original.panel.y + original.panel.height <= 1000, 'The panel fits in the window');
  await page.screenshot({ path: path.join(output, 'quotation-desktop.png') });
  await panel.getByRole('button', { name: 'Next finding' }).click();
  stable(original, await geometry());
  assert.ok(await details.evaluate(node => node.scrollHeight > node.clientHeight), 'Long passages scroll inside the comparison');
  await details.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeInViewport();
  await page.screenshot({ path: path.join(output, 'quotation-long.png') });
  await page.evaluate(() => window.annotationTestReviewError('The correction could not be saved. Try applying the decision again.'));
  await expect(panel.getByRole('alert')).toBeInViewport();
  stable(original, await geometry());
  await page.evaluate(() => window.annotationTestReviewError(''));
  await panel.getByRole('button', { name: 'Next finding' }).click();
  await expect(panel.getByRole('radio')).toHaveCount(4);
  assert.equal(await details.evaluate(node => node.scrollTop), 0, 'A new finding opens at the top of its details');
  stable(original, await geometry());
  await panel.getByRole('button', { name: 'Previous finding' }).click();
  await panel.getByRole('button', { name: 'Previous finding' }).click();
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 720, height: 500 }]) {
    await page.setViewportSize(viewport);
    const before = await geometry();
    assert.ok(before.panel.x >= 0 && before.panel.x + before.panel.width <= viewport.width, 'The panel fits narrow windows');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No sideways page scrolling');
    await panel.getByRole('button', { name: 'Next finding' }).click();
    stable(before, await geometry());
    await panel.getByRole('button', { name: 'Previous finding' }).click();
    if (viewport.width === 390) await page.screenshot({ path: path.join(output, 'quotation-mobile.png') });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('radio', { name: /Use the source’s wording/ }).check();
  const beforeApply = await geometry();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByText('Rechecking', { exact: true })).toBeVisible();
  await expect(panel.getByText(/The Board explained that/)).toBeVisible();
  stable(beforeApply, await geometry());
  await expect(panel.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  stable(beforeApply, await geometry('Next'));
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  await expect(panel.getByRole('radio').first()).toBeEnabled();
  stable(beforeApply, await geometry());
  // Every remaining finding can still be decided after an undo and a recheck.
  for (let remaining = 3; remaining > 0; remaining -= 1) {
    await panel.getByRole('radio', { name: 'Keep as written', exact: true }).check();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    stable(beforeApply, await geometry('Next'));
    if (remaining > 1) await panel.getByRole('button', { name: 'Next', exact: true }).click();
  }
  assert.deepEqual([...quotationCases.missingOne, ...quotationCases.missingTwo], []);
  await expect(panel).toContainText('Nothing left to review');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(panel).toHaveCount(0);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, assertions: [
    ...(quotationsOnly ? [] : ['left full-paragraph geometry', 'HiDPI raster', 'click-delete-undo-redo',
      'text selection', 'scan drawing', 'persisted deletion', 'editable PDF export']),
    'quotation correction and undo', 'stable review size and controls', 'internal passage scrolling', 'visible errors', 'narrow window reflow'
  ] }, null, 2));
  console.log(`Authorities highlight browser checks passed: ${output}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.txt'), String(error.stack || error));
  throw error;
} finally {
  try { await browser?.close(); } finally {
    try { await server.close(); } finally {
      if (!keepOutputs) {
        await rm(path.join(output, 'vite-cache'), { recursive: true, force: true });
        await rm(path.join(output, 'highlight-export.pdf'), { force: true });
      }
    }
  }
}
