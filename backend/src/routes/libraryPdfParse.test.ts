import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";

const mocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  documentMetadata: vi.fn(),
  publishPdf: vi.fn(async () => "C:\\projected\\source.pdf"),
  readPdfParseState: vi.fn(),
  queuePdfParse: vi.fn(),
  parsePdfOnDemand: vi.fn(),
  lookupPdfStructure: vi.fn(),
  readPdfEvidenceReceipt: vi.fn(),
  rehydratePdfEvidence: vi.fn(),
  getCodexModelCatalog: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isLocalRuntime: () => true }));
vi.mock("../lib/documentProjectionService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/documentProjectionService")>(),
  documentProjectionService: {
    ...(await importOriginal<typeof import("../lib/documentProjectionService")>())
      .documentProjectionService,
    publishPdf: mocks.publishPdf,
    pdfState: mocks.readPdfParseState,
    queuePdf: mocks.queuePdfParse,
    parsePdf: mocks.parsePdfOnDemand,
    readPdfEvidence: mocks.readPdfEvidenceReceipt,
    rehydratePdfEvidence: mocks.rehydratePdfEvidence,
    lookupPdf: mocks.lookupPdfStructure,
  },
}));
vi.mock("../lib/codexCatalog", () => ({
  getCodexModelCatalog: mocks.getCodexModelCatalog,
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
} as unknown as DocumentStore, async () => ({})));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_MODE = "local";
  mocks.documentMetadata.mockResolvedValue({ library_kind: "file" });
  mocks.readDocument.mockResolvedValue({
    bytes: Buffer.from("%PDF"),
    fileType: "pdf",
    version: {
      id: "version-1",
      source_sha256: "a".repeat(64),
    },
  });
  mocks.readPdfParseState.mockResolvedValue({
    status: "degraded",
    diagnostics: [{ code: "OCR_REQUIRED" }],
  });
  mocks.queuePdfParse.mockResolvedValue({ status: "queued" });
  mocks.parsePdfOnDemand.mockResolvedValue({ status: "ready" });
  mocks.lookupPdfStructure.mockResolvedValue({ status: "found" });
  mocks.readPdfEvidenceReceipt.mockResolvedValue({
    source: { document_id: "document-1", version_id: "version-1" },
  });
  mocks.rehydratePdfEvidence.mockResolvedValue({ status: "found" });
  mocks.getCodexModelCatalog.mockResolvedValue({
    source: "live",
    models: [
      {
        slug: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        supportedReasoningLevels: [{ effort: "low" }, { effort: "max" }],
      },
    ],
  });
});

describe("local Library PDF parse routes", () => {
  it("starts parsing only when structural lookup is requested", async () => {
    const response = await request(api)
      .post("/library/files/documents/document-1/lookup")
      .send({ locator_kind: "page", locator: "1" });

    expect(response.status).toBe(200);
    expect(mocks.parsePdfOnDemand).toHaveBeenCalledWith({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: "C:\\projected\\source.pdf",
      sourceSha256: "a".repeat(64),
    });
    expect(mocks.lookupPdfStructure).toHaveBeenCalledOnce();
  });

  it("returns durable parse state and diagnostics", async () => {
    const response = await request(api).get(
      "/library/files/documents/document-1/pdf-parse",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "degraded",
      diagnostics: [{ code: "OCR_REQUIRED" }],
    });
  });

  it("queues a bounded manual retry for the selected version", async () => {
    const response = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ version_id: "version-1" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "queued" });
    expect(mocks.queuePdfParse).toHaveBeenCalledWith({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: "C:\\projected\\source.pdf",
      sourceSha256: "a".repeat(64),
      force: true,
    });
  });

  it("queues Tesseract only when the current artifacts require OCR", async () => {
    mocks.readPdfParseState.mockResolvedValue({
      status: "degraded",
      diagnostic_summary: {
        by_code: { OCR_REQUIRED: 2 },
        by_severity: { warning: 2 },
      },
    });

    const response = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        version_id: "version-1",
        ocr_provider: "tesseract",
      });

    expect(response.status).toBe(202);
    expect(mocks.queuePdfParse).toHaveBeenCalledWith({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: "C:\\projected\\source.pdf",
      sourceSha256: "a".repeat(64),
      force: true,
      ocrProvider: "tesseract",
    });
  });

  it("queues vision layout with a default model", async () => {
    const response = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ layout_provider: "mllm" });

    expect(response.status).toBe(202);
    expect(mocks.queuePdfParse).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
        layout: { provider: "mllm", model: expect.any(String) },
      }),
    );
  });

  it("accepts registered vision models and rejects text-only layout models", async () => {
    const accepted = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ layout_provider: "mllm", layout_model: "gemini-3.5-flash" });
    expect(accepted.status).toBe(202);
    expect(mocks.queuePdfParse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        layout: { provider: "mllm", model: "gemini-3.5-flash" },
      }),
    );

    const rejected = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ layout_provider: "mllm", layout_model: "deepseek-v4-flash" });
    expect(rejected.status).toBe(400);
  });

  it("queues the native Kraken provider through the same OCR action", async () => {
    mocks.readPdfParseState.mockResolvedValue({
      status: "degraded",
      diagnostic_summary: { by_code: { OCR_REQUIRED: 1 } },
    });

    const response = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ ocr_provider: "kraken-lite" });

    expect(response.status).toBe(202);
    expect(mocks.queuePdfParse).toHaveBeenCalledWith(
      expect.objectContaining({ ocrProvider: "kraken-lite" }),
    );
  });

  it("returns a safe actionable response when Tesseract is unavailable", async () => {
    mocks.readPdfParseState.mockResolvedValue({
      status: "degraded",
      diagnostic_summary: { by_code: { OCR_REQUIRED: 1 } },
    });
    mocks.queuePdfParse.mockRejectedValue(
      new Error(
        "Tesseract was not found. Install it or configure its executable.",
      ),
    );

    const response = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ ocr_provider: "tesseract" });

    expect(response.status).toBe(503);
    expect(response.body.detail).toContain("Tesseract");
  });

  it("rejects OCR escalation when no page is marked OCR required", async () => {
    const response = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ ocr_provider: "tesseract" });

    expect(response.status).toBe(409);
  });

  it("queues opt-in structural repair with the selected Codex settings", async () => {
    mocks.readPdfParseState.mockResolvedValue({
      status: "degraded",
      structural_repair_available: true,
    });

    const response = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        version_id: "version-1",
        repair: { model: "codex:gpt-5.6-luna", effort: "max" },
      });

    expect(response.status).toBe(202);
    expect(mocks.queuePdfParse).toHaveBeenCalledWith({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: "C:\\projected\\source.pdf",
      sourceSha256: "a".repeat(64),
      force: true,
      repair: { model: "gpt-5.6-luna", effort: "max" },
    });
  });

  it("fails closed for non-Codex repair settings or ineligible diagnostics", async () => {
    const nonCodex = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        repair: { model: "deepseek:deepseek-chat", effort: "low" },
      });

    expect(nonCodex.status).toBe(400);

    const unsupportedEffort = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        repair: { model: "codex:gpt-5.6-luna", effort: "ultra" },
      });

    expect(unsupportedEffort.status).toBe(400);

    const ineligible = await request(api)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        repair: { model: "codex:gpt-5.6-luna", effort: "low" },
      });

    expect(ineligible.status).toBe(409);
    expect(mocks.queuePdfParse).not.toHaveBeenCalled();
  });

  it("rehydrates evidence only inside the matching Library kind", async () => {
    mocks.documentMetadata.mockResolvedValue({ library_kind: "template" });
    mocks.readDocument.mockResolvedValue({
      fileType: "pdf",
      document: { library_kind: "template" },
      version: { id: "version-1" },
    });

    const response = await request(api)
      .post("/library/templates/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "found" });
    expect(mocks.rehydratePdfEvidence).toHaveBeenCalledWith(
      "C:\\projected\\source.pdf",
      "mike-evidence:v1:receipt",
    );
  });

  it("rejects evidence from a different Library kind", async () => {
    mocks.documentMetadata.mockResolvedValue({ library_kind: "template" });
    mocks.readDocument.mockResolvedValue({
      fileType: "pdf",
      document: { library_kind: "template" },
      version: { id: "version-1" },
    });

    const response = await request(api)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      detail: "PDF evidence source or artifact is unavailable",
    });
    expect(mocks.rehydratePdfEvidence).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("C:\\private");
  });

  it("distinguishes a missing receipt from a missing downstream artifact", async () => {
    mocks.readPdfEvidenceReceipt.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    const missingReceipt = await request(api)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:missing" });

    expect(missingReceipt.status).toBe(404);
    expect(missingReceipt.body).toEqual({
      detail: "PDF evidence receipt not found",
    });

    mocks.readDocument.mockResolvedValue({
      fileType: "pdf",
      document: { library_kind: "file" },
      version: { id: "version-1" },
    });
    mocks.rehydratePdfEvidence.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT C:\\private\\source.pdf"), {
        code: "ENOENT",
      }),
    );
    const missingArtifact = await request(api)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });

    expect(missingArtifact.status).toBe(409);
    expect(missingArtifact.body).toEqual({
      detail: "PDF evidence source or artifact is unavailable",
    });
    expect(JSON.stringify(missingArtifact.body)).not.toContain("C:\\private");
  });
});
