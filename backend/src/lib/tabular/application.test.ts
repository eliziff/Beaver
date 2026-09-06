import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { DocumentStore } from "../documentStore";
import type { UserApiKeys } from "../llm";
import type { TabularCell, TabularCellContent, TabularColumn, TabularRepository } from "../tabularStore";
import { createLegalEvidenceTurnState } from "../chat/legalEvidence";
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
    metadataMany: vi.fn(async (_scope, ids) => ids.includes("document") ? [metadata] : []),
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
  read: (args: Record<string, unknown>) => Promise<unknown>, evidenceId: string) => Promise<void>): typeof runChatTurn {
  return async (options) => {
    const state = options.evidenceState ?? createLegalEvidenceTurnState(),
      context = { evidence: state, addEvent() {}, operation: { executor: "assistant" as const, model: options.model } },
      tools = options.createTools(state, "main", context), signal = new AbortController().signal;
    const run = (name: string, args: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.execute(
      args, context, signal, { id: name, name, input: args });
    await execute((args) => run("submit_extraction", args), (args) => run("Read", args), [...state.evidence.keys()][0]);
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
