import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listLocalLibrary: vi.fn(),
  getLocalVersionFile: vi.fn(),
  readLocalPdfParseState: vi.fn(),
  queueLocalPdfParse: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isAnonymousLocalMode: () => true }));
vi.mock("../lib/localDocumentStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/localDocumentStore")>()),
  listLocalLibrary: mocks.listLocalLibrary,
  getLocalVersionFile: mocks.getLocalVersionFile,
}));
vi.mock("../lib/localPdfIngestion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/localPdfIngestion")>()),
  readLocalPdfParseState: mocks.readLocalPdfParseState,
  queueLocalPdfParse: mocks.queueLocalPdfParse,
}));

import { localLibraryRouter } from "./localLibrary";

const app = express();
app.use(express.json());
app.use("/library", localLibraryRouter);

beforeEach(() => {
  process.env.AUTH_MODE = "anonymous";
  mocks.listLocalLibrary.mockResolvedValue({
    documents: [{ id: "document-1" }],
    folders: [],
  });
  mocks.getLocalVersionFile.mockResolvedValue({
    path: "C:\\data\\source.pdf",
    fileType: "pdf",
    version: {
      id: "version-1",
      source_sha256: "a".repeat(64),
    },
  });
  mocks.readLocalPdfParseState.mockResolvedValue({
    status: "degraded",
    diagnostics: [{ code: "OCR_REQUIRED" }],
  });
  mocks.queueLocalPdfParse.mockResolvedValue({ status: "queued" });
});

describe("local Library PDF parse routes", () => {
  it("returns durable parse state and diagnostics", async () => {
    const response = await request(app).get(
      "/library/files/documents/document-1/pdf-parse",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "degraded",
      diagnostics: [{ code: "OCR_REQUIRED" }],
    });
  });

  it("queues a bounded manual retry for the selected version", async () => {
    const response = await request(app)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ version_id: "version-1" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "queued" });
    expect(mocks.queueLocalPdfParse).toHaveBeenCalledWith({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: "C:\\data\\source.pdf",
      sourceSha256: "a".repeat(64),
      force: true,
    });
  });
});
