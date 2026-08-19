import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";

const mocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  documentMetadata: vi.fn(),
  publishPdf: vi.fn(async () => "C:\\projected\\source.pdf"),
  pdfState: vi.fn(),
  preparePdf: vi.fn(),
  enqueuePdfReprocess: vi.fn(),
  lookupPdf: vi.fn(),
  readPdfEvidence: vi.fn(),
  rehydratePdfEvidence: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isLocalRuntime: () => true }));
vi.mock("../lib/documentProjectionService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/documentProjectionService")>()),
  documentProjectionService: {
    ...(await importOriginal<typeof import("../lib/documentProjectionService")>())
      .documentProjectionService,
    publishPdf: mocks.publishPdf,
    pdfState: mocks.pdfState,
    readPdfEvidence: mocks.readPdfEvidence,
    rehydratePdfEvidence: mocks.rehydratePdfEvidence,
    lookupPdf: mocks.lookupPdf,
  },
}));
vi.mock("../lib/pdfJobs", () => ({
  preparePdf: mocks.preparePdf,
  enqueuePdfReprocess: mocks.enqueuePdfReprocess,
}));

import { createLibraryRouter } from "./library";

const api = express();
api.use(express.json());
api.use((_req, res, next) => {
  res.locals.userId = "local-user";
  next();
});
api.use("/library", createLibraryRouter({} as LibraryStore, {
  read: mocks.readDocument,
  metadata: mocks.documentMetadata,
} as unknown as DocumentStore));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_MODE = "local";
  mocks.documentMetadata.mockResolvedValue({ library_kind: "file" });
  mocks.readDocument.mockResolvedValue({
    bytes: Buffer.from("%PDF"),
    fileType: "pdf",
    document: { library_kind: "file" },
    version: { id: "version-1", source_sha256: "a".repeat(64) },
  });
  mocks.pdfState.mockResolvedValue({ status: "degraded", pages_needing_ocr: [1] });
  mocks.enqueuePdfReprocess.mockResolvedValue({ id: "job-1", status: "queued" });
  mocks.preparePdf.mockResolvedValue("cache-key");
  mocks.lookupPdf.mockResolvedValue({ status: "found" });
  mocks.readPdfEvidence.mockResolvedValue({
    source: { document_id: "document-1", version_id: "version-1" },
  });
  mocks.rehydratePdfEvidence.mockResolvedValue({ status: "found" });
});

const retry = (body: Record<string, unknown> = {}) => request(api)
  .post("/library/files/documents/document-1/actions/retry-pdf-parse")
  .send(body);

describe("local Library PDF routes", () => {
  it("prepares structural data on first lookup and binds document identity", async () => {
    const response = await request(api)
      .post("/library/files/documents/document-1/lookup")
      .send({ locator_kind: "page", locator: "1" });

    expect(response.status).toBe(200);
    expect(mocks.preparePdf).toHaveBeenCalledWith({
      userId: "00000000-0000-0000-0000-000000000001",
      documentId: "document-1",
      versionId: "version-1",
      sourceSha256: "a".repeat(64),
    });
    expect(mocks.lookupPdf).toHaveBeenCalledWith(
      "C:\\projected\\source.pdf",
      { locatorKind: "page", locator: "1" },
      {
        cacheKey: "cache-key",
        documentId: "document-1",
        versionId: "version-1",
      },
    );
  });

  it("returns durable preparation status", async () => {
    const response = await request(api).get(
      "/library/files/documents/document-1/pdf-parse",
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "degraded", pages_needing_ocr: [1] });
  });

  it("queues plain, OCR, and local-layout retries for the authenticated user", async () => {
    expect((await retry({ version_id: "version-1" })).status).toBe(202);
    expect((await retry({ ocr_provider: "tesseract" })).status).toBe(202);
    expect((await retry({ ocr_provider: "kraken-lite" })).status).toBe(202);
    expect((await retry({ layout_provider: "local" })).status).toBe(202);

    const common = {
      userId: "00000000-0000-0000-0000-000000000001",
      documentId: "document-1",
      versionId: "version-1",
      sourceSha256: "a".repeat(64),
    };
    expect(mocks.enqueuePdfReprocess.mock.calls.map(([value]) => value))
      .toEqual([
        common,
        { ...common, ocrProvider: "tesseract" },
        { ...common, ocrProvider: "kraken-lite" },
        { ...common, layout: true },
      ]);
  });

  it("rejects unsupported OCR and remote layout providers", async () => {
    expect((await retry({ ocr_provider: "remote" })).status).toBe(400);
    expect((await retry({ layout_provider: "mllm" })).status).toBe(400);
    expect(mocks.enqueuePdfReprocess).not.toHaveBeenCalled();
  });

  it("returns a safe actionable local-runtime error", async () => {
    mocks.enqueuePdfReprocess.mockRejectedValue(
      new Error("Tesseract was not found at C:\\private\\tesseract.exe"),
    );
    const response = await retry({ ocr_provider: "tesseract" });
    expect(response.status).toBe(503);
    expect(response.body.detail).toContain("Tesseract was not found");
    expect(JSON.stringify(response.body)).not.toContain("C:\\private");
  });

  it("rehydrates evidence only inside its authenticated Library kind", async () => {
    mocks.documentMetadata.mockResolvedValue({ library_kind: "template" });
    mocks.readDocument.mockResolvedValue({
      fileType: "pdf",
      document: { library_kind: "template" },
      version: { id: "version-1" },
    });

    const accepted = await request(api)
      .post("/library/templates/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });
    expect(accepted.status).toBe(200);
    expect(mocks.rehydratePdfEvidence).toHaveBeenCalledWith(
      "C:\\projected\\source.pdf",
      "mike-evidence:v1:receipt",
    );

    const rejected = await request(api)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });
    expect(rejected.status).toBe(409);
  });

  it("distinguishes a missing receipt from unavailable source evidence", async () => {
    mocks.readPdfEvidence.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    const missing = await request(api)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:missing" });
    expect(missing.status).toBe(404);
    expect(missing.body.detail).toBe("PDF evidence receipt not found");

    mocks.rehydratePdfEvidence.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT C:\\private\\source.pdf"), { code: "ENOENT" }),
    );
    const unavailable = await request(api)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.detail).toBe("PDF evidence source or artifact is unavailable");
    expect(JSON.stringify(unavailable.body)).not.toContain("C:\\private");
  });
});
