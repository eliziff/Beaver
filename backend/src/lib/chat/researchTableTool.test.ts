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
    { createResearchTableTool, readResearchFindings } = await import("./researchTableTool"),
    { TurnToolRegistry } = await import("./toolRegistry");
  close = () => runtime.shutdown();
  const documents = await runtime.documents(), application = await runtime.tabular(), sources = await runtime.sources(),
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
  return { runtime, tool, application, documents, research, workspace, source, receipt, run, createWorkspace, sources,
    readFindings: (input: Parameters<typeof readResearchFindings>[1]) => readResearchFindings({ sources, scope: owner, workspaceId }, input),
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
    chat = await chats.create(owner, { projectId: null, tabularReviewId: null, researchFileId: f.workspace.document.id }),
    state = createLegalEvidenceTurnState(), messageId = randomUUID(),
    claims = Array.from({ length: 15 }, (_, index) => ({ text: `${index}: ${"Recorded reasoning. ".repeat(600)}`,
      evidence_ids: [f.receipt.evidence_id] }));
  registerLegalEvidence(state, f.receipt); state.answer = claims;
  const event = legalEvidenceReceiptEvent(state)!;
  await chats.commitTurn(owner, chat.id, { expectedVersion: 0,
    userMessage: { id: randomUUID(), content: "Explain the payment obligation" },
    assistantMessage: { id: messageId, content: [event] } });
  await f.sources.bind(owner, f.workspace.document.id, { chatId: chat.id });
  const overview = await f.readFindings({ chatId: chat.id }), selected = JSON.parse((overview.result.content[0] as { text: string }).text).items[0];
  expect(selected).toMatchObject({ reference: { kind: "answer", answerId: `${messageId}:answer:0` }, claim_count: 15 });
  expect(selected.answer).toBeUndefined();
  let offset = 0, recorded = "";
  do {
    const outcome = await f.readFindings({ reference: selected.reference, text_offset: offset }),
      detail = JSON.parse((outcome.result.content[0] as { text: string }).text);
    recorded += detail.json; offset = detail.next_read?.start_char ?? 0;
    expect(detail.evidence[0]).toMatchObject({ evidence_id: f.receipt.evidence_id, exact_passage: f.receipt.span_text });
    expect(outcome.evidence).toEqual([f.receipt]);
    expect(JSON.stringify(detail).length).toBeLessThan(64_000);
  } while (offset);
  expect(JSON.parse(recorded).result.claims).toEqual(claims);

  const columns = [{ index: 0, name: "Existing finding", prompt: "Explain the existing finding" },
    { index: 1, name: "Further analysis", prompt: "What else follows?" }],
    created = await f.run({ action: "create", columns_config: columns,
      arrangement: { rows: [{ id: "first-branch", title: "First branch", sourceId: selected.sourceId },
        { id: "second-branch", title: "Second branch", sourceId: selected.sourceId,
          evidenceIds: [f.receipt.evidence_id] }], cells: [
        { rowId: "first-branch", columnIndex: 0, items: [{ kind: "answer", chatId: chat.id,
          answerId: selected.reference.answerId, resource: selected.resource }] },
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

it("keeps exact mixed membership and exposes the canonical selection for each row", async () => {
  const f = await fixture(), other = await f.documents.create(owner, { filename: "Notice.txt", fileType: "txt",
    bytes: Buffer.from("Notice may be sent by email. Payment is due on Friday.") }),
    { readResearchResource } = await import("../researchReader"),
    read = await readResearchResource(f.documents, owner, { resource: `document://${other.id}/version/${other.current_version_id}` }),
    file = await f.sources.collect(owner, f.workspace.document.id, { evidence: read.evidence }),
    sourceId = Object.keys(f.workspace.state.sources)[0], otherId = Object.values(file.state.sources)
      .find(({ reference }) => reference.id === other.id)!.id,
    members = [{ sourceId }, { sourceId: otherId, evidenceIds: [read.evidence![0].evidence_id] }],
    selection = await f.sources.selection(owner, file.document.id, { target: "sources", members });
  expect(selection.subjects).toHaveLength(2);
  expect(selection.subjects.find((item) => item.sourceId === sourceId)?.evidence).toBeUndefined();
  expect(selection.subjects.find((item) => item.sourceId === otherId)?.evidence).toEqual(read.evidence);
  expect((await f.sources.selection(owner, file.document.id, { target: "passages", members })).subjects)
    .toEqual(selection.subjects);
  const explicitPassage = await f.sources.selection(owner, file.document.id, { target: "sources",
    sourceIds: [otherId], evidenceIds: [read.evidence![0].evidence_id] });
  expect(explicitPassage.subjects[0].evidence).toEqual(read.evidence);
  expect((await f.sources.selection(owner, file.document.id, { target: "sources", members,
    sourceIds: [sourceId] })).subjects.map(({ sourceId }) => sourceId)).toEqual([sourceId]);
  expect((await f.sources.selection(owner, file.document.id, { target: "sources", members,
    sourceIds: [randomUUID()] })).subjects).toEqual([]);
  expect((await f.sources.selection(owner, file.document.id, { target: "sources", members,
    evidenceIds: [f.receipt.evidence_id] })).subjects).toEqual([
    expect.objectContaining({ sourceId, evidence: [f.receipt] }),
  ]);
  expect((await f.sources.selection(owner, file.document.id, { target: "sources", members,
    evidenceIds: ["outside-the-selected-passages"] })).subjects).toEqual([]);
  const created = await f.application.create(owner, { research_file_id: file.document.id,
    research_selection: { target: "sources", members }, columns_config: [] }),
    detail = await f.application.detail(owner, created.id);
  expect(detail.documents.map(({ selection }) => selection)).toEqual([
    { sourceIds: [sourceId], target: "sources" },
    { sourceIds: [otherId], target: "passages", evidenceIds: read.evidence!.map(({ evidence_id }) => evidence_id) },
  ]);
  const whole = await f.sources.selection(owner, file.document.id, { target: "sources",
    members: [...members, { sourceId: otherId }] });
  expect(whole.subjects.find((item) => item.sourceId === otherId)?.evidence).toBeUndefined();
});

it("resolves label membership live while a queued table agent keeps its permitted passages and question", async () => {
  const f = await fixture(), labelId = randomUUID(), sourceId = Object.keys(f.workspace.state.sources)[0];
  let file = (await f.research.commitResearchFile(f.documents, owner, f.workspace,
    { type: "label", id: labelId, name: "Payment", scope: "highlight" }))!;
  file = (await f.research.commitResearchFile(f.documents, owner, file,
    { type: "label-selection", target: "passages", evidenceIds: [f.receipt.evidence_id], assign: [labelId], mode: "add" }))!;
  const table = await f.application.create(owner, { research_file_id: file.document.id,
    research_selection: { target: "passages", labelIds: [labelId] },
    columns_config: [{ index: 0, name: "Term", prompt: "When is payment due?", format: "text" }] }),
    queued = await f.application.generate(owner, table.id, { model: "codex:gpt-5.6" }),
    { getJob } = await import("../jobQueue"), job = (await getJob(queued.job_ids[0], owner.userId))!;
  file = (await f.sources.get(owner, file.document.id))!;
  await f.research.commitResearchFile(f.documents, owner, file,
    { type: "label-selection", target: "passages", evidenceIds: [f.receipt.evidence_id], assign: [labelId], mode: "remove" });
  expect((await f.application.detail(owner, table.id)).review.document_ids).toEqual([]);
  const { createTabularApplication } = await import("../tabular/application"),
    { tabularRepository } = await import("../relationalTabularRepository"),
    { tabularAgentJobHandler } = await import("../tabular/agents"),
    app = createTabularApplication(tabularRepository, f.documents, await f.runtime.projects(), {
      sources: async () => f.sources, settings: async () => ({ title_model: "codex:gpt-5.6", tabular_model: "codex:gpt-5.6",
        api_keys: {}, legal_research_us: false, last_selected_chat_model: null, last_selected_reasoning_effort: null }),
      runTurn: async (options) => {
        expect(options.messages[0].content).toContain("When is payment due?");
        expect([...options.evidenceState!.evidence.keys()]).toEqual([f.receipt.evidence_id]);
        const state = options.evidenceState!, context = { evidence: state, operation: options.operation!, addEvent() {} },
          submit = options.createTools(state, "main", context).find(({ name }) => name === "submit_extraction")!;
        await submit.execute({ column_index: 0, value: "Thirty days", flag: "green", outcome: "answered",
          claims: [{ text: "Payment is due in thirty days.", evidence_ids: [f.receipt.evidence_id] }] }, context,
        new AbortController().signal, { id: "submit", name: submit.name, input: {} });
        return { status: "complete", fullText: "", citations: [], events: [], evidence: state };
      },
    });
  await tabularAgentJobHandler(app)(job, { signal: new AbortController().signal, progress: async () => {} });
  const findings = await f.sources.findings(owner, file.document.id, { offset: 0, limit: 10 });
  expect(findings.items).toEqual([expect.objectContaining({ sourceId, kind: "result",
    answer: expect.objectContaining({ value: "Thirty days" }), evidence: [f.receipt] })]);
  await f.application.stop(owner, table.id);
});

it("preserves the first observed passage when extraction fails before submitting an answer", async () => {
  const f = await fixture(), table = await f.application.create(owner, { document_ids: [f.source.id],
    columns_config: [{ index: 0, name: "Payment", prompt: "Explain payment" }] }), id = table.scope_config!.research_file_id!,
    { createTabularApplication } = await import("../tabular/application"),
    { tabularRepository } = await import("../relationalTabularRepository"),
    app = createTabularApplication(tabularRepository, f.documents, await f.runtime.projects(), {
      sources: async () => f.sources, settings: async () => ({ title_model: "codex:gpt-5.6", tabular_model: "codex:gpt-5.6",
        api_keys: {}, legal_research_us: false, last_selected_chat_model: null, last_selected_reasoning_effort: null }),
      runTurn: async () => { throw new Error("Model unavailable"); },
    });
  expect((await f.sources.items(owner, id, { kind: "passages", offset: 0, limit: 10 })).total).toBe(0);
  await expect(app.runAgent(owner, { reviewId: table.id, documentId: f.source.id, jobId: "failed-job" }))
    .rejects.toThrow("Model unavailable");
  const saved = await f.sources.items(owner, id, { kind: "evidence", offset: 0, limit: 10 });
  expect(saved.total).toBe(1);
  expect(saved.items[0].value).toMatchObject({ receipt: { span_text: "Payment is due in thirty days." } });
  expect((await f.sources.items(owner, id, { kind: "passages", offset: 0, limit: 10 })).total).toBe(0);
  expect((await tabularRepository.detail(owner, table.id))?.cells[0]).toMatchObject({ status: "error", content: null });
});

it("reuses a canonical typed table result across arrangements without copying its answer", async () => {
  const f = await fixture(), sourceId = Object.keys(f.workspace.state.sources)[0],
    columns = [{ index: 0, name: "Days", prompt: "How many days?", format: "number" }],
    original = await f.application.create(owner, { research_file_id: f.workspace.document.id, columns_config: columns }),
    { tabularRepository } = await import("../relationalTabularRepository"),
    stored = (await tabularRepository.detail(owner, original.id))!, reference = { kind: "cell" as const,
      reviewId: original.id, rowId: f.source.id, columnIndex: 0 }, content = { value: 30, summary: "30",
      reasoning: "Payment is due thirty days after receipt.", flag: "yellow" as const, outcome: "answered" as const,
      coverage: "partial" as const, resource: `document://${f.source.id}/version/${f.source.current_version_id}`,
      claims: [{ text: "The payment period is thirty days.", evidence_ids: [f.receipt.evidence_id] }], evidence: [f.receipt] };
  await tabularRepository.setCell(owner, { reviewId: original.id, documentId: f.source.id, columnIndex: 0,
    expected: stored.cells[0], status: "done", content });
  const linked = await f.application.create(owner, { research_file_id: f.workspace.document.id, columns_config: columns,
    arrangement: { rows: [{ id: "payment", title: "Payment", sourceId }],
      cells: [{ rowId: "payment", columnIndex: 0, items: [reference] }] } }),
    result = await f.readFindings({ reference }), data = JSON.parse((result.result.content[0] as { text: string }).text);
  expect(data.result).toMatchObject({ value: 30, reasoning: content.reasoning, flag: "yellow", coverage: "partial" });
  expect(result.evidence).toEqual([f.receipt]);
  const support = await f.readFindings({ reference, evidence_id: f.receipt.evidence_id });
  expect(JSON.parse((support.result.content[0] as { text: string }).text)).toMatchObject({
    evidence_id: f.receipt.evidence_id, exact_passage: f.receipt.span_text });
  expect(support.evidence).toEqual([f.receipt]);
  expect((await f.application.detail(owner, linked.id)).cells[0].content).toMatchObject(content);
  expect((await tabularRepository.detail(owner, linked.id))?.cells[0]).toMatchObject({ status: "pending", content: null });
  const latest = (await tabularRepository.detail(owner, original.id))!.cells[0];
  await tabularRepository.setCell(owner, { reviewId: original.id, documentId: f.source.id, columnIndex: 0,
    expected: latest, status: "done", content: { ...content, flag: "green", reasoning: "Confirmed from the payment clause." } });
  expect((await f.application.detail(owner, linked.id)).cells[0].content).toMatchObject({ value: 30,
    flag: "green", reasoning: "Confirmed from the payment clause.", evidence: [f.receipt] });

  const other = await f.createWorkspace("Other analysis");
  await f.sources.bind(owner, other.document.id, { tableId: linked.id });
  const crossReference = { kind: "cell" as const, reviewId: linked.id, rowId: "payment", columnIndex: 0 },
    imported = await (await f.sources.readFindings(owner, other.document.id)).resolve(crossReference);
  expect(imported).toMatchObject({ sourceId: Object.keys(other.state.sources)[0], answer: {
    value: 30, flag: "green", reasoning: "Confirmed from the payment clause." }, evidence: [f.receipt] });
  expect((await f.application.detail(owner, linked.id)).review.scope_config?.research_file_id)
    .toBe(f.workspace.document.id);
  await expect(f.sources.bind(owner, other.document.id, { tableId: linked.id,
    selection: { target: "sources" } })).rejects.toMatchObject({ status: 400 });
});

it("applies a column rename directly and turns a rewritten prompt into a proposal", async () => {
  const f = await fixture(), columns = [{ index: 0, name: "Payment", prompt: "When is payment due?" },
    { index: 1, name: "Notice", prompt: "How is notice given?" }],
    created = await f.run({ action: "create", columns_config: columns }), reviewId = created.value.review_id;

  const renamed = await f.run({ action: "update", review_id: reviewId,
    expected_version: created.value.expected_version,
    columns_config: [{ ...columns[0], name: "Payment date" }, columns[1]] });
  expect(renamed.status).toBe("ok");
  let detail = await f.application.detail(owner, reviewId);
  expect(detail.review.columns_config.map(({ name }) => name)).toEqual(["Payment date", "Notice"]);
  expect(detail.review.proposals ?? []).toHaveLength(0);

  const rewritten = await f.run({ action: "update", review_id: reviewId,
    expected_version: renamed.value.expected_version,
    columns_config: [{ index: 0, name: "Payment date", prompt: "State the payment deadline and any grace period." },
      columns[1]] });
  expect(rewritten.status).toBe("ok");
  detail = await f.application.detail(owner, reviewId);
  expect(detail.review.columns_config[0].prompt).toBe("When is payment due?");
  expect(detail.review.proposals).toHaveLength(1);
  const accepted = await f.run({ action: "accept", review_id: reviewId,
    change_id: detail.review.proposals![0].id, expected_version: rewritten.value.expected_version });
  expect(accepted.status).toBe("ok");
  expect((await f.application.detail(owner, reviewId)).review.columns_config[0].prompt)
    .toBe("State the payment deadline and any grace period.");
});
