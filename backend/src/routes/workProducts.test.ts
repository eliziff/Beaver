import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkProductApplication } from "../lib/workProductApplication";
import { createWorkProductsRouter } from "./workProducts";

const originalMode = process.env.AUTH_MODE;
const id = "10000000-0000-4000-8000-000000000001";
const product = { id, kind: "court-record" as const, title: "Record", projectId: null,
  revision: 1, state: { bindings: {} }, outputs: {}, createdAt: "now", updatedAt: "now" };
const metadata = { id, kind: product.kind, title: product.title, projectId: null,
  revision: 1, outputs: {}, createdAt: "now", updatedAt: "now" };
const resolution = { product, freshness: "unbuilt" as const, inputs: {}, dependencies: [] };
const application = { resolve: vi.fn(async () => resolution),
  list: vi.fn(async (_scope: unknown, options: { metadata?: boolean }) =>
    options.metadata ? [metadata] : [product]) } as unknown as WorkProductApplication;
const app = express();
app.use(express.json());
app.use("/work-products", createWorkProductsRouter(application));

beforeAll(() => { process.env.AUTH_MODE = "local"; });
afterAll(() => { process.env.AUTH_MODE = originalMode; });

describe("WorkProduct HTTP boundary", () => {
  it("returns computed input resolution through the authenticated application operation", async () => {
    await request(app).get(`/work-products/${id}/resolution`).expect(200, resolution);
  });

  it("can list metadata without loading draft state", async () => {
    await request(app).get("/work-products?kind=court-record&metadata=true").expect(200, [metadata]);
  });
});
