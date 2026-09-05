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
  discrepancies: vi.fn(async () => []),
  resolveDiscrepancy: vi.fn(async () => product),
  saveFile: vi.fn(async () => ({ id: "document-1" })),
  importDraft: vi.fn(async () => product), act: vi.fn(async () => product),
  prepareSources: vi.fn(async () => product),
  refresh: vi.fn(async () => product), replaceSource: vi.fn(async () => product),
  refreshInput: vi.fn(async () => product),
  attachPdf: vi.fn(async () => product), attachBookPdf: vi.fn(async () => product),
  attachLibraryPdf: vi.fn(async () => product),
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

  it("returns deterministic source findings without mutating the draft", async () => {
    await request(app).post("/authorities/draft-1/discrepancies").expect(200, []);
    expect(application.discrepancies).toHaveBeenCalledWith(expect.anything(), "draft-1",
      expect.any(AbortSignal));
  });

  it("accepts only the discrepancy id, action, and draft revision", async () => {
    const body = { id: "a".repeat(64), action: "quote_exact", revision: 3 };
    await request(app).post("/authorities/draft-1/discrepancies/actions")
      .send(body).expect(200);
    expect(application.resolveDiscrepancy).toHaveBeenCalledWith(expect.anything(),
      "draft-1", body, expect.any(AbortSignal));
    await request(app).post("/authorities/draft-1/discrepancies/actions")
      .send({ ...body, replacement: "tampered" }).expect(400);
  });

  it("starts source preparation only through the explicit draft operation", async () => {
    await request(app).post("/authorities/draft-1/sources").send({ revision: 1 }).expect(200);
    expect(application.prepareSources).toHaveBeenCalledWith(expect.anything(), "draft-1", 1,
      expect.any(AbortSignal));
  });

  it("keeps authority identity and CanLII URL derivation behind the application", async () => {
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "add-authority", kind: "case", citation: "2024 ABKB 123", name: "Smith",
    } }).expect(200);
    expect(application.act).toHaveBeenLastCalledWith(expect.anything(), "draft-1", 1, {
      type: "add-authority", kind: "case", citation: "2024 ABKB 123", name: "Smith",
    });
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "edit-authority", authorityId: "authority-1", kind: "case",
      citation: "2009 SCC 32", name: "R v Grant",
    } }).expect(200);
    expect(application.act).toHaveBeenLastCalledWith(expect.anything(), "draft-1", 1, {
      type: "edit-authority", authorityId: "authority-1", kind: "case",
      citation: "2009 SCC 32", name: "R v Grant",
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
      type: "set-reviewed", occurrenceId: "occurrence-2", reviewed: true,
    } }).expect(200);
    expect(application.act).toHaveBeenLastCalledWith(expect.anything(), "draft-1", 1, {
      type: "set-reviewed", occurrenceId: "occurrence-2", reviewed: true,
    });
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "set-document-output", enabled: true,
    } }).expect(200);
    expect(application.act).toHaveBeenLastCalledWith(expect.anything(), "draft-1", 1, {
      type: "set-document-output", enabled: true,
    });
  });

  it("decodes initial court/source settings and exact review corrections", async () => {
    const settings = { profileId: "federal-court", sourceMode: "automatic",
      passageMarking: "paragraph", filingMedium: "paper", bookRole: "plaintiff",
      outputMode: "both" };
    await request(app).post("/authorities").send({ source: { kind: "manual" }, settings })
      .expect(201);
    expect(application.importDraft).toHaveBeenLastCalledWith(expect.anything(), {
      source: { kind: "manual" }, settings,
    });
    for (const action of [
      { type: "set-profile", profileId: "ab-court-of-appeal" },
      { type: "set-settings", settings: { tableLocation: "combined", tabStyle: "alpha",
        filingMedium: "electronic", bookRole: "moving-party" } },
      { type: "set-cover", cover: { courtFileNumber: "A-12-26", partyGroups: [
        { role: "Appellant", parties: ["North Prairie Ltd."] },
        { role: "Respondent", parties: ["Attorney General of Canada"] },
      ], applicationUnder: "", title: "Book of Authorities" } },
      { type: "set-authority-span", occurrenceId: "cite", start: 3, end: 20 },
      { type: "set-pinpoint-span", occurrenceId: "cite", start: 24, end: 33 },
      { type: "clear-authority-source", authorityId: "grant" },
      { type: "clear-book-part", slot: "cover" },
      { type: "remove-book-supplement", id: "appendix" },
    ]) {
      await request(app).post("/authorities/draft-1/actions")
        .send({ revision: 1, action }).expect(200);
      expect(application.act).toHaveBeenLastCalledWith(expect.anything(), "draft-1", 1, action);
    }
    await request(app).post("/authorities").send({ source: { kind: "manual" },
      settings: { profileId: "unknown" } }).expect(400);
    await request(app).post("/authorities").send({ source: { kind: "manual" },
      settings: { sourceMode: "automatic", surprise: true } }).expect(400);
    await request(app).post("/authorities/draft-1/actions").send({ revision: 1, action: {
      type: "set-settings", settings: { sourceMode: "automatic", surprise: true },
    } }).expect(400);
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
      .field("language", "en")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "case.pdf").expect(200);
    expect(application.attachPdf).toHaveBeenCalledWith(expect.anything(), "draft-1",
      expect.objectContaining({ revision: 1, authorityId: "authority-1",
        language: "en",
        file: expect.objectContaining({ filename: "case.pdf", fileType: "pdf" }) }));
    await request(app).post("/authorities/draft-1/source")
      .field("revision", "1")
      .attach("file", Buffer.from("PK\x03\x04replacement"), "replacement.docx").expect(200);
    expect(application.replaceSource).toHaveBeenCalledWith(expect.anything(), "draft-1",
      expect.objectContaining({ revision: 1,
        file: expect.objectContaining({ filename: "replacement.docx", fileType: "docx" }) }));
    await request(app).post("/authorities/draft-1/book-parts/supplemental")
      .field("revision", "1")
      .field("supplement_id", "other-1")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "appendix.pdf").expect(200);
    expect(application.attachBookPdf).toHaveBeenCalledWith(expect.anything(), "draft-1",
      expect.objectContaining({ revision: 1, slot: "supplemental", supplementId: "other-1",
        file: expect.objectContaining({ filename: "appendix.pdf", fileType: "pdf" }) }));
  });

  it("accepts the current Library version for one bound input", async () => {
    await request(app).post("/authorities/draft-1/inputs/authority%3Agrant/refresh")
      .send({ revision: 3 }).expect(200);
    expect(application.refreshInput).toHaveBeenCalledWith(expect.anything(), "draft-1", {
      revision: 3, role: "authority:grant",
    });
  });

  it("binds a current Library PDF to one authority or book slot", async () => {
    const common = { revision: 3, documentId: "pdf-1", versionId: "version-2" };
    const authority = { kind: "authority", authorityId: "grant", language: "en" };
    await request(app).post("/authorities/draft-1/library-pdfs")
      .send({ ...common, target: authority }).expect(200);
    expect(application.attachLibraryPdf).toHaveBeenLastCalledWith(expect.anything(), "draft-1",
      { ...common, target: authority });

    const book = { kind: "book", slot: "supplemental", supplementId: "appendix-1" };
    await request(app).post("/authorities/draft-1/library-pdfs")
      .send({ ...common, target: book }).expect(200);
    expect(application.attachLibraryPdf).toHaveBeenLastCalledWith(expect.anything(), "draft-1",
      { ...common, target: book });
    await request(app).post("/authorities/draft-1/library-pdfs")
      .send({ ...common, target: { ...book, authorityId: "grant" } }).expect(400);
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
