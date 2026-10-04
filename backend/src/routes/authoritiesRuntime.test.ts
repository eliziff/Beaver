import express from "express";
import { Document, FootnoteReferenceRun, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import * as pdfLibrary from "pdf-lib";
import { mapAuthorityBookBytes, renderAuthoritiesBook, type PreparedAuthoritiesBook } from "mike/shared/runtime/authoritiesBook.mjs";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthoritiesDraft } from "../lib/authoritiesDomain";
import type { AuthoritiesDiscrepancy } from "../lib/authoritiesDiscrepancy";
import { sha256 } from "../lib/hash";
import { ANNOTATION_SCHEMA } from "mike/shared/pdf-annotations.mjs";
import { assertAuthoritiesBuildUploadSize } from "../lib/authoritiesOperations";
import { createAuthoritiesRuntimeRouter } from
  "./authoritiesRuntime";

const mocks = vi.hoisted(() => ({ importFile: vi.fn(), pdfText: vi.fn() }));
vi.mock("../lib/authoritiesImport", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/authoritiesImport")>(),
  importStandaloneAuthoritiesFile: mocks.importFile,
}));
vi.mock("../lib/authorityPdfText", () => ({ authorityPdfText: mocks.pdfText, authorityPdfOutline: vi.fn(async () => []) }));

const originalMode = process.env.AUTH_MODE;
const app = express(); app.use(express.json());
const resolveSources = vi.fn(async (draft: AuthoritiesDraft) => ({ draft, attachments: [] }));
app.use("/authorities-runtime", createAuthoritiesRuntimeRouter((_req, _res, next) => next(), resolveSources));

beforeAll(() => { process.env.AUTH_MODE = "local"; });
afterAll(() => { process.env.AUTH_MODE = originalMode; });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const manualState = () => ({ schemaVersion: "beaver.authorities-draft.v1" as const,
  import: { kind: "manual" as const }, bindings: {}, outputMode: "table" as const,
  cover: { courtFileNumber: "", partyGroups: [], applicationUnder: "", title: "" },
  settings: { profileId: "general" as const, sourceMode: "automatic" as const,
    tabStyle: "numeric" as const, tableOrder: "alphabetical" as const,
    tableDelivery: "native-append" as const, tableLocation: "pages" as const,
    passageMarking: "margin" as const, scannedPdfPolicy: "page-margin" as const,
    missingSourcePolicy: "placeholder" as const },
  bookParts: { cover: null, index: null, supplements: [] },
  insertIntoDocument: false, ledger: null, units: [], occurrences: {}, discrepancyDecisions: {},
  authorityOrder: ["case"], authorities: { case: {
    id: "case", key: "case", kind: "case" as const, citation: "2024 ABKB 123",
    name: "Example v Example", displayName: null,
    evidenceIds: [], locators: [],
    sourceIdentity: null, excluded: false, source: { kind: "unresolved" as const },
  } } });

describe("standalone Authorities runtime", () => {
  it("reads an unprepared source without OCR and rejects changed source bytes", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save()), sourceSha256 = sha256(bytes);
    const state = structuredClone(manualState()) as AuthoritiesDraft;
    state.bindings.source = { kind: "local-file", handleId: "source", lastSeen: {
      name: "Example.pdf", size: bytes.length, modified: 1, sha256: sourceSha256,
    } };
    state.authorities.case.source = { kind: "attached", sources: [{ bindingRole: "source",
      filename: "Example.pdf", sourceSha256, sourceUrl: null, origin: "manual", language: "en" }] };
    await request(app).post("/authorities-runtime/source-text")
      .field("draft", JSON.stringify(state)).field("role", "source")
      .attach("file", bytes, "Example.pdf").expect(200, { pages: [] });
    await request(app).post("/authorities-runtime/source-text")
      .field("draft", JSON.stringify(state)).field("role", "source")
      .attach("file", Buffer.concat([bytes, Buffer.from("changed")]), "Example.pdf").expect(409);
    await request(app).post("/authorities-runtime/source-text")
      .field("draft", JSON.stringify(state)).field("role", "source").field("pages", "[0]")
      .attach("file", bytes, "Example.pdf").expect(400);
  });

  it("prepares one source's marks while another source's saved highlights belong to a replaced PDF", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save()), sourceSha256 = sha256(bytes), replaced = "b".repeat(64);
    const state = structuredClone(manualState()) as AuthoritiesDraft;
    state.bindings.source = { kind: "local-file", handleId: "source", lastSeen: {
      name: "Example.pdf", size: bytes.length, modified: 1, sha256: sourceSha256 } };
    state.authorities.case.locators = [{ kind: "paragraph", label: "1" }];
    state.authorities.case.source = { kind: "attached", sources: [{ bindingRole: "source",
      filename: "Example.pdf", sourceSha256, sourceUrl: null, origin: "manual", language: "en" }] };
    state.bindings.other = { kind: "local-file", handleId: "other", lastSeen: {
      name: "Other.pdf", size: 1, modified: 1, sha256: replaced } };
    state.authorityOrder.push("other");
    state.authorities.other = { ...state.authorities.case, id: "other", key: "other", citation: "2025 ABKB 9",
      locators: [], source: { kind: "attached", sources: [{ bindingRole: "other", filename: "Other.pdf",
        sourceSha256: replaced, sourceUrl: null, origin: "manual", language: "en" }] },
      annotations: { other: { schemaVersion: ANNOTATION_SCHEMA, sourceSha256: "c".repeat(64), marks: [] } } };
    mocks.pdfText.mockResolvedValue({ pageTextByPage: [""], ocrTextByPage: [""] });
    const response = await request(app).post("/authorities-runtime/annotations")
      .field("draft", JSON.stringify(state)).field("authorityId", "case").field("bindingRole", "source")
      .attach("file", bytes, "Example.pdf").expect(200);
    expect(response.body.annotations.sourceSha256).toBe(sourceSha256);
  });

  it("requires the attached PDF's exact bytes and positive page numbers before recognition", async () => {
    const bytes = Buffer.from("%PDF-1.7\nsource-text transport fixture\n%%EOF");
    const sourceSha256 = sha256(bytes), state = structuredClone(manualState()) as AuthoritiesDraft;
    state.bindings.source = { kind: "local-file", handleId: "source", lastSeen: {
      name: "Example.pdf", size: bytes.length, modified: 1, sha256: sourceSha256,
    } };
    state.authorities.case.source = { kind: "attached", sources: [{ bindingRole: "source",
      filename: "Example.pdf", sourceSha256, sourceUrl: null, origin: "manual", language: "en" }] };
    await request(app).post("/authorities-runtime/source-text")
      .field("draft", JSON.stringify(state)).field("role", "source")
      .attach("file", Buffer.from("%PDF-1.7\nchanged\n%%EOF"), "Example.pdf").expect(409);
    for (const pages of [[], [0], [1.5]]) {
      await request(app).post("/authorities-runtime/source-text")
        .field("draft", JSON.stringify(state)).field("role", "source")
        .field("pages", JSON.stringify(pages)).attach("file", bytes, "Example.pdf").expect(400);
    }
  });

  it("rejects an aggregate build upload above 512 MB before reading files", () => {
    expect(() => assertAuthoritiesBuildUploadSize([{ size: 512 * 1024 ** 2 + 1 }]))
      .toThrow(expect.objectContaining({ status: 413,
        message: "Authorities build files are too large together. Maximum total is 512 MB." }));
  });

  

  

  it("returns a corrected Word copy and refreshed standalone draft", async () => {
    const note = "2020 SCC 1 at para 19", body = "The court quoted the source.";
    const bytes = await Packer.toBuffer(new Document({
      footnotes: { 7: { children: [new Paragraph({ children: [new TextRun(note)] })] } },
      sections: [{ children: [new Paragraph({ children: [
        new TextRun(body), new FootnoteReferenceRun(7),
      ] })] }],
    }));
    const state = structuredClone(manualState()) as AuthoritiesDraft;
    state.import = { kind: "document", bindingRole: "source", filename: "Factum.docx",
      fileType: "docx", snapshot: null };
    state.bindings.source = { kind: "local-file", handleId: "source", lastSeen: {
      name: "Factum.docx", size: bytes.length, modified: 1, sha256: sha256(bytes),
    } };
    state.authorities.case.citation = "2020 SCC 1";
    const pinpoint = note.indexOf("19");
    state.units = [
      { id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [[1, body.length]], pageNumbers: [], text: body, occurrenceIds: [] },
      { id: "footnote:7", kind: "footnote", ordinal: 1, footnoteId: 1,
        footnoteRefs: [], pageNumbers: [], text: note, occurrenceIds: ["cite"] },
    ];
    state.occurrences = { cite: { id: "cite", unitId: "footnote:7", start: 0,
      end: note.length, text: note, authoritySpan: { start: 0, end: 10, text: "2020 SCC 1" },
      coreSpan: { start: 0, end: 10, text: "2020 SCC 1" }, pinpointSpan: {
        start: pinpoint, end: pinpoint + 2, text: "19" }, kind: "case", citation: "2020 SCC 1",
      authorityId: "case", reference: null, pinpoints: [{ kind: "paragraph", text: "19" }],
      evidenceIds: [], sourceTextSha256: sha256(Buffer.from(note)), localOrdinal: 0,
      reviewed: true } };
    const id = "e".repeat(64), finding: AuthoritiesDiscrepancy = {
      id, actions: ["ignore", "pinpoint"], kind: "wrong_pinpoint", occurrenceId: "cite",
      authorityId: "case", footnoteId: 1, citation: "2020 SCC 1", proposition: body,
      authoredQuote: "the source", authoredPinpoint: { kind: "paragraph", text: "19" },
      cited: { locator: { kind: "paragraph", label: "19" }, text: "Different." },
      found: { locator: { kind: "paragraph", label: "20" }, text: "the source" },
    };
    mocks.importFile.mockImplementationOnce(async (input) => {
      const fresh = structuredClone(state); fresh.import.filename = input.filename;
      fresh.bindings.source = { kind: "local-file", handleId: "standalone", lastSeen: {
        name: input.filename, size: input.bytes.length, modified: 0, sha256: sha256(input.bytes),
      } };
      fresh.units[1].text = note.replace("19", "20");
      Object.assign(fresh.occurrences.cite, { text: fresh.units[1].text,
        pinpointSpan: { start: pinpoint, end: pinpoint + 2, text: "20" },
        pinpoints: [{ kind: "paragraph", text: "20" }],
        sourceTextSha256: sha256(Buffer.from(fresh.units[1].text)) });
      return fresh;
    });
    state.stage = "sources";
    const correctionApp = express(); correctionApp.use(express.json());
    correctionApp.use("/authorities-runtime", createAuthoritiesRuntimeRouter((_req, _res, next) => next(),
      resolveSources, async () => [finding]));
    const response = await request(correctionApp).post("/authorities-runtime/discrepancies/actions")
      .field("draft", JSON.stringify(state)).field("request", JSON.stringify({
        id, action: "pinpoint", revision: 1,
      })).field("modified", "1").attach("file", bytes, "Factum.docx")
      .buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(response.status, String(response.body)).toBe(200);
    const form = await new Response(response.body as Buffer, { headers: {
      "content-type": response.headers["content-type"],
    } }).formData();
    const corrected = form.get("source") as File;
    const xml = await (await JSZip.loadAsync(await corrected.arrayBuffer()))
      .file("word/footnotes.xml")!.async("string");
    const refreshed = JSON.parse(String(form.get("draft"))) as AuthoritiesDraft;

    expect(xml).toContain("at para 20");
    expect(refreshed.stage).toBe("sources");
    expect(refreshed.import).toMatchObject({ filename: "Factum corrected.docx" });
    expect(refreshed.discrepancyDecisions).toEqual({ [id]: "pinpoint" });
    expect(refreshed.bindings.source).toMatchObject({ kind: "local-file",
      lastSeen: { sha256: sha256(Buffer.from(await corrected.arrayBuffer())) } });
  });

  

  

  

  

  

  

  it("accepts only actual PDF uploads for book parts", async () => {
    await request(app).post("/authorities-runtime/pdf")
      .field("draft", JSON.stringify(manualState())).field("slot", "cover")
      .field("modified", "1").attach("file", Buffer.from("%PDF-1.7"), "Cover.txt")
      .expect(400);
    await request(app).post("/authorities-runtime/pdf")
      .field("draft", JSON.stringify(manualState())).field("slot", "index")
      .field("modified", "1").attach("file", Buffer.from("not a pdf"), "Index.pdf")
      .expect(400);
    for (const fields of [{ slot: "cover" }, { authority_id: "case", language: "en" }]) {
      let upload = request(app).post("/authorities-runtime/pdf")
        .field("draft", JSON.stringify(manualState())).field("modified", "1");
      for (const [key, value] of Object.entries(fields)) upload = upload.field(key, value!);
      await upload.attach("file", Buffer.from("%PDF-1.7\ncorrupt\n%%EOF"), "Broken.pdf")
        .expect(400);
    }
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
    const form = await new Response(response.body as Buffer, { headers: {
      "content-type": response.headers["content-type"],
    } }).formData();
    expect(JSON.parse(String(form.get("receipt"))).schemaVersion).toBe("beaver.authorities-build.v1");
    const table = await JSZip.loadAsync(await (form.get("table") as File).arrayBuffer());
    expect(await table.file("word/document.xml")!.async("string")).toContain("Example v Example");
  });

  

  it("returns the combined final PDF as a complete multipart artifact", async () => {
    const source = await PDFDocument.create(); source.addPage();
    const bytes = Buffer.from(await source.save()), digest = sha256(bytes);
    const state = structuredClone(manualState()) as AuthoritiesDraft;
    state.outputMode = "book";
    state.import = { kind: "document", bindingRole: "source", filename: "Factum.pdf",
      fileType: "pdf", snapshot: null };
    state.settings = { ...state.settings, passageMarking: "none", finalPdf: true };
    state.bindings.source = { kind: "local-file", handleId: "source", lastSeen: {
      name: "Factum.pdf", size: bytes.length, modified: 1, sha256: digest,
    } };
    state.bindings.authority = { kind: "local-file", handleId: "authority", lastSeen: {
      name: "Case.pdf", size: bytes.length, modified: 1, sha256: digest,
    } };
    state.authorities.case.source = { kind: "attached", sources: [{ bindingRole: "authority",
      filename: "Case.pdf", sourceSha256: digest, sourceUrl: null, origin: "manual", language: "en" }] };

    const response = await request(app).post("/authorities-runtime/build")
      .field("draft", JSON.stringify(state)).field("roles", JSON.stringify(["source", "authority"]))
      .field("id", "draft-final").field("revision", "1").field("title", "Factum")
      .attach("files", bytes, "Factum.pdf").attach("files", bytes, "Case.pdf")
      .buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      }).expect(200);
    const form = await new Response(response.body as Buffer, { headers: {
      "content-type": response.headers["content-type"],
    } }).formData();
    const receipt = JSON.parse(String(form.get("receipt")));
    const final = Buffer.from(await (form.get("final-pdf") as File).arrayBuffer());

    expect(form.get("book")).toBeInstanceOf(File);
    expect(receipt.outputs["final-pdf"]).toMatchObject({ mimeType: "application/pdf", pageCount: 5,
      sha256: sha256(final) });
    expect((await PDFDocument.load(final)).getPageCount()).toBe(5);
  });

  it("exports a large reviewed draft with more than 100 attached authority PDFs", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save()), digest = sha256(bytes);
    const state = structuredClone(manualState()) as AuthoritiesDraft;
    state.outputMode = "book";
    state.settings.passageMarking = "none";
    state.authorityOrder = [];
    state.authorities = {};
    state.units = Array.from({ length: 11 }, (_, ordinal) => ({
      id: `body:${ordinal}`, kind: "body", ordinal, footnoteId: null,
      footnoteRefs: [], pageNumbers: [], text: "Reviewed source text. ".repeat(5_000),
      occurrenceIds: [],
    }));
    const roles = Array.from({ length: 101 }, (_, index) => `authority:${index}`);
    for (const [index, role] of roles.entries()) {
      const id = `case-${index}`;
      state.authorityOrder.push(id);
      state.authorities[id] = { ...manualState().authorities.case, id, key: id,
        citation: `2024 ABKB ${index + 1}`, name: `Example ${index + 1}`,
        source: { kind: "attached", sources: [{ bindingRole: role,
          filename: `${id}.pdf`, sourceSha256: digest, sourceUrl: null,
          origin: "manual", language: "en" }] } };
      state.bindings[role] = { kind: "local-file", handleId: id, lastSeen: {
        name: `${id}.pdf`, size: bytes.length, modified: 1, sha256: digest,
      } };
    }
    let build = request(app).post("/authorities-runtime/build")
      .field("draft", JSON.stringify(state)).field("roles", JSON.stringify(roles))
      .field("id", "draft-large").field("revision", "1").field("title", "Authorities");
    for (const [index] of roles.entries()) build = build.attach("files", bytes, `case-${index}.pdf`);
    const response = await build.buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    const form = await new Response(response.body as Buffer, { headers: {
      "content-type": response.headers["content-type"],
    } }).formData();
    const plan = await mapAuthorityBookBytes(JSON.parse(String(form.get("book"))) as PreparedAuthoritiesBook<string>,
      async (role) => new Uint8Array(await (form.get(role) as File).arrayBuffer()));
    expect(plan.sources.map(({ key }) => key).sort()).toEqual(state.authorityOrder.map(id => `authority:${id}`).sort());
    const [book] = await renderAuthoritiesBook(pdfLibrary, plan);
    expect(book.placements).toHaveLength(101);
    expect(book.placements.every(placement => placement.sourcePageIndices.length === 1)).toBe(true);
    expect((await PDFDocument.load(book.bytes)).getPageCount()).toBe(book.pageCount);
  });

  it("prepares an incomplete book with a placeholder for unavailable attached bytes", async () => {
    const state = structuredClone(manualState()) as AuthoritiesDraft;
    state.outputMode = "book";
    state.settings = { ...state.settings, passageMarking: "none", allowIncomplete: true };
    state.bindings.authority = { kind: "local-file", handleId: "missing", lastSeen: {
      name: "Case.pdf", size: 3, modified: 1, sha256: "a".repeat(64),
    } };
    state.authorities.case.source = { kind: "attached", sources: [{ bindingRole: "authority",
      filename: "Case.pdf", sourceSha256: "a".repeat(64), sourceUrl: null, origin: "manual", language: "en" }] };

    const response = await request(app).post("/authorities-runtime/build")
      .field("draft", JSON.stringify(state)).field("roles", "[]")
      .field("id", "draft-incomplete").field("revision", "1").field("title", "Factum")
      .buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      }).expect(200);
    const form = await new Response(response.body as Buffer, { headers: {
      "content-type": response.headers["content-type"],
    } }).formData();
    const plan = await mapAuthorityBookBytes(JSON.parse(String(form.get("book"))) as PreparedAuthoritiesBook<string>,
      async (role) => new Uint8Array(await (form.get(role) as File).arrayBuffer()));
    const [book] = await renderAuthoritiesBook(pdfLibrary, plan);

    expect(book.pageCount).toBe(4);
    expect(JSON.parse(String(form.get("receipt"))).authorities[0]).toMatchObject({ tab: "Tab 1" });
  });

});
