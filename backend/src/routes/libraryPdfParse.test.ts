import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";

const mocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  documentMetadata: vi.fn(),
  publishPdf: vi.fn(async () => "C:\\projected\\source.pdf"),
  enqueuePdfReprocess: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isLocalRuntime: () => true }));
vi.mock("../lib/documentProjectionService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/documentProjectionService")>()),
  documentProjectionService: {
    ...(await importOriginal<typeof import("../lib/documentProjectionService")>())
      .documentProjectionService,
    publishPdf: mocks.publishPdf,
  },
}));
vi.mock("../lib/pdfJobs", () => ({
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
  mocks.enqueuePdfReprocess.mockResolvedValue({ id: "job-1", status: "queued" });
});

const retry = (body: Record<string, unknown> = {}) => request(api)
  .post("/library/files/documents/document-1/actions/retry-pdf-parse")
  .send(body);

describe("local Library PDF routes", () => {
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
});
