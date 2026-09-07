import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import { createLibraryStore, type LibraryRepository } from "../lib/libraryStore";

const mocks = vi.hoisted(() => ({
  projectionSource: vi.fn(),
  documentMetadata: vi.fn(),
  enqueuePdfReprocess: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isLocalRuntime: () => true }));
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
const documents = {
  projectionSource: mocks.projectionSource,
  metadata: mocks.documentMetadata,
} as unknown as DocumentStore;
api.use("/library", createLibraryRouter(createLibraryStore({} as LibraryRepository, documents), documents));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_MODE = "local";
  mocks.documentMetadata.mockResolvedValue({ project_id: null, library_kind: "file" });
  mocks.projectionSource.mockResolvedValue({
    fileType: "pdf",
    versionId: "version-1", sourceSha256: "a".repeat(64),
    readBytes: () => { throw new Error("Queuing preparation must not read the PDF"); },
  });
  mocks.enqueuePdfReprocess.mockResolvedValue({ id: "job-1", status: "queued" });
});

const retry = (body: Record<string, unknown> = {}) => request(api)
  .post("/library/files/documents/document-1/actions/retry-pdf-parse")
  .send(body);

describe("local Library PDF routes", () => {
  it("queues plain and OCR retries for the authenticated user", async () => {
    expect((await retry({ version_id: "version-1" })).status).toBe(202);
    expect((await retry({ ocr_provider: "tesseract" })).status).toBe(202);

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
      ]);
  });

  it("rejects unsupported OCR and remote layout providers", async () => {
    expect((await retry({ ocr_provider: "remote" })).status).toBe(400);
    expect((await retry({ layout_provider: "mllm" })).status).toBe(400);
    expect(mocks.enqueuePdfReprocess).not.toHaveBeenCalled();
  });

  it("rejects another Library, unavailable versions, and non-PDF sources", async () => {
    mocks.documentMetadata.mockResolvedValueOnce({ project_id: null, library_kind: "template" });
    expect((await retry()).status).toBe(404);
    mocks.projectionSource.mockResolvedValueOnce(null);
    expect((await retry()).status).toBe(404);
    mocks.projectionSource.mockResolvedValueOnce({ fileType: "docx" });
    expect((await retry()).status).toBe(409);
    expect(mocks.enqueuePdfReprocess).not.toHaveBeenCalled();
  });

  it("also queues an accessible project PDF through the shared retry endpoint", async () => {
    mocks.documentMetadata.mockResolvedValueOnce({ project_id: "shared-matter", library_kind: "file" });
    expect((await retry()).status).toBe(202);
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
