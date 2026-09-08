import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./localMode", () => ({ isLocalRuntime: () => true }));
// Previews propose a structure with the model by default; these tests exercise the deterministic fallback.
vi.mock("./chat/turnEngine", () => ({ runChatTurn: async () => { throw new Error("No model in this test"); } }));
const owner = { userId: "00000000-0000-0000-0000-000000000001" };
let directory: string, close: (() => Promise<void>) | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-interop-"));
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("OPEN_LEGAL_DATA_HOME", directory);
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", path.join(directory, "library"));
  vi.stubEnv("SUPABASE_URL", ""); vi.stubEnv("SUPABASE_SECRET_KEY", ""); vi.resetModules();
});
afterEach(async () => {
  await close?.(); close = undefined; vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function fixture() {
  const { runtime } = await import("../runtime"), research = await import("./researchFile"),
    legal = await import("./chat/legalEvidence");
  close = () => runtime.shutdown();
  const documents = await runtime.documents(), tables = await runtime.tabular(), sources = await runtime.sources(),
    chats = await runtime.chats(), labelId = randomUUID(), typeId = randomUUID(),
    receipt = (index: number) => legal.createA2AJPassageEvidence({ citation: "Test 1", name: "Example decision", dataset: "scc", language: "en",
      sourceText: "The provisions are read together. A saving clause does not cure this problem.",
      spanText: index ? "A saving clause does not cure this problem." : "The provisions are read together.", start: index ? 33 : 0,
      end: index ? 75 : 32, locator: { kind: "paragraph", label: String(index + 1) },
      externalUrl: null, sourceClass: "case", sourceReference: { id: "test-source" } }),
    receipts = [receipt(0), receipt(1)];
  let file = await sources.create(owner, { title: "Termination clauses" });
  const act = async (action: Parameters<typeof sources.update>[2]["action"]) => {
    const current = (await sources.get(owner, file.document.id))!;
    file = (await sources.update(owner, file.document.id, { versionId: current.versionId,
      workingRevision: current.workingRevision, action })).file; return file;
  };
  await act({ type: "label", id: labelId, name: "Integrated scheme", scope: "source" });
  await act({ type: "label", id: typeId, name: "Rule", scope: "highlight", color: "#d6b656" });
  file = await sources.collect(owner, file.document.id, { sources: [research.researchReferenceFromEvidence(receipts[0])!], evidence: receipts });
  const sourceId = Object.keys(file.state.sources)[0];
  await act({ type: "annotate", kind: "source", id: sourceId, labelIds: [labelId] });
  await act({ type: "annotate", kind: "evidence", sourceId, id: receipts[0].evidence_id, labelIds: [typeId] });
  const chat = await chats.create(owner, { projectId: null, tabularReviewId: null, researchFileId: file.document.id });
  async function turn(prompt: string, text: string, support = receipts[1], reads = receipts) {
    const state = legal.createLegalEvidenceTurnState(); reads.forEach((receipt) => legal.registerLegalEvidence(state, receipt));
    state.answer = [{ text, evidence_ids: [support.evidence_id] }];
    const current = (await chats.get(owner, chat.id))!, messageId = randomUUID(), turnId = randomUUID();
    await chats.commitTurn(owner, chat.id, { expectedVersion: current.transcript_version,
      userMessage: { id: randomUUID(), turnId, content: prompt }, assistantMessage: { id: messageId, turnId, content: [legal.legalEvidenceReceiptEvent(state)!] } });
    file = await sources.bind(owner, file.document.id, { chatId: chat.id }); return messageId;
  }
  return { runtime, documents, tables, sources, chats, research, legal, labelId, typeId, sourceId, receipts, chat, act, turn, file: () => file };
}
it("files a chat's cited passage under every reviewed concept and undoes the whole proposal", async () => {
  const f = await fixture(); await f.turn("How do these duties interact?", "The provisions are read together.", f.receipts[0]);
  const { researchImportCatalog } = await import("./tabular/researchImport"), file = f.file(),
    subjects = (await f.sources.selection(owner, file.document.id)).subjects,
    parts = await f.research.readResearchEvidenceParts(f.documents, owner, file, [f.sourceId]),
    findings = await f.sources.findings(owner, file.document.id, { chatId: f.chat.id, offset: 0, limit: 50 }),
    catalog = researchImportCatalog(file, subjects, parts, findings.items, { rows: "sources" }),
    support = catalog.entries.filter((entry) => entry.kind === "answer").map(({ id }) => id),
    design = { title: "Interacting duties", labels: [{ key: "honesty", name: "Honest performance" },
      { key: "exclusion", name: "Exclusion of duties" }], assignments: ["honesty", "exclusion"].map((labelKey) =>
      ({ labelKey, rowIds: [f.sourceId], itemIds: support })) },
    preview = await f.sources.previewLabels(owner, file.document.id, { chatId: f.chat.id, design }),
    saved = await f.sources.applyLabels(owner, file.document.id, { chatId: f.chat.id, design, fingerprint: preview.fingerprint });
  expect(saved.state.proposals).toEqual([]);
  const passages = (await f.sources.items(owner, file.document.id,
    { kind: "passages", sourceId: f.sourceId, offset: 0, limit: 50 })).items.flatMap((item) =>
      item.kind === "passage" ? [item.value] : []);
  expect(passages).toHaveLength(3);
  expect(passages.every(({ receipt, labelIds }) => JSON.stringify(receipt) === JSON.stringify(f.receipts[0]) && labelIds.length === 1)).toBe(true);
  expect(new Set(passages.map((item) => item.highlightId ?? item.receipt.evidence_id)).size).toBe(3);
  for (const name of ["Honest performance", "Exclusion of duties"]) {
    const labels = Object.values(saved.state.labels), concept = labels.find((label) => label.name === name && label.scope === "source")!,
      type = labels.find((label) => label.name === name && label.scope === "highlight")!;
    expect(saved.state.sources[f.sourceId].labelIds).toContain(concept.id);
    expect(saved.state.sources[f.sourceId].passages?.labelCounts[type.id]).toBe(1);
  }
  const table = await f.sources.previewTable(owner, file.document.id, {});
  expect(table.design.columns.map(({ name }) => name)).toEqual(["Integrated scheme", "Rule", "Honest performance", "Exclusion of duties"]);
  expect(table.stats.map(({ evidence }) => evidence)).toEqual([0, 1, 1, 1]);
  expect(table.samples.every(({ text }) => text === f.receipts[0].span_text)).toBe(true);
  const history = await f.sources.items(owner, file.document.id, { kind: "history", offset: 0, limit: 1 }), change = history.items[0];
  if (change.kind !== "change") throw new Error("Missing proposal history");
  const restored = await f.act({ type: "undo", changeId: change.value.id });
  expect(restored.state.labels).toEqual(file.state.labels);
  expect(restored.state.sources).toEqual(file.state.sources);
});
it("projects and edits additional highlight instances without changing their shared receipt", async () => {
  const f = await fixture(), typeId = randomUUID(), evidenceId = f.receipts[0].evidence_id;
  await f.act({ type: "label", id: typeId, name: "Additional concept", scope: "highlight" });
  const saved = await f.act({ type: "merge", evidence: [f.receipts[0]], labels: { [evidenceId]: [typeId] } });
  const items = async () => (await f.sources.items(owner, saved.document.id,
    { kind: "passages", sourceId: f.sourceId, offset: 0, limit: 200 })).items
    .flatMap((item) => item.kind === "passage" ? [item.value] : []);
  const before = await items(), extra = before.find((item) => item.highlightId)!;
  expect(saved.state.sources[f.sourceId].passages?.labelCounts).toEqual({ [f.typeId]: 1, [typeId]: 1 });
  await f.act({ type: "annotate", kind: "evidence", sourceId: f.sourceId, id: extra.highlightId!, note: "Only this instance" });
  expect((await items()).find((item) => !item.highlightId)).toEqual(before.find((item) => !item.highlightId));
  expect((await items()).find((item) => item.highlightId)).toEqual({ ...extra, note: "Only this instance" });
  const removed = await f.act({ type: "remove", kind: "evidence", sourceId: f.sourceId, id: extra.highlightId! });
  expect(await items()).toEqual(before.filter((item) => !item.highlightId));
  expect(removed.state.sources[f.sourceId].passages?.labelCounts).toEqual({ [f.typeId]: 1 });
});

it("stores accepted table concepts on the set and projects them into both later proposals", async () => {
  const f = await fixture(), file = await f.sources.create(owner, { title: "Administrative review",
    sources: [f.file().state.sources[f.sourceId].reference], evidence: f.receipts }),
    preview = await f.sources.previewTable(owner, file.document.id, {}), names = ["Reasonableness", "Administrative outcome"],
    design = { ...preview.design, columns: names.map((name, index) => ({ index, name, prompt: `${name}?` })), cells: [] };
  await f.sources.table(owner, file.document.id, { design, fingerprint: preview.fingerprint });
  const labels = await f.sources.previewLabels(owner, file.document.id, {}),
    table = await f.sources.previewTable(owner, file.document.id, {});
  expect(labels.labels.map(label => label.name)).toEqual(names);
  expect(labels.labels.every(label => label.existing)).toBe(true);
  expect(table.design.columns.map(column => column.name)).toEqual(names);
  expect(table.fallback).toBeUndefined();
  expect((await f.sources.previewTable(owner, file.document.id, { repropose: true })).fallback).toEqual(expect.any(String));
});

it("opens existing work as a populated snapshot, leaving new questions pending", async () => {
  const f = await fixture();
  await f.turn("Why was the clause invalid?", "The saving language did not cure the invalid scheme.");
  const preview = await f.sources.previewTable(owner, f.file().document.id, {});
  expect(preview.stats.map(({ kinds }) => kinds)).toEqual([[], ["passages"]]);
  const design = { ...preview.design, columns: [...preview.design.columns, { index: 9, name: "New question", prompt: "Was costs relief granted?", format: "text" as const }] };
  const created = await f.sources.table(owner, f.file().document.id, { design, fingerprint: preview.fingerprint });
  const detail = await f.tables.detail(owner, created.id);
  expect(detail.review.scope_config?.frozen).toBe(true);
  expect(detail.cells.map(({ status }) => status).sort()).toEqual(["done", "pending", "pending"]);
  const answer = detail.cells.find(({ column_index }) => column_index === 1)!.content!;
  expect(answer.claims[0].text).toBe(f.receipts[0].span_text);
  expect(answer.evidence).toEqual([f.receipts[0]]);
  await f.act({ type: "label", id: f.labelId, name: "Renamed classification", scope: "source" });
  await f.act({ type: "label", id: f.typeId, name: "Renamed rule", scope: "highlight" });
  const after = await f.tables.detail(owner, created.id);
  expect(after.cells).toEqual(detail.cells);
  expect(after.review.document_ids).toEqual(detail.review.document_ids);
  const updated = await f.tables.update(owner, created.id, { title: "Reopened table", expected_version: after.review.updated_at });
  expect((await f.tables.detail(owner, updated.id)).cells).toEqual(detail.cells);
});
it("converts only grounded Chat sources and reuses earlier receipts for a selected later message", async () => {
  const f = await fixture(), earlier = await f.turn("First question", "Earlier answer"),
    later = await f.turn("Later question", "Later answer grounded in an earlier read", f.receipts[0], []);
  const unrelated = f.legal.createA2AJPassageEvidence({ citation: "Other", name: "Only read", dataset: "scc", language: "en",
    sourceText: "Unrelated passage", spanText: "Unrelated passage", start: 0, end: 17, externalUrl: null,
    sourceClass: "case", sourceReference: { id: "unrelated" } });
  await f.sources.collect(owner, f.file().document.id, { evidence: [unrelated] });
  const preview = await f.sources.previewTable(owner, f.file().document.id, { chatId: f.chat.id, messageIds: [later] });
  expect(preview.rows).toHaveLength(1);
  expect(preview).toMatchObject({ question: "Later question", proposed: false, fallback: undefined });
  // Saved concepts are projected without asking the model to organize the same research again.
  expect(preview.design.columns.some(({ name }) => name === "First question" || name === "Later question")).toBe(false);
  expect(preview.design.columns.map(({ name }) => name)).toEqual(["Integrated scheme", "Rule"]);
  const review = await f.sources.table(owner, f.file().document.id, { chatId: f.chat.id, messageIds: [later], design: preview.design, fingerprint: preview.fingerprint });
  const detail = await f.tables.detail(owner, review.id), answer = detail.cells.at(-1)!.content!;
  expect(answer.claims[0].text).toBe(f.receipts[0].span_text);
  expect(answer.evidence).toEqual([f.receipts[0]]);
  expect(earlier).not.toBe(later);
});
it("rejects stale previews without creating a partial table", async () => {
  const f = await fixture(), preview = await f.sources.previewTable(owner, f.file().document.id, {});
  await f.act({ type: "label", id: f.labelId, name: "Changed", scope: "source" });
  await expect(f.sources.table(owner, f.file().document.id, { design: preview.design, fingerprint: preview.fingerprint })).rejects.toMatchObject({ status: 409 });
  expect((await f.sources.views(owner, f.file().document.id)).tables).toHaveLength(0);
});
it("saves only deliberately requested claim support, without promoting other read receipts", async () => {
  const f = await fixture(); await f.turn("Why?", "This is supported by the second passage.");
  const before = (await f.sources.get(owner, f.file().document.id))!,
    finding = (await f.sources.findings(owner, before.document.id, { offset: 0, limit: 20 })).items[0];
  const beforeParts = await f.research.readResearchEvidenceParts(f.documents, owner, before, [f.sourceId]);
  expect(beforeParts.get(f.sourceId)![f.receipts[1].evidence_id].labelIds).toEqual([]);
  const saved = await f.sources.saveFindings(owner, before.document.id, { references: [finding.reference], typeId: f.typeId,
    versionId: before.versionId, workingRevision: before.workingRevision });
  expect(saved.saved).toBe(1);
  const parts = await f.research.readResearchEvidenceParts(f.documents, owner, saved.file, [f.sourceId]);
  expect(parts.get(f.sourceId)![f.receipts[1].evidence_id]).toMatchObject({ receipt: f.receipts[1], labelIds: [f.typeId] });
  expect(parts.get(f.sourceId)![f.receipts[0].evidence_id]).toEqual(beforeParts.get(f.sourceId)![f.receipts[0].evidence_id]);
  await expect(f.sources.saveFindings(owner, before.document.id, { references: [finding.reference],
    versionId: before.versionId, workingRevision: before.workingRevision })).rejects.toMatchObject({ status: 409 });
});
it("passes selected Table results back to Chat with exactly their original support", async () => {
  const f = await fixture(); await f.turn("Why?", "Grounded prior reasoning.");
  const table = await f.sources.table(owner, f.file().document.id, {}), detail = await f.tables.detail(owner, table.id),
    reference = { kind: "cell" as const, reviewId: table.id, rowId: f.sourceId, columnIndex: 1 },
    selection = { target: "sources" as const, sourceIds: [f.sourceId], findingRefs: [reference] };
  const context = await f.sources.context(owner, f.file().document.id, selection);
  const { readTabularCells } = await import("./chat/tabularCells"), read = readTabularCells(detail, undefined, undefined, { context });
  expect(JSON.parse(read.content).cells).toEqual([expect.objectContaining({ col_index: 1, claims: [{ text: f.receipts[0].span_text, evidence_ids: [f.receipts[0].evidence_id] }] })]);
  expect(read.evidence).toEqual([f.receipts[0]]);
  const findings = await f.sources.findings(owner, f.file().document.id, { offset: 0, limit: 10, references: [reference], subjects: context.subjects });
  expect(findings.items.map(({ reference: ref }) => ref)).toEqual([reference]);
  await expect(f.sources.findings(owner, f.file().document.id, { offset: 0, limit: 10, references: [reference],
    reference: { ...reference, columnIndex: 0 } })).rejects.toMatchObject({ status: 400 });
});
it("does not silently reseed a frozen answer during column edits and preserves pending new questions", async () => {
  const f = await fixture(), review = await f.sources.table(owner, f.file().document.id, {}), original = await f.tables.detail(owner, review.id);
  await f.act({ type: "label", id: f.labelId, name: "Later category", scope: "source" });
  await f.tables.update(owner, review.id, { expected_version: original.review.updated_at,
    columns_config: [...original.review.columns_config.map((col) => ({ ...col, name: col.name + " renamed" })),
      { index: 9, name: "New question", prompt: "What is not researched?" }] });
  const detail = await f.tables.detail(owner, review.id);
  expect(detail.cells.find(({ column_index }) => column_index === 0)?.content).toEqual(original.cells[0].content);
  expect(detail.cells.find(({ column_index }) => column_index === 9)).toMatchObject({ status: "pending", content: null });
  await f.tables.update(owner, review.id, { expected_version: detail.review.updated_at,
    columns_config: detail.review.columns_config.map((col) => col.index === 0 ? { ...col, prompt: "A different question" } : col) });
  expect((await f.tables.detail(owner, review.id)).cells.find(({ column_index }) => column_index === 0)).toMatchObject({ status: "pending", content: null });
});
it("keeps accepted highlight promotions reversible without altering the grounded answer", async () => {
  const f = await fixture(); await f.turn("Why?", "Prior reasoning.");
  const current = (await f.sources.get(owner, f.file().document.id))!, ref = (await f.sources.findings(owner, current.document.id, { offset: 0, limit: 10 })).items[0].reference;
  const saved = await f.sources.saveFindings(owner, current.document.id, { references: [ref], typeId: f.typeId,
    versionId: current.versionId, workingRevision: current.workingRevision });
  await f.act({ type: "remove", kind: "evidence", sourceId: f.sourceId, id: f.receipts[1].evidence_id });
  const finding = await (await f.sources.readFindings(owner, current.document.id)).resolve(ref);
  expect(finding?.evidence).toEqual([f.receipts[1]]);
  expect(finding?.answer.claims[0].text).toBe("Prior reasoning.");
  expect(saved.saved).toBe(1);
});
it("can explicitly revise snapshot mappings without leaving stale copied cells behind", async () => {
  const f = await fixture(), review = await f.sources.table(owner, f.file().document.id, {}), original = await f.tables.detail(owner, review.id),
    arrangement = original.review.scope_config!.arrangement!;
  await f.tables.update(owner, review.id, { expected_version: original.review.updated_at,
    arrangement: { ...arrangement, cells: arrangement.cells.filter(({ columnIndex }) => columnIndex !== 0) } });
  const after = await f.tables.detail(owner, review.id);
  expect(after.cells.find(({ column_index }) => column_index === 0)).toMatchObject({ status: "pending", content: null });
  expect(after.cells.find(({ column_index }) => column_index === 1)?.content?.claims).toEqual(original.cells[1].content?.claims);
});
it("refuses cross-account conversion, previews without changing research, and keeps table inputs fixed", async () => {
  const f = await fixture(), before = await f.sources.get(owner, f.file().document.id);
  await f.sources.previewTable(owner, f.file().document.id, {});
  expect(await f.sources.get(owner, f.file().document.id)).toEqual(before);
  await expect(f.sources.previewTable({ userId: "00000000-0000-0000-0000-000000000002" }, f.file().document.id, {})).rejects.toMatchObject({ status: 404 });
  const review = await f.sources.table(owner, f.file().document.id, {});
  const another = { provider: "a2aj" as const, id: "another", kind: "case" as const, title: "Another decision" };
  await f.act({ type: "source", reference: another, labelIds: [f.labelId] });
  expect((await f.tables.detail(owner, review.id)).review.document_ids).toEqual([f.sourceId]);
});
it("reviews categorical labels for selected rows in the shared proposal before applying them", async () => {
  const f = await fixture();
  await f.act({ type: "source", reference: { provider: "a2aj", id: "second-source", kind: "case", title: "Second decision" } });
  const file = (await f.sources.get(owner, f.file().document.id))!, ids = Object.keys(file.state.sources),
    review = await f.tables.create(owner, { title: "Outcome", research_file_id: file.document.id,
      columns_config: [{ index: 0, name: "Outcome", prompt: "Was the clause upheld?", format: "yes_no" }] }),
    { tabularRepository } = await import("./relationalTabularRepository");
  const detail = await f.tables.detail(owner, review.id), { tabularSubjectId } = await import("./tabularStore");
  const firstRow = detail.review.scope_config!.subjects.find(({ sourceId }) => sourceId === f.sourceId)!;
  for (const cell of detail.cells) {
    const value = cell.document_id === tabularSubjectId(firstRow);
    await tabularRepository.setCell(owner, { reviewId: review.id, documentId: cell.document_id, columnIndex: 0,
      expected: { status: cell.status, content: cell.content }, status: "done", content: { value, claims: [], evidence: [],
        resource: detail.review.scope_config!.subjects.find((subject) => tabularSubjectId(subject) === cell.document_id)!.resource, coverage: "complete", missing: [] } });
  }
  const input = { tableId: review.id, columnIndex: 0, selection: { target: "sources" as const, sourceIds: [f.sourceId] } },
    before = await f.sources.get(owner, file.document.id), proposal = await f.sources.previewLabels(owner, file.document.id, input);
  expect(await f.sources.get(owner, file.document.id)).toEqual(before);
  const accepted = await f.sources.applyLabels(owner, file.document.id, { ...input, design: proposal.design, fingerprint: proposal.fingerprint });
  const yes = Object.values(accepted.state.labels).find(({ name }) => name === "Yes")!;
  expect(yes).toBeDefined(); expect(accepted.state.sources[f.sourceId].labelIds).toContain(yes.id);
  expect(Object.values(accepted.state.labels).some(({ name }) => name === "No")).toBe(false);
  expect(accepted.state.sources[ids.find((id) => id !== f.sourceId)!].labelIds).toEqual([]);
});
it.each([false, true])("writes a grounded cell-chat answer with its receipts and undoes it (linked=%s)", async (linked) => {
  const f = await fixture(), snapshot = await f.sources.table(owner, f.file().document.id, {}),
    review = linked ? await f.tables.create(owner, { research_file_id: f.file().document.id,
      columns_config: snapshot.columns_config, arrangement: snapshot.scope_config!.arrangement }) : snapshot,
    before = await f.tables.detail(owner, review.id), rowId = before.review.document_ids[0],
    columnIndex = before.review.columns_config[0].index, messageId = await f.turn("Clarify this cell", "The saving clause does not cure the defect."),
    input = { expected_version: before.review.updated_at, cell_answer: { rowId, columnIndex, chatId: f.chat.id, messageId } };
  const changed = await f.tables.update(owner, review.id, input), after = await f.tables.detail(owner, review.id),
    answer = after.cells.find((cell) => cell.document_id === rowId && cell.column_index === columnIndex)!;
  expect(answer).toMatchObject({ status: "done", content: { summary: "The saving clause does not cure the defect.",
    claims: [{ text: "The saving clause does not cure the defect.", evidence_ids: [f.receipts[1].evidence_id] }],
    evidence: [f.receipts[1]], origin: { chatId: f.chat.id, messageId } } });
  expect(after.cells.filter((cell) => cell.column_index !== columnIndex).map(({ content }) => content))
    .toEqual(before.cells.filter((cell) => cell.column_index !== columnIndex).map(({ content }) => content));
  expect(changed.updated_at).not.toBe(before.review.updated_at);
  await expect(f.tables.update(owner, review.id, input)).rejects.toMatchObject({ status: 409 });
  await expect(f.tables.update(owner, review.id, { ...input, expected_version: changed.updated_at,
    cell_answer: { ...input.cell_answer, messageId: "unrecorded" } })).rejects.toMatchObject({ status: 400 });
  const history = (await f.tables.history(owner, review.id, { offset: 0, limit: 1 })).items[0];
  await f.tables.change(owner, review.id, { id: history.id, action: "undo", expected_version: changed.updated_at });
  const restored = await f.tables.detail(owner, review.id);
  expect(restored.cells.map(({ content }) => content)).toEqual(before.cells.map(({ content }) => content));
  expect(restored.review.scope_config?.arrangement).toEqual(before.review.scope_config?.arrangement);
});
it("reads saved workspace passages through their handles without fetching the source and files a finding reversibly", async () => {
  const f = await fixture(), { runLocalAssistantTools } = await import("./__tests__/support/localAssistantTools"),
    { a2ajLegalSourceProvider } = await import("./legalSources/a2aj"),
    fetch = vi.spyOn(a2ajLegalSourceProvider, "document").mockRejectedValue(new Error("Source must not be fetched")),
    context = await f.sources.context(owner, f.file().document.id, { target: "sources", labelIds: [f.labelId] }),
    state = f.legal.createLegalEvidenceTurnState(), receipt = f.receipts[0];
  expect(context.subjects[0].savedEvidence).toEqual([receipt]);
  const results = await runLocalAssistantTools(owner.userId, [
    { name: "Read", id: "inventory", input: { file_path: "selection" } },
    { name: "Read", id: "saved", input: { file_path: receipt.evidence_id } },
    { name: "Read", id: "pinpoint", input: { file_path: context.subjects[0].resource,
      locator_kind: receipt.locator.kind, locator: `par${receipt.locator.label}` } },
  ], { documents: f.documents, sources: f.sources, researchContext: context, legalEvidence: state });
  expect(JSON.parse(results[0].content).items).toContainEqual(expect.objectContaining({ evidence_id: receipt.evidence_id }));
  for (const result of results.slice(1)) expect(JSON.parse(result.content)).toMatchObject({ exact_passage: receipt.span_text });
  expect(fetch).not.toHaveBeenCalled();
  await f.act({ type: "remove", kind: "evidence", sourceId: f.sourceId, id: f.receipts[1].evidence_id });
  await f.turn("What follows?", "Supported conclusion.");
  const before = (await f.sources.get(owner, f.file().document.id))!, finding = (await f.sources.findings(owner,
    before.document.id, { chatId: f.chat.id, offset: 0, limit: 10 })).items[0],
    filed = await f.sources.saveFindings(owner, before.document.id, { references: [finding.reference], typeId: f.labelId,
      versionId: before.versionId, workingRevision: before.workingRevision }),
    highlights = (await f.sources.items(owner, before.document.id, { kind: "passages", offset: 0, limit: 20 })).items,
    history = (await f.sources.items(owner, before.document.id, { kind: "history", offset: 0, limit: 1 })).items[0];
  expect(highlights).toContainEqual(expect.objectContaining({ kind: "passage", value: expect.objectContaining({
    receipt: f.receipts[1], labelIds: [Object.values(filed.file.state.labels).find(({ name, scope }) => name === "Integrated scheme" && scope === "highlight")!.id] }) }));
  if (history.kind !== "change") throw new Error("Missing filing history");
  const restored = (await f.sources.update(owner, before.document.id, { versionId: filed.file.versionId,
    workingRevision: filed.file.workingRevision, action: { type: "undo", changeId: history.value.id } })).file;
  expect(restored.state.sources).toEqual(before.state.sources);
  expect(restored.state.labels).toEqual(before.state.labels);
});
it.each([false, true])("round trips every table column with joint evidence and undoes filing (existing labels=%s)", async (existing) => {
  const f = await fixture(), columns = ["Honesty", "Exclusion", "Remedy"].map((name, index) => ({ index: index + 4, name, prompt: `${name}?`, format: "text" })),
    other = f.legal.createA2AJPassageEvidence({ citation: "Test 2", name: "Other decision", dataset: "scc", language: "en",
      sourceText: "A joint conclusion.", spanText: "A joint conclusion.", start: 0, end: 19,
      locator: { kind: "paragraph", label: "2" }, externalUrl: null, sourceClass: "case", sourceReference: { id: "other-source" } }),
    evidence = [f.receipts[0], other],
    initial = await f.sources.create(owner, { title: "Contract duties", sources: [f.file().state.sources[f.sourceId].reference], evidence: [f.receipts[0]] }),
    review = await f.tables.create(owner, { research_file_id: initial.document.id, columns_config: columns }),
    { tabularRepository } = await import("./relationalTabularRepository"), detail = await f.tables.detail(owner, review.id);
  for (const cell of detail.cells) await tabularRepository.setCell(owner, { reviewId: review.id, documentId: cell.document_id,
    columnIndex: cell.column_index, expected: cell, status: "done", content: { value: "Supported conclusion", summary: "Supported conclusion",
      claims: [{ text: "Supported conclusion", evidence_ids: evidence.map(({ evidence_id }) => evidence_id) }], evidence,
      resource: detail.review.scope_config!.subjects[0].resource, coverage: "complete" } });
  if (existing) { const current = (await f.sources.get(owner, initial.document.id))!;
    await f.sources.update(owner, current.document.id, { versionId: current.versionId,
      workingRevision: current.workingRevision, action: { type: "label", name: "Honesty", scope: "source", definition: "Honesty?" } }); }
  const before = await f.sources.ensure(owner, { tableId: review.id }), input = { tableId: review.id },
    preview = await f.sources.previewLabels(owner, before.document.id, input);
  expect(preview.labels.map(({ name }) => name)).toEqual(columns.map(({ name }) => name));
  expect(await f.sources.get(owner, before.document.id)).toEqual(before);
  const saved = await f.sources.applyLabels(owner, before.document.id, { ...input, design: preview.design, fingerprint: preview.fingerprint }),
    page = await f.sources.items(owner, saved.document.id, { kind: "passages", offset: 0, limit: 50 }),
    passages = page.items.flatMap((item) => item.kind === "passage" ? [item.value] : []);
  expect(passages).toHaveLength(6);
  expect(new Set(passages.map((item) => item.highlightId ?? item.receipt.evidence_id)).size).toBe(6);
  for (const receipt of evidence) {
    const copies = passages.filter((passage) => passage.receipt.evidence_id === receipt.evidence_id);
    expect(copies).toHaveLength(3);
    expect(copies.every((passage) => JSON.stringify(passage.receipt) === JSON.stringify(receipt) && passage.labelIds.length === 1)).toBe(true);
    const source = Object.values(saved.state.sources).find(({ reference }) =>
      f.research.researchSourceResource(reference) === f.legal.legalEvidenceResourceReference(receipt))!;
    expect(Object.values(source.passages!.labelCounts)).toEqual([1, 1, 1]);
  }
  expect(new Set(passages.map(({ labelIds }) => saved.state.labels[labelIds[0]].name))).toEqual(new Set(columns.map(({ name }) => name)));
  const returned = await f.sources.previewTable(owner, saved.document.id, {});
  expect(returned.design.columns.map(({ name, prompt }) => ({ name, prompt }))).toEqual(columns.map(({ name, prompt }) => ({ name, prompt })));
  const history = (await f.sources.items(owner, saved.document.id, { kind: "history", offset: 0, limit: 1 })).items[0];
  if (history.kind !== "change") throw new Error("Missing filing history");
  const restored = (await f.sources.update(owner, saved.document.id, { versionId: saved.versionId,
    workingRevision: saved.workingRevision, action: { type: "undo", changeId: history.value.id } })).file;
  expect(restored.state.labels).toEqual(before.state.labels);
  expect(restored.state.sources).toEqual(before.state.sources);
});
it("exposes reviewed conversions and explicit evidence saving through the authenticated routes", async () => {
  const f = await fixture(); await f.turn("Why?", "Grounded reason.");
  const express = (await import("express")).default, request = (await import("supertest")).default,
    { createSourceWorkspacesRouter } = await import("../routes/sourceWorkspaces"), app = express();
  app.use(express.json()); app.use("/research", createSourceWorkspacesRouter(f.sources));
  const url = `/research/${f.file().document.id}`, before = await f.sources.get(owner, f.file().document.id),
    preview = await request(app).post(`${url}/table/preview`).send({ chatId: f.chat.id });
  expect(preview.status).toBe(200);
  expect(await f.sources.get(owner, f.file().document.id)).toEqual(before);
  expect((await request(app).post(`${url}/table`).send({ chatId: f.chat.id, design: preview.body.design })).status).toBe(409);
  const opened = await request(app).post(`${url}/table`).send({ chatId: f.chat.id, design: preview.body.design, fingerprint: preview.body.fingerprint });
  expect(opened.status).toBe(200);
  const current = (await f.sources.get(owner, f.file().document.id))!, ref = { kind: "cell", reviewId: opened.body.id, rowId: f.sourceId, columnIndex: 1 };
  const saved = await request(app).post(`${url}/save-findings`).send({ references: [ref], typeId: f.typeId,
    versionId: current.versionId, workingRevision: current.workingRevision });
  expect(saved.status).toBe(200); expect(saved.body.saved).toBe(1);
  expect((await request(app).post(`${url}/table/preview`).send({ messageIds: ["missing-chat"] })).status).toBe(400);
});

// Real repository fixtures: instrumentation observes I/O, not replacement return values.
async function seededFindings(f: Awaited<ReturnType<typeof fixture>>, rows = 100, columns = 1) {
  const { tabularRepository: repository } = await import("./relationalTabularRepository"),
    file = f.file(), source = file.state.sources[f.sourceId], resource = f.research.researchSourceResource(source.reference),
    rowIds = Array.from({ length: rows }, (_, index) => `row:${index}`),
    fields = Array.from({ length: columns }, (_, index) => ({ index, name: `Question ${index}`, prompt: `Question ${index}`, format: "text" })),
    references = rowIds.flatMap((rowId) => fields.map(({ index }) => ({ kind: "cell" as const, reviewId: "", rowId, columnIndex: index }))),
    result = await repository.create(owner, { projectId: null, title: "Recorded findings", documentIds: rowIds, columns: fields,
      scopeConfig: { research_file_id: file.document.id, frozen: true,
        subjects: rowIds.map((rowId) => ({ rowId, sourceId: source.id, reference: source.reference, resource })) },
      seedCells: references.map((ref) => ({ document_id: ref.rowId, column_index: ref.columnIndex, status: "done", content: {
        summary: `${ref.rowId}/${ref.columnIndex}`, value: `${ref.rowId}/${ref.columnIndex}`, resource,
        claims: [{ text: `${ref.rowId}/${ref.columnIndex}`, evidence_ids: [f.receipts[0].evidence_id] }],
        evidence: [f.receipts[0]], outcome: "answered", coverage: "complete",
      } })) });
  if (result.status !== "committed") throw new Error("Could not seed findings");
  await f.act({ type: "batch", title: "Review concepts", actions: fields.map(({ name, prompt }) =>
    ({ type: "label", name, definition: prompt, scope: "source" })) });
  references.forEach((ref) => { ref.reviewId = result.value.id; });
  await f.sources.collect(owner, file.document.id, { tables: [result.value.id] });
  return { repository, review: result.value, references, resource };
}

it("previews 100 selected stored cells with one workspace read and one shared table load", async () => {
  const f = await fixture(), seeded = await seededFindings(f), read = vi.spyOn(f.documents, "read"),
    detail = vi.spyOn(seeded.repository, "detail");
  const preview = await f.sources.previewTable(owner, f.file().document.id, { findingRefs: seeded.references });
  expect(preview.design.cells.some(({ itemIds }) => itemIds.length === 100)).toBe(true);
  expect(preview.samples.some(({ text }) => text.includes("row:0/0"))).toBe(true);
  expect(read.mock.calls.filter(([, id]) => id === f.file().document.id)).toHaveLength(1);
  expect(detail.mock.calls.filter(([, id]) => id === seeded.review.id)).toHaveLength(1);
});

it("shares indexed lookups across concurrent reads and preserves row/column order, pagination and missing results", async () => {
  const f = await fixture(), seeded = await seededFindings(f, 8, 3), detail = vi.spyOn(seeded.repository, "detail"),
    reader = await f.sources.readFindings(owner, f.file().document.id);
  const selected = await Promise.all([...seeded.references].reverse().map((ref) => reader.resolve(ref)));
  expect(selected.map((item) => item?.reference)).toEqual([...seeded.references].reverse());
  expect(selected.every((item) => JSON.stringify(item?.evidence) === JSON.stringify([f.receipts[0]]))).toBe(true);
  const page = await reader.list({ offset: 5, limit: 7 });
  expect(page).toMatchObject({ total: 24, next_offset: 12, is_running: false });
  expect(page.items.map(({ reference }) => reference)).toEqual(seeded.references.slice(5, 12));
  expect((await reader.list({ offset: 24, limit: 7 })).items).toEqual([]);
  expect(await reader.resolve({ ...seeded.references[0], rowId: "missing" })).toBeNull();
  expect(await reader.resolve({ ...seeded.references[0], columnIndex: 999 })).toBeNull();
  expect(detail.mock.calls.filter(([, id]) => id === seeded.review.id)).toHaveLength(1);
});

it("extracts a chat once while retaining selected later questions and their earlier supporting reads", async () => {
  const f = await fixture(); await f.turn("Earlier question", "Earlier answer");
  const selectedMessage = await f.turn("Later question", "Later answer", f.receipts[0], []),
    transcript = vi.spyOn(f.chats, "transcript"), read = vi.spyOn(f.documents, "read"),
    reader = await f.sources.readFindings(owner, f.file().document.id),
    page = await reader.list({ chatId: f.chat.id, messageIds: [selectedMessage], offset: 0, limit: 10 });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ question: { prompt: "Later question" },
    answer: { claims: [{ text: "Later answer" }] }, evidence: [f.receipts[0]] });
  const reference = page.items[0].reference;
  const narrowed = await Promise.all(Array.from({ length: 20 }, () => reader.resolve({ ...reference, claimIndices: [0] })));
  expect(narrowed.every((item) => item?.answer.claims.length === 1)).toBe(true);
  await expect(reader.resolve({ ...reference, claimIndices: [1] })).rejects.toMatchObject({ status: 409 });
  expect(transcript).toHaveBeenCalledTimes(1);
  expect(read.mock.calls.filter(([, id]) => id === f.file().document.id)).toHaveLength(1);
});

it("keeps authorization operation-local and refuses unavailable pinned supporting documents", async () => {
  const f = await fixture(), text = "Pinned support", document = await f.documents.create(owner, {
    filename: "support.txt", fileType: "txt", bytes: Buffer.from(text) }), metadata = (await f.documents.metadata(owner, document.id))!,
    receipt = f.legal.createLibraryEvidence({ documentId: document.id, versionId: metadata.current_version_id!,
      filename: "support.txt", sourceSha256: metadata.source_sha256!, start: 0, end: text.length, spanText: text });
  await f.turn("What was recorded?", "The pinned answer", receipt, [receipt]);
  const workspace = f.file().document.id, reader = await f.sources.readFindings(owner, workspace),
    findings = await reader.list({ chatId: f.chat.id, offset: 0, limit: 10 });
  expect(findings.items[0].evidence).toEqual([receipt]);
  await expect(f.sources.readFindings({ userId: randomUUID() }, workspace)).rejects.toMatchObject({ status: 404 });
  const other = await f.sources.create(owner, { title: "Unrelated workspace" });
  await expect((await f.sources.readFindings(owner, other.document.id)).resolve(findings.items[0].reference))
    .rejects.toMatchObject({ status: 404 });
  await f.documents.deleteDocument(owner, document.id, true);
  await expect((await f.sources.readFindings(owner, workspace)).resolve(findings.items[0].reference))
    .rejects.toThrow("supporting document is unavailable");
});

it("uses the fingerprinted findings even if their original cell regenerates inside table creation", async () => {
  const f = await fixture(), seeded = await seededFindings(f, 1), input = { findingRefs: seeded.references },
    preview = await f.sources.previewTable(owner, f.file().document.id, input), create = f.tables.create.bind(f.tables);
  vi.spyOn(f.tables, "create").mockImplementationOnce(async (...args) => {
    const detail = (await seeded.repository.detail(owner, seeded.review.id))!, cell = detail.cells[0];
    expect((await seeded.repository.setCell(owner, { reviewId: seeded.review.id, documentId: cell.document_id,
      columnIndex: cell.column_index, expected: cell, status: "done", content: { ...cell.content!, summary: "Regenerated", value: "Regenerated",
        claims: [{ text: "Regenerated", evidence_ids: [f.receipts[0].evidence_id] }] } })).status).toBe("committed");
    return create(...args);
  });
  const created = await f.sources.table(owner, f.file().document.id, { ...input, design: preview.design, fingerprint: preview.fingerprint }),
    result = await f.tables.detail(owner, created.id);
  expect(result.cells.some(({ content }) => content?.summary === "row:0/0")).toBe(true);
  expect(result.cells.some(({ content }) => content?.summary === "Regenerated")).toBe(false);
  expect((await seeded.repository.detail(owner, seeded.review.id))!.cells[0].content?.summary).toBe("Regenerated");
  await expect(f.sources.table(owner, f.file().document.id, { ...input, design: preview.design, fingerprint: preview.fingerprint }))
    .rejects.toMatchObject({ status: 409 });
});

it("shares raw loads through foreign owning workspaces without caching recursive resolution", async () => {
  const f = await fixture(), seeded = await seededFindings(f, 1), original = f.file().document.id,
    foreign = await f.sources.create(owner, { title: "Owning workspace" }),
    populated = await f.sources.collect(owner, foreign.document.id, {
      sources: [f.file().state.sources[f.sourceId].reference], tables: [seeded.review.id] }),
    sourceId = Object.keys(populated.state.sources)[0],
    columns = [{ index: 0, name: "Answer", prompt: "Original answer", format: "text" }];
  const make = (rowId: string) => f.tables.create(owner, { research_file_id: foreign.document.id,
    columns_config: columns, arrangement: { rows: [{ id: rowId, title: rowId, sourceId }],
      cells: [{ rowId, columnIndex: 0, items: [seeded.references[0]] }] } });
  const a = await make("a"), b = await make("b"), refs = [a, b].map((review, index) => ({
    kind: "cell" as const, reviewId: review.id, rowId: index ? "b" : "a", columnIndex: 0 }));
  await f.sources.collect(owner, original, { tables: [a.id, b.id] });
  const detail = vi.spyOn(seeded.repository, "detail"), read = vi.spyOn(f.documents, "read"),
    reader = await f.sources.readFindings(owner, original), result = await Promise.all(refs.map((ref) => reader.resolve(ref)));
  expect(result.map((item) => item?.answer.value)).toEqual(["row:0/0", "row:0/0"]);
  expect(result.every((item) => item?.sourceId === f.sourceId)).toBe(true);
  for (const reviewId of [a.id, b.id, seeded.review.id])
    expect(detail.mock.calls.filter(([, id]) => id === reviewId)).toHaveLength(1);
  for (const workspace of [original, foreign.document.id])
    expect(read.mock.calls.filter(([, id]) => id === workspace)).toHaveLength(1);
  // Create a cycle through the persistence port, not through recursive mocks.
  for (const [index, review] of [a, b].entries()) {
    const current = (await seeded.repository.detail(owner, review.id))!.review,
      config = current.scope_config!, arrangement = config.arrangement!;
    expect((await seeded.repository.update(owner, review.id, current.updated_at, { scopeConfig: { ...config,
      arrangement: { ...arrangement, cells: [{ ...arrangement.cells[0], items: [refs[1 - index]] }] } } })).status).toBe("committed");
  }
  const cyclic = await f.sources.readFindings(owner, original);
  expect(await cyclic.resolve(refs[0])).toBeNull();
  expect(await cyclic.resolve(seeded.references[0])).toMatchObject({ answer: { value: "row:0/0" } });
});

it("never borrows another claim's permission and does not retain a trashed chat in a later operation", async () => {
  const f = await fixture(); await f.turn("Question", "Answer");
  const workspace = f.file().document.id, reader = await f.sources.readFindings(owner, workspace),
    ref = (await reader.list({ offset: 0, limit: 10 })).items[0].reference;
  await expect(reader.list({ offset: 0, limit: 10, reference: { ...ref, claimIndices: [1] },
    references: [{ ...ref, claimIndices: [0] }] })).rejects.toMatchObject({ status: 400 });
  await f.chats.trash(owner, f.chat.id);
  const reopened = await f.sources.readFindings(owner, workspace);
  expect((await reopened.list({ offset: 0, limit: 10 })).items).toEqual([]);
  await expect(reopened.resolve(ref)).rejects.toMatchObject({ status: 404 });
});

// Opt-in, deterministic I/O/performance fixture. No timing thresholds in the normal suite.
it.skipIf(!process.env.BEAVER_FINDINGS_BENCHMARK)("benchmarks research findings through the real SQLite repository", async () => {
  const { Session } = await import("node:inspector/promises"), { writeFile } = await import("node:fs/promises"),
    results: Record<string, unknown>[] = [];
  for (const [name, rows, columns] of [["single", 1, 1], ["selected-100", 100, 1],
    ["listing-2000", 100, 20], ["listing-10000", 500, 20], ["chat-50", 1, 1]] as const) {
    const f = await fixture(), seeded = await seededFindings(f, rows, columns), workspace = f.file().document.id;
    if (name === "chat-50") for (let index = 0; index < 50; index++) await f.turn(`Question ${index}`, `Answer ${index}`);
    const refs = name === "chat-50" ? (await f.sources.findings(owner, workspace,
      { chatId: f.chat.id, offset: 0, limit: 100 })).items.map(({ reference }) => reference) : seeded.references,
      read = vi.spyOn(f.documents, "read"), detail = vi.spyOn(seeded.repository, "detail"), transcript = vi.spyOn(f.chats, "transcript"),
      times: number[] = [];
    const operation = async () => {
      if (name.startsWith("listing")) {
        const result = await f.sources.findings(owner, workspace, { offset: 0, limit: 50 });
        expect(result.total).toBe(rows * columns);
        expect(result.items.map(({ reference }) => reference)).toEqual(refs.slice(0, 50));
      } else if (name === "single") {
        const result = await f.sources.findings(owner, workspace, { reference: refs[0], offset: 0, limit: 1 });
        expect(result.items[0].answer.value).toBe("row:0/0");
      } else {
        const result = await f.sources.previewTable(owner, workspace, { findingRefs: refs });
        expect(result.design.cells.flatMap(({ itemIds }) => itemIds).length).toBeGreaterThanOrEqual(refs.length);
      }
    };
    for (let iteration = 0; iteration < (name === "single" ? 51 : 8); iteration++) {
      read.mockClear(); detail.mockClear(); transcript.mockClear();
      const start = performance.now(); await operation(); times.push(performance.now() - start);
    }
    const counts = { workspaceReads: read.mock.calls.filter(([, id]) => id === workspace).length,
      tableLoads: detail.mock.calls.length, transcriptLoads: transcript.mock.calls.length }, session = new Session();
    session.connect();
    let sampledBytes: number;
    try {
      await session.post("HeapProfiler.startSampling", { samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      await operation();
      const { profile } = await session.post("HeapProfiler.stopSampling");
      const sum = (node: typeof profile.head): number => node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      sampledBytes = sum(profile.head);
    } finally { session.disconnect(); }
    results.push({ name, rows, columns, firstMs: times[0], medianMs: times.slice(1).sort((a, b) => a - b)[Math.floor((times.length - 1) / 2)],
      ...counts, sampledBytes });
  }
  await writeFile(process.env.BEAVER_FINDINGS_BENCHMARK!, JSON.stringify(results, null, 2));
  console.log("FINDINGS_BENCHMARK", JSON.stringify(results));
}, 120_000);

it("shares a failed raw read only within its operation and excludes unfinished cells from listings", async () => {
  const f = await fixture(), seeded = await seededFindings(f, 2),
    detail = vi.spyOn(seeded.repository, "detail").mockRejectedValueOnce(new Error("Read interrupted")),
    failed = await f.sources.readFindings(owner, f.file().document.id);
  const outcomes = await Promise.allSettled(seeded.references.map((ref) => failed.resolve(ref)));
  expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  expect(detail).toHaveBeenCalledTimes(1);
  const cells = (await seeded.repository.detail(owner, seeded.review.id))!.cells;
  expect((await seeded.repository.setCell(owner, { reviewId: seeded.review.id, documentId: cells[1].document_id,
    columnIndex: cells[1].column_index, expected: cells[1], content: null, status: "pending" })).status).toBe("committed");
  const reader = await f.sources.readFindings(owner, f.file().document.id), page = await reader.list({ offset: 0, limit: 10 });
  expect(page).toMatchObject({ total: 1, next_offset: null });
  expect(page.items[0].answer.value).toBe("row:0/0");
  expect(await reader.resolve(seeded.references[1])).toBeNull();
});
