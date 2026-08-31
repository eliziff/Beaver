import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkProductApplication } from "../lib/workProductApplication";
import { createWorkProductsRouter } from "./workProducts";

const originalMode = process.env.AUTH_MODE;
const id = "10000000-0000-4000-8000-000000000001";
const product = { id, kind: "court-record" as const, title: "Record", projectId: null,
  revision: 1, state: { bindings: {} }, outputs: {}, createdAt: "now", updatedAt: "now" };
const metadata = { id, kind: "research-set" as const, title: "Research", projectId: null,
  revision: 1, createdAt: "now", updatedAt: "now" };
const resolution = { product, freshness: "unbuilt" as const, inputs: {}, dependencies: [] };
const application = { resolve: vi.fn(async () => resolution),
  list: vi.fn(async (_scope: unknown, options: { metadata?: boolean }) =>
    options.metadata ? [metadata] : [product]) } as unknown as WorkProductApplication;
const runQuery = vi.fn(async () => ({ queryId: "query-1" }));
const app = express();
app.use(express.json());
app.use("/work-products", createWorkProductsRouter(application, { run: runQuery } as never));

beforeAll(() => { process.env.AUTH_MODE = "local"; });
afterAll(() => { process.env.AUTH_MODE = originalMode; });

describe("WorkProduct HTTP boundary", () => {
  it("returns computed input resolution through the authenticated application operation", async () => {
    await request(app).get(`/work-products/${id}/resolution`).expect(200, resolution);
    expect(application.resolve).toHaveBeenCalledWith(expect.objectContaining({
      userId: "00000000-0000-0000-0000-000000000001",
    }), id);
  });

  it("opts research menus into metadata while preserving the default full list", async () => {
    await request(app).get("/work-products?kind=research-set&metadata=true").expect(200, [metadata]);
    expect(application.list).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      kind: "research-set", metadata: true,
    }));
    await request(app).get("/work-products?kind=court-record").expect(200, [product]);
    expect(application.list).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      kind: "court-record", metadata: false,
    }));
  });

  it("passes the canonical research query shape to the application service", async () => {
    const input = { revision: 1, text: "good faith", syntax: "terms", target: "sources",
      sourceIds: [id], labelIds: [id] };
    await request(app).post(`/work-products/${id}/research-query`).send(input)
      .expect(200, { queryId: "query-1" });
    expect(runQuery).toHaveBeenCalledWith(expect.anything(), id, input);
  });
});
