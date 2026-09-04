import express from "express";
import { PDFDocument } from "pdf-lib";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthoritiesDraft } from "../lib/authoritiesDomain";
import { sha256 } from "../lib/hash";
import { assertAuthoritiesBuildUploadSize, createAuthoritiesRuntimeRouter } from
  "./authoritiesRuntime";

const mocks = vi.hoisted(() => ({ importFile: vi.fn(), pdfText: vi.fn() }));
vi.mock("../lib/authoritiesImport", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/authoritiesImport")>(),
  importStandaloneAuthoritiesFile: mocks.importFile,
}));
vi.mock("../lib/authorityPdfText", () => ({ authorityPdfText: mocks.pdfText }));

const originalMode = process.env.AUTH_MODE;
const app = express(); app.use(express.json());
const resolveSources = vi.fn(async (draft: AuthoritiesDraft) => ({ draft, attachments: [] }));
app.use("/authorities-runtime", createAuthoritiesRuntimeRouter(resolveSources));

beforeAll(() => { process.env.AUTH_MODE = "local"; });
afterAll(() => { process.env.AUTH_MODE = originalMode; });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const manualState = () => ({ schemaVersion: "beaver.authorities-draft.v1" as const,
  import: { kind: "manual" as const }, bindings: {}, outputMode: "table" as const,
  settings: { profileId: "general" as const, sourceMode: "automatic" as const,
    tabStyle: "numeric" as const, tableOrder: "alphabetical" as const,
    tableDelivery: "native-append" as const, tableLocation: "pages" as const,
    passageMarking: "margin" as const, scannedPdfPolicy: "page-margin" as const,
    missingSourcePolicy: "placeholder" as const },
  bookParts: { cover: null, index: null },
  insertIntoDocument: false, ledger: null, units: [], occurrences: {},
  authorityOrder: ["case"], authorities: { case: {
    id: "case", key: "case", kind: "case" as const, citation: "2024 ABKB 123",
    name: "Example v Example", displayName: null,
    evidenceIds: [], locators: [],
    sourceIdentity: null, excluded: false, source: { kind: "unresolved" as const },
  } } });

describe("standalone Authorities runtime", () => {
  it("rejects an aggregate build upload above 512 MB before reading files", () => {
    expect(() => assertAuthoritiesBuildUploadSize([{ size: 512 * 1024 ** 2 + 1 }]))
      .toThrow(expect.objectContaining({ status: 413,
        message: "Authorities build files are too large together. Maximum total is 512 MB." }));
  });

  it("shares deterministic discrepancy review without changing the draft", async () => {
    await request(app).post("/authorities-runtime/discrepancies")
      .send({ draft: manualState() }).expect(200, []);
  });

  it("applies create settings without starting source work", async () => {
    const response = await request(app).post("/authorities-runtime/create").send({ settings: {
      profileId: "federal-court", sourceMode: "manual-originals", outputMode: "both",
    } }).expect(200);

    expect(resolveSources).not.toHaveBeenCalled();
    expect(response.body.settings.profileId).toBe("federal-court");
  });

  it("applies the selected source policy while importing", async () => {
    mocks.importFile.mockResolvedValue(manualState());
    const response = await request(app).post("/authorities-runtime/import")
      .field("modified", "1").field("settings", JSON.stringify({
        sourceMode: "manual-originals",
      })).attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "Factum.pdf").expect(200);

    expect(mocks.importFile).toHaveBeenCalledWith(expect.objectContaining({
      filename: "Factum.pdf", fileType: "pdf", modified: 1,
      sourceMode: "manual-originals",
    }));
    expect(response.body.settings.sourceMode).toBe("manual-originals");
  });

  it("returns automatic source bytes with durable content-addressed bindings", async () => {
    const bytes = Buffer.from("%PDF-1.7\nautomatic\n%%EOF"), sourceSha256 = sha256(bytes);
    resolveSources.mockImplementationOnce(async (state) => ({ draft: state, attachments: [{
      authorityId: "case", filename: "Example v Example.pdf", bytes, sourceSha256,
      sourceUrl: "https://decisions.example/case.pdf", origin: "original" as const,
    }] }));
    const response = await request(app).post("/authorities-runtime/sources")
      .send({ draft: manualState() })
      .buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      }).expect(200);
    const body = response.body as Buffer;

    expect(response.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/u);
    expect(body.includes(bytes)).toBe(true);
    expect(body.includes(Buffer.from(`stored:${sourceSha256}`))).toBe(true);
    expect(body.includes(Buffer.from('"origin":"original"'))).toBe(true);
  });

  it("refreshes a changed imported source through the domain reducer", async () => {
    const current = structuredClone(manualState()) as ReturnType<typeof manualState> &
      Record<string, unknown>;
    Object.assign(current, { import: { kind: "document", bindingRole: "source",
      filename: "Factum.pdf", fileType: "pdf", snapshot: null }, outputMode: "both",
    bindings: { source: { kind: "local-file", handleId: "retained-handle", lastSeen: {
      name: "Factum.pdf", size: 10, modified: 1, sha256: "a".repeat(64),
    } } } });
    current.authorities.case.displayName = "Kept label";
    const fresh = structuredClone(current) as typeof current;
    fresh.bindings = { source: { kind: "local-file", handleId: "standalone", lastSeen: {
      name: "Updated.pdf", size: 14, modified: 2, sha256: "b".repeat(64),
    } } };
    fresh.units = [{ id: "body:1", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text: "2025 ABKB 2", occurrenceIds: [] }];
    fresh.authorities.case.displayName = null;
    mocks.importFile.mockResolvedValue(fresh);

    const response = await request(app).post("/authorities-runtime/refresh")
      .field("draft", JSON.stringify(current)).field("modified", "2")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "Updated.pdf").expect(200);

    expect(mocks.importFile).toHaveBeenCalledWith(expect.objectContaining({
      sourceMode: "automatic",
    }));
    expect(response.body.bindings.source).toMatchObject({ handleId: "retained-handle",
      lastSeen: { name: "Updated.pdf", size: 14, modified: 2, sha256: "b".repeat(64) } });
    expect(response.body.units[0].text).toBe("2025 ABKB 2");
    expect(response.body.authorities.case.displayName).toBe("Kept label");
    expect(response.body.outputMode).toBe("both");
  });

  it("allows an explicit replacement to change the imported file type", async () => {
    const current = structuredClone(manualState()) as ReturnType<typeof manualState> &
      Record<string, unknown>;
    Object.assign(current, { import: { kind: "document", bindingRole: "source",
      filename: "Factum.docx", fileType: "docx", snapshot: null },
    bindings: { source: { kind: "local-file", handleId: "old", lastSeen: {
      name: "Factum.docx", size: 2, modified: 1, sha256: "a".repeat(64),
    } } } });
    const fresh = structuredClone(current) as typeof current;
    fresh.import = { kind: "document", bindingRole: "source", filename: "Factum.pdf",
      fileType: "pdf", snapshot: null };
    fresh.bindings = { source: { kind: "local-file", handleId: "standalone", lastSeen: {
      name: "Factum.pdf", size: 14, modified: 2, sha256: "b".repeat(64),
    } } };
    mocks.importFile.mockResolvedValue(fresh);

    const response = await request(app).post("/authorities-runtime/refresh")
      .field("draft", JSON.stringify(current)).field("modified", "2").field("replace", "true")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "Factum.pdf").expect(200);

    expect(response.body.import).toMatchObject({ filename: "Factum.pdf", fileType: "pdf" });
  });

  it("attaches replaceable cover and index PDFs", async () => {
    const makePdf = async (pages: number) => {
      const pdf = await PDFDocument.create();
      for (let index = 0; index < pages; index += 1) pdf.addPage();
      return Buffer.from(await pdf.save());
    };
    const cover = await makePdf(1);
    const first = await request(app).post("/authorities-runtime/book-part")
      .field("draft", JSON.stringify(manualState())).field("slot", "cover")
      .field("modified", "4").attach("file", cover, "Cover.pdf").expect(200);
    expect(first.body.bookParts.cover).toMatchObject({ bindingRole: "book:cover:cover",
      filename: "Cover.pdf", sourceSha256: sha256(cover) });
    expect(first.body.bindings["book:cover:cover"]).toMatchObject({ kind: "local-file",
      lastSeen: { name: "Cover.pdf", size: cover.length, modified: 4,
        sha256: sha256(cover) } });

    const replacement = await makePdf(2);
    const replaced = await request(app).post("/authorities-runtime/book-part")
      .field("draft", JSON.stringify(first.body)).field("slot", "cover")
      .field("modified", "5").attach("file", replacement, "New cover.pdf").expect(200);
    expect(replaced.body.bookParts.cover).toMatchObject({ bindingRole: "book:cover:cover",
      filename: "New cover.pdf", sourceSha256: sha256(replacement) });
    expect(Object.keys(replaced.body.bindings)).toEqual(["book:cover:cover"]);

    const index = await makePdf(1);
    const indexed = await request(app).post("/authorities-runtime/book-part")
      .field("draft", JSON.stringify(replaced.body)).field("slot", "index")
      .field("modified", "6").attach("file", index, "Index.pdf").expect(200);
    expect(indexed.body.bookParts.index).toMatchObject({ filename: "Index.pdf",
      sourceSha256: sha256(index) });
    await request(app).post("/authorities-runtime/book-part")
      .field("draft", JSON.stringify(indexed.body)).field("slot", "supplemental")
      .field("modified", "7").attach("file", index, "Extra.pdf").expect(400);
  });

  it("accepts only actual PDF uploads for book parts", async () => {
    await request(app).post("/authorities-runtime/book-part")
      .field("draft", JSON.stringify(manualState())).field("slot", "cover")
      .field("modified", "1").attach("file", Buffer.from("%PDF-1.7"), "Cover.txt")
      .expect(400);
    await request(app).post("/authorities-runtime/book-part")
      .field("draft", JSON.stringify(manualState())).field("slot", "index")
      .field("modified", "1").attach("file", Buffer.from("not a pdf"), "Index.pdf")
      .expect(400);
  });

  it("derives the manual CanLII handoff without making a CanLII request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const response = await request(app).post("/authorities-runtime/action").send({
      draft: manualState(), action: { type: "begin-canlii-handoff", authorityId: "case" },
    }).expect(200);
    expect(response.body.authorities.case.source).toEqual({ kind: "pending-canlii",
      authorityKey: "case",
      pageUrl: "https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.html",
      pdfUrl: "https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.pdf" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps edits local and resolves only at the explicit source stage", async () => {
    await request(app).post("/authorities-runtime/action").send({
      draft: manualState(), action: { type: "set-output-mode", outputMode: "both" },
    }).expect(200);
    expect(resolveSources).not.toHaveBeenCalled();

    await request(app).post("/authorities-runtime/action").send({
      draft: manualState(), action: { type: "set-settings",
        settings: { sourceMode: "manual-originals" } },
    }).expect(200);
    expect(resolveSources).not.toHaveBeenCalled();

    await request(app).post("/authorities-runtime/sources")
      .send({ draft: manualState() }).expect(200);
    expect(resolveSources).toHaveBeenCalledOnce();
  });

  it("splits and merges a standalone footnote through the shared reducer", async () => {
    const text = "2024 ABKB 123; 2024 FCA 2", state = manualState();
    Object.assign(state, { units: [{ id: "footnote:1", kind: "footnote", ordinal: 0,
      footnoteId: 1, footnoteRefs: [], pageNumbers: [], text,
      occurrenceIds: ["original"] }], occurrences: { original: {
      id: "original", unitId: "footnote:1", start: 0, end: text.length, text,
      authoritySpan: { start: 0, end: 13, text: text.slice(0, 13) },
      coreSpan: { start: 0, end: 13, text: text.slice(0, 13) }, pinpointSpan: null,
      kind: "case", citation: "2024 ABKB 123", authorityId: "case", reference: null,
      pinpoints: [], evidenceIds: [], sourceTextSha256: "unit", localOrdinal: 0,
      reviewed: false } } });
    const split = await request(app).post("/authorities-runtime/action").send({ draft: state,
      action: { type: "split-occurrence", occurrenceId: "original",
        cursor: text.indexOf(";") + 1 } });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    expect(split.body.units[0].occurrenceIds).toHaveLength(2);
    const merged = await request(app).post("/authorities-runtime/action").send({
      draft: split.body, action: { type: "merge-occurrence",
        occurrenceId: split.body.units[0].occurrenceIds[1] },
    }).expect(200);
    expect(merged.body.units[0].occurrenceIds).toHaveLength(1);
  });

  it("builds browser-owned draft state with the production Authorities builder", async () => {
    const state = manualState();
    const response = await request(app).post("/authorities-runtime/build")
      .field("draft", JSON.stringify(state)).field("roles", "[]")
      .field("id", "draft-1").field("revision", "1").field("title", "Authorities")
      .buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      }).expect(200);
    expect(response.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/u);
    expect((response.body as Buffer).includes(Buffer.from("beaver.authorities-build.v1"))).toBe(true);
    expect((response.body as Buffer).includes(Buffer.from("PK"))).toBe(true);
  });

  it("does not prepare PDFs when an unmarked original-page book cannot use page text", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save()), sourceSha256 = sha256(bytes);
    const state = structuredClone(manualState()) as AuthoritiesDraft;
    Object.assign(state, { outputMode: "book", bindings: { source: {
      kind: "local-file", handleId: "source", lastSeen: {
        name: "Example.pdf", size: bytes.length, modified: 1, sha256: sourceSha256,
      },
    } } });
    state.settings.passageMarking = "none";
    state.authorities.case.source = { kind: "attached", bindingRole: "source",
      filename: "Example.pdf", sourceSha256, sourceUrl: null, origin: "manual" };

    await request(app).post("/authorities-runtime/build")
      .field("draft", JSON.stringify(state)).field("roles", JSON.stringify(["source"]))
      .field("id", "draft-2").field("revision", "1").field("title", "Authorities")
      .attach("files", bytes, "Example.pdf").expect(200);

    expect(mocks.pdfText).not.toHaveBeenCalled();
  });
});
