import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../localMode", () => ({ isLocalRuntime: () => true }));
const owner = { userId: "00000000-0000-0000-0000-000000000001" };
let directory: string, close: (() => Promise<void>) | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-table-tool-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", directory);
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", path.join(directory, "library"));
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  vi.resetModules();
});
afterEach(async () => {
  await close?.(); close = undefined;
  vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function fixture() {
  const { runtime } = await import("../../runtime"), research = await import("../researchFile"),
    { readResearchResource } = await import("../researchReader"),
    { resourceReference } = await import("../resourceReferences"),
    { createResearchTableTool } = await import("./researchTableTool"),
    { TurnToolRegistry } = await import("./toolRegistry");
  close = () => runtime.shutdown();
  const documents = await runtime.documents(), application = await runtime.tabular(),
    source = await documents.create(owner, { filename: "Agreement.txt", fileType: "txt",
      bytes: Buffer.from("Payment is due in thirty days.") }),
    reference = { provider: "library" as const, kind: "document" as const, id: source.id,
      versionId: source.current_version_id, title: source.filename },
    read = await readResearchResource(documents, owner, {
      resource: resourceReference.document(source.id, source.current_version_id) }),
    receipt = read.evidence![0];
  const createWorkspace = async (title: string) => {
    const document = await documents.create(owner, { filename: `${title}.research.md`, fileType: "md",
      bytes: Buffer.from(research.researchFileMarkdown(title, research.createResearchFileState())) });
    const file = (await research.readResearchFile(documents, owner, document.id))!;
    return (await research.commitResearchFile(documents, owner, file, {
      type: "merge", sources: [reference], evidence: [receipt],
    }))!;
  };
  const workspace = await createWorkspace("Review");
  let workspaceId = workspace.document.id, committed = 0;
  const tool = createResearchTableTool({ application, scope: owner, model: "test-model",
    getWorkspace: () => research.readResearchFile(documents, owner, workspaceId),
    onMutationCommitted() { committed++; },
  }), registry = new TurnToolRegistry([tool]);
  const run = async (input: Record<string, unknown>) => {
    const [result] = await registry.run([{ id: randomUUID(), name: "update_research_table", input }], {});
    return { ...result, value: JSON.parse(result.content) };
  };
  return { runtime, tool, application, documents, research, workspace, source, receipt, run, createWorkspace,
    selectWorkspace(id: string) { workspaceId = id; }, committed: () => committed };
}

it("creates a linked scoped table, preserves every format, and edits and schedules it through existing operations", async () => {
  const f = await fixture(), labelId = randomUUID(), sourceId = Object.keys(f.workspace.state.sources)[0];
  let file = (await f.research.commitResearchFile(f.documents, owner, f.workspace, {
    type: "label", id: labelId, name: "Payment", scope: "highlight",
  }))!;
  file = (await f.research.commitResearchFile(f.documents, owner, file, {
    type: "label-selection", target: "passages", evidenceIds: [f.receipt.evidence_id],
    assign: [labelId], mode: "add",
  }))!;
  const formats = ["text", "bulleted_list", "number", "percentage", "monetary_amount", "currency", "yes_no", "date", "tag"],
    columns = formats.map((format, index) => ({ index, name: format, prompt: "Extract the payment term.",
      format, ...(format === "tag" ? { tags: ["Short", "Long"] } : {}) }));
  const created = await f.run({ action: "create", title: "Payment terms", columns_config: columns,
    research_selection: { target: "passages", sourceIds: [sourceId], labelIds: [labelId] } });
  expect(created.status).toBe("ok");
  expect(created.value).toMatchObject({ source_count: 1, cells: { pending: 9, done: 0 },
    columns: formats.map((format, index) => ({ index, name: format, format })) });
  const reviewId = created.value.review_id, detail = await f.application.detail(owner, reviewId);
  expect(detail.review.columns_config).toEqual(columns);
  expect(detail.review.scope_config?.subjects[0].evidence).toEqual([f.receipt]);
  expect((await f.research.readResearchFile(f.documents, owner, file.document.id))?.state.tables).toEqual([reviewId]);
  expect((await f.run({ action: "read", review_id: reviewId, column_index: 8 })).value.columns).toEqual([columns[8]]);

  const updated = await f.run({ action: "update", review_id: reviewId, title: "Updated terms",
    expected_version: created.value.expected_version });
  expect(updated.status).toBe("ok");
  const stale = await f.run({ action: "update", review_id: reviewId, title: "Stale change",
    expected_version: created.value.expected_version });
  expect(stale.value).toMatchObject({ ok: false, status: 409 });
  expect((await f.application.detail(owner, reviewId)).review.title).toBe("Updated terms");
  const queued = await f.run({ action: "generate", review_id: reviewId, model: "codex:gpt-5.6" });
  expect(queued.value).toMatchObject({ queued: 1, is_running: true });
  expect((await f.run({ action: "stop", review_id: reviewId })).value).toMatchObject({ stopped: true, is_running: false });
  expect(f.committed()).toBe(4);
}, 60_000);

it("resolves the current workspace on each call and rejects unlinked or foreign tables", async () => {
  const f = await fixture(), columns = [{ index: 0, name: "Payment", prompt: "When is payment due?" }],
    created = await f.run({ action: "create", columns_config: columns }), reviewId = created.value.review_id;
  const other = await f.createWorkspace("Other");
  f.selectWorkspace(other.document.id);
  expect((await f.run({ action: "read", review_id: reviewId })).value).toMatchObject({ ok: false, status: 404 });
  expect((await f.run({ action: "update", review_id: reviewId, expected_version: created.value.expected_version,
    title: "Outside change" })).value).toMatchObject({ ok: false, status: 404 });
  const unlinked = await f.application.create(owner, { document_ids: [f.source.id], columns_config: columns });
  expect((await f.run({ action: "generate", review_id: unlinked.id })).value).toMatchObject({ ok: false, status: 404 });
  expect((await f.run({ action: "create", columns_config: columns,
    research_file_id: f.workspace.document.id })).status).toBe("error");
  expect((await f.application.detail(owner, reviewId)).review.title).not.toBe("Outside change");
  expect(f.committed()).toBe(1);
});

it("pages saved reasoning with original support and queues only unmapped cells in chosen branch rows", async () => {
  const f = await fixture(), chats = await f.runtime.chats(),
    { createLegalEvidenceTurnState, registerLegalEvidence, legalEvidenceReceiptEvent } = await import("./legalEvidence"),
    { collectChatResearch } = await import("../researchChat"),
    chat = await chats.create(owner, { projectId: null, tabularReviewId: null, researchFileId: f.workspace.document.id }),
    state = createLegalEvidenceTurnState(), messageId = randomUUID(),
    claims = Array.from({ length: 15 }, (_, index) => ({ text: `${index}: ${"Recorded reasoning. ".repeat(600)}`,
      evidence_ids: [f.receipt.evidence_id] }));
  registerLegalEvidence(state, f.receipt); state.answer = claims;
  const event = legalEvidenceReceiptEvent(state)!;
  await chats.commitTurn(owner, chat.id, { expectedVersion: 0,
    userMessage: { id: randomUUID(), content: "Explain the payment obligation" },
    assistantMessage: { id: messageId, content: [event] } });
  await collectChatResearch(f.documents, owner, f.workspace.document.id, chat.id, [event]);
  const overview = await f.run({ action: "answers", chat_id: chat.id }), selected = overview.value.items[0];
  expect(selected).toMatchObject({ answerId: `${messageId}:answer:0`, claim_count: 15 });
  expect(selected.answer).toBeUndefined();
  const args = { action: "answers", chat_id: chat.id, answer_id: selected.answerId,
    resource: selected.resource, claim_offset: 1, claim_limit: 1, text_offset: 8_000, text_limit: 4_000 },
    outcome = await f.tool.execute(args, {}, new AbortController().signal,
      { id: "answer", name: "update_research_table", input: args }),
    detail = JSON.parse((outcome.result.content[0] as { text: string }).text);
  expect(detail.claims[0]).toMatchObject({ claim_index: 1, text: claims[1].text.slice(8_000, 12_000),
    text_offset: 8_000, text_length: claims[1].text.length });
  expect(detail.evidence[0]).toMatchObject({ evidence_id: f.receipt.evidence_id, exact_passage: f.receipt.span_text });
  expect(outcome.evidence).toEqual([f.receipt]);
  expect(JSON.stringify(detail).length).toBeLessThan(64_000);

  const columns = [{ index: 0, name: "Existing finding", prompt: "Explain the existing finding" },
    { index: 1, name: "Further analysis", prompt: "What else follows?" }],
    created = await f.run({ action: "create", columns_config: columns,
      arrangement: { rows: [{ id: "first-branch", title: "First branch", sourceId: selected.sourceId },
        { id: "second-branch", title: "Second branch", sourceId: selected.sourceId,
          evidenceIds: [f.receipt.evidence_id] }], cells: [
        { rowId: "first-branch", columnIndex: 0, items: [{ kind: "answer", chatId: chat.id,
          answerId: selected.answerId, resource: selected.resource }] },
        { rowId: "second-branch", columnIndex: 0, items: [{ kind: "passage", sourceId: selected.sourceId,
          evidenceId: f.receipt.evidence_id }] },
      ] } });
  expect(created.value).toMatchObject({ source_count: 2, cells: { done: 2, pending: 2 } });
  const reviewId = created.value.review_id;
  expect((await f.application.detail(owner, reviewId)).documents.map(({ id, filename }) => ({ id, filename })))
    .toEqual([{ id: "first-branch", filename: "First branch" }, { id: "second-branch", filename: "Second branch" }]);
  expect((await f.application.history(owner, reviewId, { offset: 0, limit: 50 })).items[0])
    .toMatchObject({ executor: "assistant", model: "test-model" });
  await expect(f.application.regenerate(owner, reviewId, { document_id: "first-branch", column_index: 0 }))
    .rejects.toMatchObject({ status: 400 });
  expect((await f.run({ action: "generate", review_id: reviewId, model: "codex:gpt-5.6" })).value)
    .toMatchObject({ queued: 2 });
  await f.run({ action: "stop", review_id: reviewId });
});
