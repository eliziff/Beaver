import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  review: {} as Record<string, unknown>,
  cell: {} as Record<string, unknown>,
}));

class Query {
  private action: "select" | "update" | "delete" = "select";
  private values: Record<string, unknown> = {};
  private filters: [string, unknown][] = [];
  constructor(private readonly table: string) {}
  select() { return this; }
  update(values: Record<string, unknown>) { this.action = "update"; this.values = values; return this; }
  delete() { this.action = "delete"; return this; }
  eq(key: string, value: unknown) { this.filters.push([key, value]); return this; }
  is(key: string, value: unknown) { return this.eq(key, value); }
  in() { return this; }
  insert() { return this; }
  private execute() {
    const row = this.table === "tabular_reviews" ? state.review : state.cell;
    if (!Object.keys(row).length || this.filters.some(([key, value]) => row[key] !== value))
      return null;
    if (this.action === "update") Object.assign(row, this.values);
    if (this.action === "delete") {
      const value = { ...row };
      for (const key of Object.keys(row)) delete row[key];
      return value;
    }
    return { ...row };
  }
  maybeSingle() { return Promise.resolve({ data: this.execute(), error: null }); }
  single() { return this.maybeSingle(); }
  then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
    const row = this.execute();
    return Promise.resolve({ data: row ? [row] : [], error: null }).then(resolve);
  }
}

const db = { from: (table: string) => new Query(table), rpc: vi.fn() };
vi.mock("./access", () => ({
  cloudData: async (_operation: string, query: PromiseLike<unknown>) =>
    (await query as { data: unknown }).data,
  cloudScope: (identity: { userId: string; userEmail?: string }) => ({
    ...identity, userEmail: identity.userEmail ?? "", db,
    review: async (_id: string, owner = false) => Object.keys(state.review).length &&
      (!owner || state.review.user_id === identity.userId)
      ? { row: { ...state.review }, isOwner: state.review.user_id === identity.userId }
      : null,
    project: async () => ({ row: { id: "project" }, isOwner: true }),
    documents: async () => [],
  }),
}));
vi.mock("./audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("./documentVersions", () => ({ attachActiveVersionPaths: vi.fn(async () => {}) }));

import { postgresTabularRepository } from "./postgresTabularRepository";

const identity = { userId: "owner", userEmail: "owner@example.test" };

beforeEach(() => {
  db.rpc.mockReset();
  state.review = { id: "review", user_id: "owner", project_id: null,
    title: "Before", columns_config: [{ index: 0, name: "Law", prompt: "Find law" }],
    document_ids: ["document"], shared_with: [], workflow_id: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  state.cell = { id: "cell", review_id: "review", document_id: "document",
    column_index: 0, content: null, status: "pending" };
});

describe("cloud tabular CAS", () => {
  it("commits a structural update through one atomic RPC", async () => {
    const columns = [{ index: 1, name: "Remedy", prompt: "Find remedy" }];
    db.rpc.mockResolvedValue({ data: { status: "committed", value: {
      ...state.review, columns_config: columns, is_owner: true,
      updated_at: "2026-01-01T00:00:00.001Z",
    } }, error: null });
    await expect(postgresTabularRepository.update(identity, "review",
      String(state.review.updated_at), { columns })).resolves.toMatchObject({
        status: "committed", value: { columns_config: columns },
      });
    expect(db.rpc).toHaveBeenCalledOnce();
    expect(db.rpc).toHaveBeenCalledWith("write_tabular_review", expect.objectContaining({
      p_actor_user_id: "owner", p_review_id: "review",
      p_expected_version: "2026-01-01T00:00:00.000Z",
    }));
  });

  it("allows exactly one review update for a shared version", async () => {
    const results = await Promise.all([
      postgresTabularRepository.update(identity, "review", String(state.review.updated_at), { title: "A" }),
      postgresTabularRepository.update(identity, "review", String(state.review.updated_at), { title: "B" }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["committed", "conflict"]);
  });

  it("allows exactly one cell update for shared prior content", async () => {
    const expected = { status: "pending" as const, content: null };
    const results = await Promise.all([
      postgresTabularRepository.setCell(identity, { reviewId: "review", documentId: "document",
        columnIndex: 0, expected, status: "done", content: { summary: "A" } }),
      postgresTabularRepository.setCell(identity, { reviewId: "review", documentId: "document",
        columnIndex: 0, expected, status: "done", content: { summary: "B" } }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["committed", "conflict"]);
  });
});
