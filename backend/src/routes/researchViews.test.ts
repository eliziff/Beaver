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
    { readResearchResource } = await import("../lib/researchReader"),
    { resourceReference } = await import("../lib/resourceReferences"),
    documents = await runtime.documents(), chats = await runtime.chats(),
    bytes = Buffer.from("The agreed interest rate is five percent."),
    source = await documents.create(owner, { filename: "Agreement.txt", fileType: "txt", bytes }),
    resource = resourceReference.document(source.id, source.current_version_id),
    read = await readResearchResource(documents, owner, { resource }),
    library = read.evidence![0],
    external = evidence.createTnaEvidence({ jurisdiction: "UK", sourceClass: "case", stableSourceId: "ewca/civ/2024/1:",
      sourceReference: { id: "ewca/civ/2024/1" }, sourceText: "The appeal is allowed.", spanText: "The appeal is allowed.",
      span: { start: 0, end: 22 }, citation: "[2024] EWCA Civ 1", dataset: "tna", locatorLabel: "1" }),
    state = evidence.createLegalEvidenceTurnState();
  evidence.registerLegalEvidence(state, library, read.evidenceSources!.get(library.evidence_id));
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
  const file = (await research.readResearchFile(documents, owner, workspace.id))!;
  expect((await request(api).post(`/chat/${chat.id}/research-files/${workspace.id}/promote`).send({
    version_id: file.versionId, working_revision: file.workingRevision,
  })).status).toBe(200);
  return { api, runtime, research, documents, chats, source, resource, chat, assistantId,
    workspace, claims, receipts: [library, external] };
}

async function arrange(f: Awaited<ReturnType<typeof fixture>>, id: string, answered = true) {
  const answers = await request(f.api).get(`/chat/${f.chat.id}/research-answers?research_file_id=${f.workspace.id}`),
    findings = answers.body.items as Awaited<ReturnType<typeof import("../lib/researchChat").resolveChatFindings>>["findings"],
    current = await request(f.api).get(`/tabular-review/${id}`), rows = findings.map((finding, index) => ({
      id: `branch-${index}`, title: `Chosen row ${index + 1}`, sourceId: finding.sourceId }));
  expect(current.body.review.columns_config).toEqual([]);
  expect(current.body.cells).toEqual([]);
  const arranged = await request(f.api).patch(`/tabular-review/${id}`).send({
    expected_version: current.body.review.updated_at,
    columns_config: [{ index: 3, name: "Finding", prompt: "Explain the finding", format: "text" }],
    arrangement: { rows, cells: findings.map((finding, index) => ({ rowId: rows[index].id, columnIndex: 3,
      items: answered ? [{ kind: "answer", chatId: f.chat.id, answerId: finding.question.id, resource: finding.resource }]
        : finding.evidence.map((receipt) => ({ kind: "passage", sourceId: finding.sourceId, evidenceId: receipt.evidence_id })) })) },
  });
  expect(arranged.status).toBe(200);
  return request(f.api).get(`/tabular-review/${id}`);
}

it("reuses stored chat answers and their original Library/public evidence across workspace and table views", async () => {
  const f = await fixture(), tablePath = `/chat/${f.chat.id}/table`, input = {
    research_file_id: f.workspace.id, message_ids: [f.assistantId],
  };
  const first = await request(f.api).post(tablePath).send(input);
  expect(first.status).toBe(200);
  expect(first.body.needs_arrangement).toBe(true);
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
  expect((await request(f.api).post(tablePath).send(input)).body)
    .toMatchObject({ id: first.body.id, needs_arrangement: false });
  const { tabularRepository } = await import("../lib/relationalTabularRepository");
  expect((await tabularRepository.detail(owner, first.body.id))?.cells.every(({ status, content }) =>
    status === "pending" && content === null)).toBe(true);
  expect(table.body.documents.map(({ filename }: { filename: string }) => filename)).toEqual(["Chosen row 1", "Chosen row 2"]);
  expect((await request(f.api).post(`/tabular-review/${first.body.id}/workspace`)).body)
    .toEqual({ research_file_id: f.workspace.id });
  const file = (await f.research.readResearchFile(f.documents, owner, f.workspace.id))!;
  expect(file.state.tables).toEqual([first.body.id]);
  expect(file.state.chats).toEqual([f.chat.id]);
  const answers = await request(f.api).get(`/chat/${f.chat.id}/research-answers?research_file_id=${f.workspace.id}`);
  expect(answers.status).toBe(200);
  expect(answers.body.items.flatMap((finding: { answer: { claims: unknown[] } }) => finding.answer.claims))
    .toEqual(expect.arrayContaining(f.claims));
  const nextChat = await request(f.api).post("/chat/create").send({ research_file_id: f.workspace.id });
  expect(nextChat.status).toBe(200);
  expect((await f.chats.get(owner, nextChat.body.id))?.research_file_id).toBe(f.workspace.id);
  expect(model).not.toHaveBeenCalled();
}, 60_000);

it("opens collected passages as grounded cells before a chat has a final answer", async () => {
  const f = await fixture(false), response = await request(f.api).post(`/chat/${f.chat.id}/table`)
    .send({ research_file_id: f.workspace.id, message_ids: [f.assistantId] });
  expect(response.status).toBe(200);
  const table = await arrange(f, response.body.id, false);
  expect(table.body.cells.flatMap((cell: { content: { claims: { text: string }[] } }) =>
    cell.content.claims.map(({ text }) => text))).toEqual(expect.arrayContaining(f.receipts.map((receipt) => receipt.span_text)));
  expect(model).not.toHaveBeenCalled();
});

it("keeps private chats, workspace bindings and Library sources inside their existing access boundaries", async () => {
  const f = await fixture(), other = { userId: randomUUID() }, app = await f.runtime.chat(), table = await f.runtime.tabular();
  await expect(app.table(other, { chatId: f.chat.id, researchFileId: f.workspace.id }))
    .rejects.toMatchObject({ status: 404 });
  await expect(app.create(other, { projectId: null, tabularReviewId: null, researchFileId: f.workspace.id }))
    .rejects.toMatchObject({ status: 404 });
  const imported = await app.table(owner, { chatId: f.chat.id, researchFileId: f.workspace.id });
  await expect(table.detail(other, imported.id)).rejects.toMatchObject({ status: 404 });
  const unrelated = await f.documents.create(owner, { filename: "Other.research.md", fileType: "md",
    bytes: Buffer.from(f.research.researchFileMarkdown("Other", f.research.createResearchFileState())) });
  await expect(app.table(owner, { chatId: f.chat.id, researchFileId: unrelated.id }))
    .rejects.toMatchObject({ status: 400 });
  expect(model).not.toHaveBeenCalled();
});
