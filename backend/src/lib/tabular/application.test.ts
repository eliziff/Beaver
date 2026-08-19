import { describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../documentStore";
import type { UserApiKeys } from "../llm";
import type { TabularRepository } from "../tabularStore";
import { createTabularApplication, tabularDtos } from "./application";
import type { runChatTurn } from "../chat/turnEngine";

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
      value: { ...review, title: input.title ?? review.title } })),
    delete: vi.fn(async () => ({ status: "committed", value: null })),
    setCell: vi.fn(async (_scope, input) => ({ status: "committed", value: {
      ...cell, status: input.status, content: input.content } })),
    recordGeneration: vi.fn(async () => {}),
    ...overrides,
  };
}
const documentStore = (bytes = Buffer.from("Governing law: Alberta")) => ({
  metadata: vi.fn(async () => ({ id: "document", filename: "lease.txt" })),
  read: vi.fn(async () => ({ bytes, filename: "lease.txt", fileType: "txt",
    hasPdfRendition: false, version: { id: "v1", version_number: 1, source: null,
      created_at: null, filename: "lease.txt" } })),
}) as unknown as DocumentStore;
const settings = async () => ({ title_model: "codex:gpt-5.6", tabular_model: "codex:gpt-5.6",
  api_keys: {} as UserApiKeys }) as Awaited<ReturnType<
    typeof import("../userSettings").getUserModelSettings>>;
const project = vi.fn(async (input: { bytes?: Buffer }) => ({ kind: "source-doc" as const,
  text: input.bytes?.toString("utf8") ?? "", sourceDoc: {} as never, tableCells: [] as [] }));
const projects = { get: vi.fn(async () => ({ id: "project" })) } as never;

describe("TabularApplication", () => {
  it("maps committed, conflict, and missing writes explicitly", async () => {
    const committed = createTabularApplication(port(), documentStore(), projects, { settings, project });
    await expect(committed.update(scope, "review", { title: "Changed" }))
      .resolves.toMatchObject({ title: "Changed" });

    const conflict = createTabularApplication(port({ update: vi.fn(async () =>
      ({ status: "conflict", value: review })) }), documentStore(), projects, { settings, project });
    await expect(conflict.update(scope, "review", { title: "Changed" }))
      .rejects.toMatchObject({ status: 409 });

    const missing = createTabularApplication(port({ detail: vi.fn(async () => null) }),
      documentStore(), projects, { settings, project });
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
    const done = { ...cell, status: "done" as const, content: {
      summary: "Alberta [[page:2||quote:source words]] [[Yes]]",
    } };
    const app = createTabularApplication(port({ detail: vi.fn(async () => ({
      review, cells: [done],
    })) }), documentStore(), projects, { settings, project });
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
      documentStore(Buffer.alloc(25 * 1024 * 1024 + 1)), projects, { settings, runTurn, project });
    await expect(app.regenerate(scope, "review", {
      document_id: "document", column_index: 0,
    })).rejects.toMatchObject({ status: 413 });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("propagates abort to the shared turn runtime", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const runTurn = vi.fn(async (options: Parameters<typeof runChatTurn>[0]) => {
      await new Promise((_resolve, reject) => {
        const abort = () => { const error = new Error("Stream aborted.");
          error.name = "AbortError"; reject(error); };
        options.signal!.addEventListener("abort", abort, { once: true });
        entered();
        if (options.signal!.aborted) abort();
      });
      throw new Error("unreachable");
    }) as unknown as typeof import("../chat/turnEngine").runChatTurn;
    const app = createTabularApplication(port(), documentStore(), projects,
      { settings, runTurn, project });
    const controller = new AbortController();
    const work = app.regenerate(scope, "review", {
      document_id: "document", column_index: 0,
    }, controller.signal);
    await started; controller.abort();
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
  });
});
