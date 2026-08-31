import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthoritiesWorkspaceApplication } from "../lib/authoritiesWorkspaceApplication";
import { createAuthoritiesRouter } from "./authorities";

const originalMode = process.env.AUTH_MODE;
const product = { id: "draft-1", kind: "authorities", title: "Authorities",
  projectId: null, revision: 1, state: { schemaVersion: "beaver.authorities-draft.v1" },
  outputs: {}, createdAt: "now", updatedAt: "now" };
const application = {
  list: vi.fn(async () => [product]), get: vi.fn(async () => product),
  saveFile: vi.fn(async () => ({ id: "document-1" })),
  importDraft: vi.fn(async () => product), act: vi.fn(async () => product),
  refresh: vi.fn(async () => product), attachPdf: vi.fn(async () => product),
  build: vi.fn(async () => ({ product, receipt: { schemaVersion: "beaver.authorities-build.v1" } })),
} as unknown as AuthoritiesWorkspaceApplication;
const app = express();
app.use(express.json());
app.use("/authorities", createAuthoritiesRouter(application));

beforeAll(() => { process.env.AUTH_MODE = "local"; });
afterAll(() => { process.env.AUTH_MODE = originalMode; });

describe("Authorities HTTP boundary", () => {
  it("uses the authenticated scope and accepts a compact manual draft", async () => {
    await request(app).get("/authorities").expect(200);
    expect(application.list).toHaveBeenCalledWith(expect.objectContaining({
      userId: "00000000-0000-0000-0000-000000000001",
    }), { projectId: undefined, limit: undefined });
    await request(app).post("/authorities").send({ source: { kind: "manual" },
      title: "Appeal authorities" }).expect(201);
    expect(application.importDraft).toHaveBeenCalledWith(expect.anything(), {
      source: { kind: "manual" }, title: "Appeal authorities",
    });
  });

  it("keeps authority identity and CanLII URL derivation behind the application", async () => {
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "add-authority", kind: "case", citation: "2024 ABKB 123", name: "Smith",
    } }).expect(200);
    expect(application.act).toHaveBeenLastCalledWith(expect.anything(), "draft-1", 1, {
      type: "add-authority", kind: "case", citation: "2024 ABKB 123", name: "Smith",
    });
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "begin-canlii-handoff", authorityId: "authority-1",
      pageUrl: "https://www.canlii.org/fake.html",
    } }).expect(400);
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "split-occurrence", occurrenceId: "occurrence-1", cursor: 14,
    } }).expect(200);
    expect(application.act).toHaveBeenLastCalledWith(expect.anything(), "draft-1", 1, {
      type: "split-occurrence", occurrenceId: "occurrence-1", cursor: 14,
    });
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "merge-occurrences", occurrenceIds: ["a", "b"], replacement: {},
    } }).expect(400);
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "merge-occurrence", occurrenceId: "occurrence-2",
    } }).expect(200);
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "set-document-output", enabled: true,
    } }).expect(200);
    expect(application.act).toHaveBeenLastCalledWith(expect.anything(), "draft-1", 1, {
      type: "set-document-output", enabled: true,
    });
  });

  it("stages direct and authority PDF uploads through the typed operations", async () => {
    await request(app).post("/authorities/documents")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "brief.pdf").expect(201);
    expect(application.saveFile).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ filename: "brief.pdf", fileType: "pdf" }), undefined);
    await request(app).post("/authorities/documents")
      .field("projectId", "project-1")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "project-brief.pdf").expect(201);
    expect(application.saveFile).toHaveBeenLastCalledWith(expect.anything(),
      expect.objectContaining({ filename: "project-brief.pdf" }), "project-1");
    await request(app).post("/authorities/draft-1/attachments/authority-1")
      .field("revision", "1")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "case.pdf").expect(200);
    expect(application.attachPdf).toHaveBeenCalledWith(expect.anything(), "draft-1",
      expect.objectContaining({ revision: 1, authorityId: "authority-1",
        file: expect.objectContaining({ filename: "case.pdf", fileType: "pdf" }) }));
  });

  it("returns only persisted product refs and the aggregate receipt after build", async () => {
    const response = await request(app).post("/authorities/draft-1/build")
      .send({ revision: 1 }).expect(200);
    expect(response.body).toEqual({ product, receipt: {
      schemaVersion: "beaver.authorities-build.v1",
    } });
    expect(response.body).not.toHaveProperty("build");
  });
});
