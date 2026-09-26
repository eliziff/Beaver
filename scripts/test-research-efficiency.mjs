/** Real local storage + production UI. Seed recorded findings, never invoke a paid model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
const home = await mkdtemp(path.join(tmpdir(), 'beaver-research-ui-'));
const output = process.env.RESEARCH_EFFICIENCY_OUTPUT || await mkdtemp(path.join(tmpdir(), 'beaver-research-screenshots-'));
await mkdir(output, { recursive: true });
Object.assign(process.env, { AUTH_MODE: 'local', NODE_ENV: 'production', MIKE_LOCAL_DATA_DIR: home, OPEN_LEGAL_DATA_HOME: home });
const require = createRequire(import.meta.url);
const { runtime } = require('../backend/dist/runtime');
const { server } = require('../backend/dist/server');
const { readResearchResource } = require('../backend/dist/lib/researchReader');
const e = require('../backend/dist/lib/chat/legalEvidence');
const { createLegalEvidenceCitations } = require('../backend/dist/lib/chat/citations');
const { tabularRepository } = require('../backend/dist/lib/relationalTabularRepository');
const scope = { userId: '00000000-0000-0000-0000-000000000001' };
let listener, browser, page;
try {
  const documents = await runtime.documents(), chats = await runtime.chats(), sources = await runtime.sources(), tables = await runtime.tabular();
  const document = await documents.create(scope, { filename: 'Notice provisions.txt', fileType: 'txt', bytes: Buffer.from(
    'Notice must be delivered within thirty days, unless the recipient agrees in writing to an extension.\nUnilateral extensions are not permitted.') });
  const resource = `document://${document.id}/version/${document.current_version_id}`;
  const read = await readResearchResource(documents, scope, { resource }), receipt = read.evidence[0];
  const state = e.createLegalEvidenceTurnState(); e.registerLegalEvidence(state, receipt);
  state.answer = [{ text: 'Notice must be delivered within thirty days. The recipient may agree in writing to an extension.', evidence_ids: [receipt.evidence_id] }];
  const grounding = e.legalEvidenceReceiptEvent(state), chat = await chats.create(scope, { projectId: null, tabularReviewId: null });
  await chats.update(scope, chat.id, { title: 'Notice research', model: 'gpt-5.5' });
  const turnId = randomUUID();
  await chats.commitTurn(scope, chat.id, { expectedVersion: 0,
    userMessage: { id: randomUUID(), turnId, content: 'Explain the notice deadline and its exception.' },
    assistantMessage: { id: randomUUID(), turnId, content: [
      { type: 'subagent_run', id: 'reader-fixture', task: 'Inspect the notice provision', status: 'completed',
        grounding: { ...grounding, claims: [{ ...state.answer[0], text: 'Intermediate reader note: not the final answer.' }] } },
      grounding, { type: 'content', text: e.renderLegalEvidenceAnswer(state) }, { type: 'local_turn_completed', schema_version: 1 },
    ], citations: createLegalEvidenceCitations(state) } });
  const file = await sources.ensure(scope, { chatId: chat.id, title: 'Notice research' });
  const table = await tables.create(scope, { research_file_id: file.document.id, title: 'Notice review',
    columns_config: [{ index: 0, name: 'Deadline and exception', prompt: 'State the deadline and exception.' }] });
  const cell = (await tabularRepository.detail(scope, table.id)).cells[0];
  await tabularRepository.setCell(scope, { reviewId: table.id, documentId: cell.document_id, columnIndex: 0, expected: cell,
    status: 'done', content: { value: '30 days; written extension permitted', summary: '30 days; written extension permitted',
      claims: state.answer, evidence: [receipt], outcome: 'answered', coverage: 'complete', resource } });
  listener = server.listen(3000, '127.0.0.1');
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const modelRequests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/chat', route => {
    if (route.request().method() === 'POST') { modelRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`) });
  await page.goto(`http://127.0.0.1:3000/assistant/chat/${chat.id}`);
  const add = page.getByRole('button', { name: 'Add to memo', exact: true });
  await expect(add).toBeVisible(); await add.click();
  await expect(page.getByText('Added to memo', { exact: true })).toBeVisible();
  const memo = (await sources.get(scope, file.document.id)).state.note;
  assert(memo.includes(state.answer[0].text)); assert(memo.includes(`evidence_id=${receipt.evidence_id}`));
  assert(!memo.includes('Intermediate reader note'));
  const copyResponse = page.getByRole('button', { name: 'Copy response', exact: true });
  const assertActionPlacement = async () => {
    const [answer, actions] = await Promise.all([copyResponse.boundingBox(), add.boundingBox()]);
    assert(answer && actions && actions.y - (answer.y + answer.height) < 60, 'Actions must stay directly below the answer');
  };
  await assertActionPlacement(); await capture('chat-reuse-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(add).toBeVisible(); await assertActionPlacement(); await capture('chat-reuse-mobile');
  await page.getByRole('button', { name: 'Write from selection', exact: true }).click();
  await page.waitForURL(url => url.pathname.includes('/assistant/chat/') && !url.pathname.endsWith(chat.id));
  const composedId = new URL(page.url()).pathname.split('/').at(-1), composed = await chats.get(scope, composedId);
  assert(composed.draft.content.includes('Write a synthesis'));
  assert(composed.research_selection.findingRefs.every(ref => ref.kind === 'answer' && !ref.answerId.includes(':reader:')));
  assert.equal((await chats.transcript(scope, composedId)).length, 0);
  await capture('selected-composition-draft');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:3000/tabular-reviews/${table.id}`);
  await page.getByRole('checkbox', { name: 'Select Notice provisions.txt', exact: true }).check();
  await page.getByRole('button', { name: 'Add to memo', exact: true }).click();
  await expect(page.getByText('Added to memo', { exact: true })).toBeVisible();
  await capture('table-reuse-desktop');
  await page.getByRole('button', { name: 'Open Deadline and exception result', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Deadline and exception result', exact: true });
  await expect(detail.getByRole('button', { name: 'Add to memo', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); await capture('cell-reuse-mobile');
  await detail.getByRole('button', { name: 'Write from selection', exact: true }).click();
  await page.waitForURL(/\/assistant\/chat\//);
  const cellDraft = await chats.get(scope, new URL(page.url()).pathname.split('/').at(-1));
  assert.deepEqual(cellDraft.research_selection.findingRefs, [{ kind: 'cell', reviewId: table.id, rowId: cell.document_id, columnIndex: 0 }]);
  assert.equal(modelRequests.length, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, modelRequests: 0,
    checks: ['chat copy excludes reader output', 'exact citation links', 'fresh selected draft', 'table copy', 'single-cell draft', 'desktop and mobile controls'] }, null, 2));
  console.log(`Research reuse browser checks passed. Screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (listener?.listening) await new Promise(resolve => listener.close(resolve));
  await runtime.shutdown(); await rm(home, { recursive: true, force: true });
}
