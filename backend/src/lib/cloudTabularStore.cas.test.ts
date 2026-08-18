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

import { cloudTabularData } from "./cloudTabularStore";

const identity = { userId: "owner", userEmail: "owner@example.test" };

beforeEach(() => {
  state.review = { id: "review", user_id: "owner", project_id: null,
    title: "Before", columns_config: [{ index: 0, name: "Law", prompt: "Find law" }],
    document_ids: ["document"], shared_with: [], workflow_id: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  state.cell = { id: "cell", review_id: "review", document_id: "document",
    column_index: 0, content: null, status: "pending" };
});

describe("cloud tabular CAS", () => {
  it("allows exactly one review update for a shared version", async () => {
    const results = await Promise.all([
      cloudTabularData.update(identity, "review", String(state.review.updated_at), { title: "A" }),
      cloudTabularData.update(identity, "review", String(state.review.updated_at), { title: "B" }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["committed", "conflict"]);
  });

  it("allows exactly one cell update for shared prior content", async () => {
    const expected = { status: "pending" as const, content: null };
    const results = await Promise.all([
      cloudTabularData.setCell(identity, { reviewId: "review", documentId: "document",
        columnIndex: 0, expected, status: "done", content: { summary: "A" } }),
      cloudTabularData.setCell(identity, { reviewId: "review", documentId: "document",
        columnIndex: 0, expected, status: "done", content: { summary: "B" } }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["committed", "conflict"]);
  });
});
