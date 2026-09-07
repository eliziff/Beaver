import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const model = vi.hoisted(() => vi.fn(async () => { throw new Error("Changing research views must not invoke a model"); }));
vi.mock("../lib/localMode", () => ({ isLocalRuntime: () => true }));
vi.mock("../lib/llm", async (original) => ({
  ...await original<typeof import("../lib/llm")>(), streamChatWithTools: model,
}));
const owner = { userId: "00000000-0000-0000-0000-000000000001" };
let directory: string;
let close: (() => Promise<void>) | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-views-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", directory);
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", path.join(directory, "library"));
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  model.mockClear();
  vi.resetModules();
});
afterEach(async () => {
  await close?.(); close = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function fixture(answered = true) {
  const { api } = await import("../api"), { runtime } = await import("../runtime");
  close = () => runtime.shutdown();
  const research = await import("../lib/researchFile"), evidence = await import("../lib/chat/legalEvidence"),
    { resourceReference } = await import("../lib/resourceReferences"),
    documents = await runtime.documents(), chats = await runtime.chats(),
    bytes = Buffer.from("The agreed interest rate is five percent."),
    source = await documents.create(owner, { filename: "Agreement.txt", fileType: "txt", bytes }),
    resource = resourceReference.document(source.id, source.current_version_id),
    // The binding contract starts with a verified receipt, not with a format parser.
    library = evidence.createLibraryEvidence({ documentId: source.id, versionId: source.current_version_id,
      filename: source.filename, sourceSha256: source.source_sha256, spanText: bytes.toString(), start: 0, end: bytes.length }),
    external = evidence.createTnaEvidence({ jurisdiction: "UK", sourceClass: "case", stableSourceId: "ewca/civ/2024/1:",
      sourceReference: { id: "ewca/civ/2024/1" }, sourceText: "The appeal is allowed.", spanText: "The appeal is allowed.",
      span: { start: 0, end: 22 }, citation: "[2024] EWCA Civ 1", dataset: "tna", locatorLabel: "1" }),
    state = evidence.createLegalEvidenceTurnState();
  evidence.registerLegalEvidence(state, library);
  evidence.registerLegalEvidence(state, external);
  const claims = [{ text: "Interest is five percent.", evidence_ids: [library.evidence_id] },
    { text: "The appeal was allowed.", evidence_ids: [external.evidence_id] }];
  if (answered) state.answer = claims;
  const event = evidence.legalEvidenceReceiptEvent(state)!, assistantId = randomUUID(),
    chat = await chats.create(owner, { projectId: null, tabularReviewId: null });
  await chats.commitTurn(owner, chat.id, { expectedVersion: 0,
    userMessage: { id: randomUUID(), content: "What did the materials establish?" },
    assistantMessage: { id: assistantId, content: [event] } });
  const workspace = await documents.create(owner, { filename: "Review.research.md", fileType: "md",
    bytes: Buffer.from(research.researchFileMarkdown("Review", research.createResearchFileState())) });
  expect((await request(api).post(`/source-workspaces/${workspace.id}/bind`).send({ chatId: chat.id })).status).toBe(200);
  return { api, runtime, research, documents, chats, source, resource, chat, assistantId,
    workspace, claims, receipts: [library, external] };
}

async function arrange(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const answers = await request(f.api).get(`/source-workspaces/${f.workspace.id}/findings`),
    findings = (answers.body.items as Awaited<ReturnType<typeof import("../lib/researchChat").resolveChatFindings>>["findings"])
      .filter(({ reference }) => reference.kind === "answer"),
    current = await request(f.api).get(`/tabular-review/${id}`), rows = findings.map((finding, index) => ({
      id: `branch-${index}`, title: `Chosen row ${index + 1}`, sourceId: finding.sourceId }));
  const arranged = await request(f.api).patch(`/tabular-review/${id}`).send({
    expected_version: current.body.review.updated_at,
    columns_config: [{ index: 3, name: "Finding", prompt: "Explain the finding", format: "text" }],
    arrangement: { rows, cells: findings.map((finding, index) => ({ rowId: rows[index].id, columnIndex: 3,
      items: [{ kind: "answer", chatId: f.chat.id, answerId: finding.question.id, resource: finding.resource }] })) },
  });
  expect(arranged.status).toBe(200);
  return request(f.api).get(`/tabular-review/${id}`);
}

it("reuses stored chat answers and their original Library/public evidence across workspace and table views", async () => {
  const f = await fixture(), tablePath = `/source-workspaces/${f.workspace.id}/table`, input = {
    chatId: f.chat.id, messageIds: [f.assistantId],
  };
  const first = await request(f.api).post(tablePath).send(input);
  expect(first.status).toBe(200);
  expect(first.body.columns_config.map(({ name }: { name: string }) => name).slice(0, 2)).toEqual(["Labels", "Note"]);
  expect((await request(f.api).post(tablePath).send(input)).body.id).toBe(first.body.id);
  const table = await arrange(f, first.body.id);
  expect(table.status).toBe(200);
  expect(table.body.cells).toHaveLength(2);
  expect(table.body.cells.every((cell: { status: string }) => cell.status === "done")).toBe(true);
  expect(table.body.cells.flatMap((cell: { content: { evidence: unknown[] } }) => cell.content.evidence))
    .toEqual(expect.arrayContaining(f.receipts));
  expect(table.body.cells.flatMap((cell: { content: { claims: unknown[] } }) => cell.content.claims))
    .toEqual(expect.arrayContaining(f.claims));
  expect(table.body.review.scope_config.subjects.map((subject: { resource: string }) => subject.resource))
    .toContain(f.resource);
  const { tabularRepository } = await import("../lib/relationalTabularRepository");
  expect((await tabularRepository.detail(owner, first.body.id))?.cells.every(({ status, content }) =>
    status === "pending" && content === null)).toBe(true);
  expect(table.body.documents.map(({ filename }: { filename: string }) => filename)).toEqual(["Chosen row 1", "Chosen row 2"]);
  expect((await request(f.api).post('/source-workspaces/ensure').send({ tableId: first.body.id })).body.document.id)
    .toBe(f.workspace.id);
  const file = (await f.research.readResearchFile(f.documents, owner, f.workspace.id))!;
  expect(file.state.tables).toEqual([first.body.id]);
  expect(file.state.chats).toEqual([f.chat.id]);
  expect(file.state.reads?.count).toBe(2);
  expect(Object.values(file.state.sources).every(({ passages }) => passages === null)).toBe(true);
  const answers = await request(f.api).get(`/source-workspaces/${f.workspace.id}/findings`);
  expect(answers.status).toBe(200);
  expect(answers.body.items.flatMap((finding: { answer: { claims: unknown[] } }) => finding.answer.claims))
    .toEqual(expect.arrayContaining(f.claims));
  const nextChat = await request(f.api).post("/chat/create").send({ research_file_id: f.workspace.id });
  expect(nextChat.status).toBe(200);
  expect((await f.chats.get(owner, nextChat.body.id))?.research_file_id).toBe(f.workspace.id);
  expect(model).not.toHaveBeenCalled();
}, 60_000);

it("retains uncited reads as history, not highlights or findings to seed a table", async () => {
  const f = await fixture(false), response = await request(f.api).post(`/source-workspaces/${f.workspace.id}/table`)
    .send({ chatId: f.chat.id, messageIds: [f.assistantId] });
  expect(response.status).toBe(400);
  const file = (await f.research.readResearchFile(f.documents, owner, f.workspace.id))!;
  expect(file.state.sources).toEqual({});
  expect(file.state.reads?.count).toBe(2);
  expect((await request(f.api).get(`/source-workspaces/${f.workspace.id}/findings`)).body.items).toEqual([]);
  expect((await request(f.api).get(`/source-workspaces/${f.workspace.id}/items?kind=passages`)).body.items).toEqual([]);
  expect((await request(f.api).get(`/source-workspaces/${f.workspace.id}/items?kind=reads`)).body.items
    .map(({ value }: { value: unknown }) => value)).toEqual(expect.arrayContaining(f.receipts));
  expect(model).not.toHaveBeenCalled();
});

it("keeps private chats, workspace bindings and Library sources inside their existing access boundaries", async () => {
  const f = await fixture(), other = { userId: randomUUID() }, app = await f.runtime.chat(), table = await f.runtime.tabular(),
    sources = await f.runtime.sources();
  await expect(sources.table(other, f.workspace.id, { chatId: f.chat.id }))
    .rejects.toMatchObject({ status: 404 });
  await expect(app.create(other, { projectId: null, tabularReviewId: null, researchFileId: f.workspace.id }))
    .rejects.toMatchObject({ status: 404 });
  const imported = await sources.table(owner, f.workspace.id, { chatId: f.chat.id });
  await expect(table.detail(other, imported.id)).rejects.toMatchObject({ status: 404 });
  const unrelated = await f.documents.create(owner, { filename: "Other.research.md", fileType: "md",
    bytes: Buffer.from(f.research.researchFileMarkdown("Other", f.research.createResearchFileState())) });
  const related = await sources.table(owner, unrelated.id, { chatId: f.chat.id });
  expect(related.scope_config?.research_file_id).toBe(unrelated.id);
  expect((await sources.findings(owner, f.workspace.id, { offset: 0, limit: 20 })).items)
    .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "answer" })]));
  expect(model).not.toHaveBeenCalled();
});

it("prunes every branch of a deleted Library source and keeps the remaining table usable", async () => {
  const f = await fixture(), sources = await f.runtime.sources(), tables = await f.runtime.tabular(),
    review = await sources.table(owner, f.workspace.id, { chatId: f.chat.id });
  await arrange(f, review.id);
  const current = await tables.detail(owner, review.id), config = current.review.scope_config!,
    originalRow = config.subjects.find(({ resource }) => resource === f.resource)!,
    firstRow = config.arrangement!.rows.find(({ id }) => id === originalRow.rowId)!;
  await tables.update(owner, review.id, { expected_version: current.review.updated_at,
    arrangement: { rows: [...config.arrangement!.rows, { ...firstRow, id: "another-library-branch" }],
      cells: config.arrangement!.cells } });
  expect((await tables.detail(owner, review.id)).documents).toHaveLength(3);
  await f.documents.deleteDocument(owner, f.source.id, true);
  const remaining = await tables.detail(owner, review.id);
  expect(remaining.documents).toHaveLength(1);
  expect(remaining.review.scope_config?.subjects.every(({ resource }) => resource !== f.resource)).toBe(true);
  expect(remaining.cells).toHaveLength(1);
  expect(remaining.cells[0].content?.claims).toEqual([f.claims[1]]);
  expect((await sources.views(owner, f.workspace.id)).tables.map(({ id }) => id)).toContain(review.id);
});

it("keeps the chat and its answers when its table and Sources workspace are deleted", async () => {
  const f = await fixture(), sources = await f.runtime.sources(), tables = await f.runtime.tabular(),
    review = await sources.table(owner, f.workspace.id, { chatId: f.chat.id }),
    file = (await sources.get(owner, f.workspace.id))!, sourceId = Object.values(file.state.sources)
      .find(({ reference }) => f.research.researchSourceResource(reference) === f.resource)!.id;
  const linked = await f.chats.create(owner, { projectId: null, tabularReviewId: review.id });
  await sources.bind(owner, f.workspace.id, { chatId: f.chat.id,
    selection: { target: "passages", sourceIds: [sourceId], evidenceIds: [f.receipts[0].evidence_id] } });
  await tables.remove(owner, review.id);
  expect(await f.chats.get(owner, linked.id)).toMatchObject({ tabular_review_id: null });
  expect(await f.chats.get(owner, f.chat.id)).toMatchObject({ research_file_id: f.workspace.id });
  expect((await sources.findings(owner, f.workspace.id, { offset: 0, limit: 20 })).items)
    .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "answer" })]));
  await f.documents.deleteDocument(owner, f.workspace.id, true);
  expect(await f.chats.get(owner, f.chat.id)).toMatchObject({ research_file_id: null, research_selection: null });
  expect((await f.chats.transcript(owner, f.chat.id))?.some(({ id }) => id === f.assistantId)).toBe(true);
});

it("proposes labels from a column only inside its research set", async () => {
  const f = await fixture(), sources = await f.runtime.sources(), tables = await f.runtime.tabular(),
    labelId = randomUUID();
  const file = (await sources.get(owner, f.workspace.id))!, sourceId = Object.values(file.state.sources)
    .find(({ reference }) => f.research.researchSourceResource(reference) === f.resource)!.id;
  const act = async (action: unknown) => { const current = (await sources.get(owner, f.workspace.id))!;
    return request(f.api).post(`/source-workspaces/${f.workspace.id}/actions`).send({
      version_id: current.versionId, working_revision: current.workingRevision, action }); };
  await act({ type: "label", id: labelId, name: "Leases", scope: "source" });
  await act({ type: "annotate", kind: "source", id: sourceId, labelIds: [labelId] });
  const review = await sources.table(owner, f.workspace.id, { chatId: f.chat.id });
  expect(review.columns_config.map(({ name }) => name).slice(0, 2)).toEqual(["Labels", "Note"]);
  await tables.update(owner, review.id, { expected_version: review.updated_at,
    columns_config: review.columns_config.map((column) => column.index === 0
      ? { ...column, name: "Topic", format: "tag" } : column) });
  const proposal = await request(f.api).post(`/source-workspaces/${f.workspace.id}/column-labels`)
    .send({ reviewId: review.id, columnIndex: 0 });
  expect(proposal.status).toBe(200);
  expect(proposal.body.state.proposals).toMatchObject([{ title: "Labels from Topic" }]);
  expect(Object.values(proposal.body.state.labels).map((label) => (label as { name: string }).name)).toEqual(["Leases"]);
  const history = await request(f.api).get(`/source-workspaces/${f.workspace.id}/items?kind=history`),
    pending = (history.body.items as Array<{ value: { status: string;
      changes: Array<{ target: string; id: string; field: string; after: unknown }> } }>)
      .find(({ value }) => value.status === "pending")!;
  expect(pending.value.changes.filter(({ target, field }) => target === "label" && field === "$")
    .map(({ after }) => (after as { name: string }).name)).toEqual(["Topic", "Leases"]);
  expect(pending.value.changes.some(({ target, id, field, after }) => target === "source" &&
    id === sourceId && field.startsWith("labelIds.") && after === true)).toBe(true);
  expect(model).not.toHaveBeenCalled();
}, 60_000);

it("keeps each research set's labels out of Library metadata and profile state", async () => {
  const f = await fixture(), sources = await f.runtime.sources(),
    before = await f.documents.metadata(owner, f.source.id),
    second = await sources.create(owner, { title: "Separate question" });
  const first = (await sources.get(owner, f.workspace.id))!,
    firstSource = Object.values(first.state.sources).find(({ reference }) => reference.id === f.source.id)!;
  const { file: labelled } = await sources.update(owner, first.document.id, {
    versionId: first.versionId, workingRevision: first.workingRevision,
    action: { type: "label", name: "Relevant", scope: "source" },
  });
  const labelId = Object.keys(labelled.state.labels)[0];
  await sources.update(owner, first.document.id, {
    versionId: labelled.versionId, workingRevision: labelled.workingRevision,
    action: { type: "annotate", kind: "source", id: firstSource.id, labelIds: [labelId] },
  });
  const { file: added } = await sources.update(owner, second.document.id, {
    versionId: second.versionId, workingRevision: second.workingRevision,
    action: { type: "source", reference: firstSource.reference },
  });
  expect(Object.values(added.state.sources)[0].labelIds).toEqual([]);
  expect(await f.documents.metadata(owner, f.source.id)).toEqual(before);
  expect((await request(f.api).get("/user/profile")).body).not.toHaveProperty("libraryLabelsId");
  expect((await request(f.api).post("/source-workspaces/ontology").send({})).status).toBe(404);
  expect((await request(f.api).get("/source-workspaces/ontology")).status).toBe(404);
  expect(model).not.toHaveBeenCalled();
});
