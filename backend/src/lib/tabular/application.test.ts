import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { DocumentStore } from "../documentStore";
import type { UserApiKeys } from "../llm";
import type { TabularCell, TabularCellContent, TabularColumn, TabularRepository } from "../tabularStore";
import { createLegalEvidenceTurnState, createLibraryEvidence } from "../chat/legalEvidence";
import type { runChatTurn } from "../chat/turnEngine";
import { createTabularApplication, tabularDtos } from "./application";

const scope = { userId: "owner", userEmail: "owner@example.test" };
const review = { id: "review", user_id: "owner", project_id: "project",
  title: "Review", columns_config: [{ index: 0, name: "Law", prompt: "Find law" }],
  document_ids: ["document"], workflow_id: null, shared_with: [], is_owner: true,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
const cell = { id: "cell", review_id: "review", document_id: "document",
  column_index: 0, content: null, status: "pending" as const };

function port(overrides: Partial<TabularRepository> = {}): TabularRepository {
  return {
    page: vi.fn(async () => ({ items: [review], nextAfter: null })),
    create: vi.fn(async () => ({ status: "committed", value: review })),
    detail: vi.fn(async () => ({ review, cells: [cell], documents: [{ id: "document" }] })),
    people: vi.fn(async () => ({ owner: { user_id: "owner", email: null,
      display_name: null }, members: [] })),
    missingRecipient: vi.fn(async () => null),
    update: vi.fn(async (_scope, _id, _version, input) => ({ status: "committed",
      value: { ...review, title: input.title ?? review.title,
        workflow_id: input.workflowId ?? review.workflow_id } })),
    delete: vi.fn(async () => ({ status: "committed", value: null })),
    deleteAll: vi.fn(async () => 0),
    history: vi.fn(async () => ({ items: [], total: 0, next_offset: null })),
    change: vi.fn(async () => ({ status: "committed", value: review })),
    setCell: vi.fn(async (_scope, input) => ({ status: "committed", value: {
      ...cell, status: input.status, content: input.content } })),
    recordGeneration: vi.fn(async () => {}),
    ...overrides,
  };
}
const documentStore = (bytes = Buffer.from("Governing law: Alberta")) => {
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex"),
    metadata = { id: "document", filename: "lease.txt", project_id: "project",
      size_bytes: bytes.length, current_version_id: "v1", source_sha256: sourceSha256 };
  return {
    metadata: vi.fn(async () => metadata),
    metadataMany: vi.fn(async (_scope, ids: string[]) => ids.flatMap((id) => id === "document" ? [metadata]
      : id === "workspace" ? [{ ...metadata, id, filename: "Sources.research.md" }] : [])),
    versions: vi.fn(async () => ({ versions: [{ id: "v1", size_bytes: bytes.length }] })),
    projectionSource: vi.fn(async () => ({ documentId: "document", versionId: "v1",
      fileType: "txt", sourceSha256, readBytes: () => bytes })),
    read: vi.fn(async () => ({ bytes, filename: "lease.txt", fileType: "txt",
      hasPdfRendition: false, version: { id: "v1", version_number: 1, source: null,
        source_sha256: sourceSha256, created_at: null, filename: "lease.txt" } })),
  } as unknown as DocumentStore;
};
const content: TabularCellContent = { summary: "Alberta Yes", claims: [], value: "Alberta Yes",
  flag: "green", evidence: [], outcome: "answered", coverage: "complete", resource: "document://document/version/v1" };
function generated(columns: TabularColumn[], seed?: TabularCell[]) {
  const cells: TabularCell[] = seed ?? columns.map(({ index }) => ({ ...cell, id: `cell-${index}`, column_index: index }));
  const repository = port({
    detail: async () => ({ review: { ...review, columns_config: columns }, cells }),
    async setCell(_scope, input) {
      const current = cells[input.columnIndex];
      if (current.status !== input.expected.status || current.content !== input.expected.content)
        return { status: "conflict", value: current };
      const changed = { ...current, status: input.status, content: input.content };
      cells[input.columnIndex] = changed;
      return { status: "committed", value: changed };
    },
  });
  return { repository, cells };
}
function model(execute: (submit: (args: Record<string, unknown>) => Promise<unknown>,
  read: (args: Record<string, unknown>) => Promise<unknown>, evidenceId: string,
  firstMessage: string) => Promise<void>): typeof runChatTurn {
  return async (options) => {
    const state = options.evidenceState ?? createLegalEvidenceTurnState(),
      context = { evidence: state, addEvent() {}, operation: { executor: "assistant" as const, model: options.model } },
      tools = options.createTools(state, "main", context), signal = new AbortController().signal;
    const run = (name: string, args: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.execute(
      args, context, signal, { id: name, name, input: args });
    await execute((args) => run("submit_extraction", args), (args) => run("Read", args),
      [...state.evidence.keys()][0], String(options.messages[0].content));
    return { status: "complete", fullText: "", citations: [], events: [], evidence: state };
  };
}
const answer = (index: number, value: unknown, evidenceId: string) => ({ column_index: index,
  value, flag: "green", outcome: "answered", claims: [{ text: "Governing law: Alberta", evidence_ids: [evidenceId] }] });

const settings = async () => ({ title_model: "codex:gpt-5.6", tabular_model: "codex:gpt-5.6",
  last_selected_chat_model: null, last_selected_reasoning_effort: null,
  legal_research_us: true, api_keys: {} as UserApiKeys });
const sources = async () => { throw new Error("This unit fixture has no Sources binding"); };
const projects = { get: vi.fn(async () => ({ id: "project" })) } as never;

describe("TabularApplication", () => {
  it("maps committed, conflict, and missing writes explicitly", async () => {
    const committed = createTabularApplication(port(), documentStore(), projects, { settings, sources });
    await expect(committed.update(scope, "review", {
      title: "Changed", workflow_id: "document-review",
    })).resolves.toMatchObject({ title: "Changed", workflow_id: "document-review" });

    const conflict = createTabularApplication(port({ update: vi.fn(async () =>
      ({ status: "conflict", value: review })) }), documentStore(), projects, { settings, sources });
    await expect(conflict.update(scope, "review", { title: "Changed" }))
      .rejects.toMatchObject({ status: 409 });

    const missing = createTabularApplication(port({ detail: vi.fn(async () => null) }),
      documentStore(), projects, { settings, sources });
    await expect(missing.update(scope, "review", { title: "Changed" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("strictly bounds rows, prompts, and unknown owner fields", () => {
    expect(tabularDtos.create.safeParse({ document_ids: Array(501).fill("d"),
      columns_config: [] }).success).toBe(false);
    expect(tabularDtos.create.safeParse({ document_ids: [], columns_config: [{
      index: 0, name: "X", prompt: "p".repeat(20_001),
    }] }).success).toBe(false);
    expect(tabularDtos.create.safeParse({ document_ids: [], columns_config: [],
      user_id: "attacker" }).success).toBe(false);
  });

  it("exports the authorized durable review as a real XLSX workbook", async () => {
    const done = { ...cell, status: "done" as const, content };
    const app = createTabularApplication(port({ detail: vi.fn(async () => ({
      review, cells: [done],
    })) }), documentStore(), projects, { settings, sources });
    const file = await app.export(scope, "review");
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(file.bytes, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Review, {
      header: 1,
    });
    expect(file.filename).toBe("Review.xlsx");
    expect(rows).toEqual([["Document", "Law"], ["lease.txt", "Alberta Yes"]]);
  });

  it("rejects oversized extraction files before invoking a model", async () => {
    const runTurn = vi.fn() as unknown as typeof import("../chat/turnEngine").runChatTurn;
    const app = createTabularApplication(port(),
      documentStore(Buffer.alloc(25 * 1024 * 1024 + 1)), projects, { settings, sources, runTurn });
    await expect(app.runAgent(scope, { reviewId: "review", documentId: "document",
      columnIndex: 0, model: "codex:gpt-5.6" })).rejects.toMatchObject({ status: 413 });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("preserves all nine formats, complete explanations and flags with original passage receipts", async () => {
    const formats = ["text", "bulleted_list", "number", "percentage", "monetary_amount", "currency", "yes_no", "date", "tag"],
      values = ["Alberta", ["Alberta", "Canada"], 3.5, 12.5, "CAD 1000", ["CAD", "USD"], true, "2026-09-05", "High"],
      columns = formats.map((format, index) => ({ index, name: format, prompt: "Extract", format, tags: ["High", "Low"] }));
    const { repository, cells } = generated(columns);
    const app = createTabularApplication(repository, documentStore(), projects, { settings, sources,
      runTurn: model(async (submit, _read, id) => {
        await submit(answer(2, "not a number", id));
        await submit(answer(7, "2026-02-31", id));
        await submit(answer(8, "Unconfigured", id));
        expect(cells.every((cell) => cell.status === "generating")).toBe(true);
        for (const [index, value] of values.entries()) await submit(answer(index, value, id));
        await submit(answer(0, "Duplicate", id));
      }) });
    await app.runAgent(scope, { reviewId: "review", documentId: "document" });
    expect(cells.map((cell) => cell.content?.summary)).toEqual([
      "Alberta", "- Alberta\n- Canada", "3.5", "12.5%", "CAD 1000", "CAD, USD", "Yes", "05 September 2026", "High",
    ]);
    for (const [index, cell] of cells.entries()) expect(cell).toMatchObject({ status: "done", content: {
      value: values[index], flag: "green", reasoning: "Governing law: Alberta", coverage: "complete", outcome: "answered",
      evidence: [{ provider: "library", stable_source_id: "document", version: "v1", span_text: "Governing law: Alberta" }],
    } });
  });

  it("does not conflate incomplete reading or omitted answers with not found", async () => {
    const columns = [0, 1].map((index) => ({ index, name: "Law", prompt: "Extract" }));
    const { repository, cells } = generated(columns), bytes = Buffer.from(Array.from({ length: 101 },
      (_, index) => `Line ${index + 1}`).join("\n"));
    const missing = { column_index: 0, value: null, flag: "grey", outcome: "not_found", claims: [] };
    const app = createTabularApplication(repository, documentStore(bytes), projects, { settings, sources,
      runTurn: model(async (submit, read) => {
        await submit(missing);
        expect(cells[0].status).toBe("generating");
        await read({ offset: 101 });
        await submit(missing);
      }) });
    await app.runAgent(scope, { reviewId: "review", documentId: "document" });
    expect(cells).toMatchObject([
      { status: "done", content: { outcome: "not_found", coverage: "complete", value: null, claims: [] } },
      { status: "error", content: null },
    ]);
  });

  it("designs a review and revises supplied columns from the same request", async () => {
    const prompts: string[] = [];
    let payload = JSON.stringify({ title: "Lease review", columns: [
      { name: "Term", prompt: "How long is the term?", format: "number" },
      { name: "Governing law", prompt: "Which law governs?", format: "unsupported" }] });
    const runTurn = (async (options: Parameters<typeof runChatTurn>[0]) => {
      prompts.push(String(options.messages[0].content));
      return { status: "complete", fullText: payload, citations: [], events: [] };
    }) as unknown as typeof runChatTurn;
    const app = createTabularApplication(port(), documentStore(), projects, { settings, sources, runTurn });

    const designed = await app.design(scope, tabularDtos.design.parse({
      request: "Review commercial leases", documentNames: ["lease.txt"] }));
    expect(designed).toEqual({ title: "Lease review", columns_config: [
      { index: 0, name: "Term", prompt: "How long is the term?", format: "number" },
      { index: 1, name: "Governing law", prompt: "Which law governs?", format: "text" }] });
    expect(prompts[0]).toContain("Review commercial leases");
    expect(prompts[0]).not.toContain("Current columns");

    payload = JSON.stringify({ title: "Lease review", columns: [
      { name: "Term", prompt: "How long is the term?", format: "number" },
      { name: "Governing law", prompt: "Which law governs?", format: "text" },
      { name: "Rent", prompt: "What is the monthly rent?", format: "monetary_amount" }] });
    const revised = await app.design(scope, tabularDtos.design.parse({
      request: "Add the monthly rent", current: designed.columns_config }));
    expect(prompts[1]).toContain("Current columns");
    expect(prompts[1]).toContain("How long is the term?");
    expect(revised.columns_config.map(({ index, name }) => [index, name]))
      .toEqual([[0, "Term"], [1, "Governing law"], [2, "Rent"]]);

    payload = "not a design";
    await expect(app.design(scope, tabularDtos.design.parse({ request: "Review leases" })))
      .rejects.toMatchObject({ status: 502 });
  });

  it("cites a workspace passage without reading it again and records the reads behind the cell", async () => {
    const saved = createLibraryEvidence({ documentId: "document", versionId: "v1", filename: "lease.txt",
      sourceText: "Rent is payable monthly in advance.", spanText: "Rent is payable monthly in advance.",
      start: 0, end: 35 });
    const priorQuery = { query_id: "q_prior", call_id: "call-prior", tool: "Read" as const,
      executed_at: "2026-01-01T00:00:00.000Z", model: "codex:gpt-5.6",
      executor_version: "legal-source-pattern-v1" as const,
      input: { resource: "document://document/version/v1" },
      results: [{ rank: 1, evidence_id: saved.evidence_id }], sourceIds: ["document"],
      matchedSourceIds: ["document"], evidenceIds: [saved.evidence_id], failures: [], slots: {} };
    const observed: { queries: { tool: string }[] }[] = [];
    const workspace = {
      items: async (_scope: unknown, _id: string, input: { kind: string }) => ({ total: 1, nextOffset: null,
        items: input.kind === "passages"
          ? [{ kind: "passage", index: 0, value: { receipt: saved, sourceId: "document", labelIds: [], note: "" } }]
          : [{ kind: "query", index: 0, value: priorQuery }] }),
      observe: async (_scope: unknown, _id: string, event: { queries: { tool: string }[] }) => { observed.push(event); },
    };
    const columns = [{ index: 0, name: "Rent", prompt: "Extract" }];
    const scopeConfig = { research_file_id: "workspace", subjects: [{ sourceId: "document",
      resource: "document://document/version/v1", reference: { provider: "library" as const,
        kind: "document" as const, id: "document", versionId: "v1", title: "lease.txt" } }] };
    const { repository, cells } = generated(columns);
    const scoped = port({ ...repository,
      detail: async () => ({ review: { ...review, columns_config: columns, scope_config: scopeConfig }, cells }) });
    let prompt = "";
    const app = createTabularApplication(scoped, documentStore(), projects,
      { settings, sources: async () => workspace as never,
        runTurn: model(async (submit, _read, _id, first) => {
          prompt = first;
          await submit({ column_index: 0, value: "Monthly", flag: "green", outcome: "answered",
            claims: [{ text: "Rent is payable monthly in advance.", evidence_ids: [saved.evidence_id] }] });
        }) });
    await app.runAgent(scope, { reviewId: "review", documentId: "document" });

    expect(prompt).toContain("Saved passages and previous reads for this source");
    expect(prompt).toContain(saved.evidence_id);
    expect(cells[0]).toMatchObject({ status: "done", content: { summary: "Monthly",
      evidence: [{ evidence_id: saved.evidence_id }] } });
    expect(cells[0].content?.query_ids).toEqual(["q_prior"]);
    expect(observed.flatMap(({ queries }) => queries ?? []).filter(({ tool }) => tool === "Read")).toHaveLength(1);
  });

  it("generates only missing cells and can explicitly regenerate one completed cell", async () => {
    const columns = [0, 1].map((index) => ({ index, name: "Law", prompt: "Extract" }));
    const { repository, cells } = generated(columns, [
      { ...cell, status: "done", content }, { ...cell, id: "cell1", column_index: 1 },
    ]);
    let requested = 1;
    const app = createTabularApplication(repository, documentStore(), projects, { settings, sources,
      runTurn: model(async (submit, _read, id) => { await submit(answer(requested, "Alberta", id)); }) });
    await app.runAgent(scope, { reviewId: "review", documentId: "document" });
    expect(cells[0].content).toBe(content);
    expect(cells[1].status).toBe("done");
    requested = 0;
    await app.runAgent(scope, { reviewId: "review", documentId: "document", columnIndex: 0 });
    expect(cells[0].content?.summary).toBe("Alberta");
    await app.clear(scope, "review", { document_ids: ["document"] });
    expect(cells.every(({ status, content }) => status === "pending" && content === null)).toBe(true);
  });
});

it("validates assistant-selected reusable fields instead of accepting authored replacement answers", async () => {
  const runTurn = vi.fn<typeof runChatTurn>(async () => ({ status: "complete", fullText: JSON.stringify({ title: "Clause review",
    columns: [{ name: "Reason", prompt: "Why was this clause invalid?", format: "text", fieldIds: ["claim:reason"] },
      { name: "Remedy", prompt: "What remedy was granted?", format: "text", fieldIds: [] }] }), citations: [], events: [], evidence: createLegalEvidenceTurnState() }));
  const app = createTabularApplication(port(), documentStore(), projects, { settings, sources, runTurn });
  const fields = [{ id: "claim:reason", name: "The two provisions were read together.", prompt: "Why?", kind: "claim" as const,
    rows: 1, samples: ["The two provisions were read together."] }];
  const plan = await app.design(scope, { request: "Compare reasons and remedies" }, undefined, fields);
  expect(plan.mappings).toEqual([{ index: 0, fieldIds: ["claim:reason"] }, { index: 1, fieldIds: [] }]);
  runTurn.mockResolvedValueOnce({ status: "complete", fullText: JSON.stringify({ title: "Bad",
    columns: [{ name: "Outcome", prompt: "Outcome?", fieldIds: ["invented"] }] }), citations: [], events: [], evidence: createLegalEvidenceTurnState() });
  await expect(app.design(scope, { request: "Compare outcomes" }, undefined, fields)).rejects.toMatchObject({ status: 502 });
});

it("requires complete exact-value coverage for assistant label consolidation, allowing explicit skips", async () => {
  const runTurn = vi.fn<typeof runChatTurn>(async () => ({ status: "complete", fullText: JSON.stringify({ mapping: [
    { value: "Narrowly applicable", label: "Applicable" }, { value: "Useful analogy", label: "Applicable" }, { value: "Unrelated", label: null },
  ] }), citations: [], events: [], evidence: createLegalEvidenceTurnState() }));
  const app = createTabularApplication(port(), documentStore(), projects, { settings, sources, runTurn });
  const input = { request: "Group relevant cases", column: "Relevance", values: ["Narrowly applicable", "Useful analogy", "Unrelated"] };
  expect(await app.labelMapping(scope, input)).toEqual([
    { value: "Narrowly applicable", label: "Applicable" }, { value: "Useful analogy", label: "Applicable" }, { value: "Unrelated", label: null },
  ]);
  runTurn.mockResolvedValueOnce({ status: "complete", fullText: JSON.stringify({ mapping: [{ value: "Narrowly applicable", label: "Applicable" }] }),
    citations: [], events: [], evidence: createLegalEvidenceTurnState() });
  await expect(app.labelMapping(scope, input)).rejects.toMatchObject({ status: 502 });
});
