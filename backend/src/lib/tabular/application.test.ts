import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { DocumentStore } from "../documentStore";
import type { streamChatWithTools, UserApiKeys } from "../llm";
import type { TabularCell, TabularCellContent, TabularColumn, TabularRepository } from "../tabularStore";
import { createLegalEvidenceTurnState, createLibraryEvidence } from "../chat/legalEvidence";
import type { runChatTurn } from "../chat/turnEngine";
import { createTabularApplication, tabularDtos } from "./application";

beforeEach(() => vi.stubEnv("BEAVER_JEV_TABULAR_MODE", "off"));
afterEach(() => vi.unstubAllEnvs());

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
  firstMessage: string, columns: number[]) => Promise<void>): typeof runChatTurn {
  return async (options) => {
    const state = options.evidenceState ?? createLegalEvidenceTurnState(),
      context = { evidence: state, addEvent() {}, operation: { executor: "assistant" as const, model: options.model } },
      tools = options.createTools(state, "main", context), signal = new AbortController().signal;
    const run = (name: string, args: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.execute(
      args, context, signal, { id: name, name, input: args });
    await execute((args) => run("submit_extraction", args), (args) => run("Read", args),
      [...state.evidence.keys()][0], String(options.messages[0].content),
      (tools.find((tool) => tool.name === "submit_extraction")!.inputSchema as {
        properties: { column_index: { enum: number[] } };
      }).properties.column_index.enum);
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

});
