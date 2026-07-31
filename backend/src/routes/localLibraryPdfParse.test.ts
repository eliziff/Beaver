import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listLocalLibrary: vi.fn(),
  getLocalVersionFile: vi.fn(),
  readLocalPdfParseState: vi.fn(),
  queueLocalPdfParse: vi.fn(),
  parseLocalPdfOnDemand: vi.fn(),
  lookupLocalPdfStructure: vi.fn(),
  readLocalPdfEvidenceReceipt: vi.fn(),
  rehydrateLocalPdfEvidence: vi.fn(),
  getCodexModelCatalog: vi.fn(),
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
  parseLocalPdfOnDemand: mocks.parseLocalPdfOnDemand,
}));
vi.mock("../lib/localPdfLookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/localPdfLookup")>()),
  readLocalPdfEvidenceReceipt: mocks.readLocalPdfEvidenceReceipt,
  rehydrateLocalPdfEvidence: mocks.rehydrateLocalPdfEvidence,
  lookupLocalPdfStructure: mocks.lookupLocalPdfStructure,
}));
vi.mock("../lib/codexCatalog", () => ({
  getCodexModelCatalog: mocks.getCodexModelCatalog,
}));

import { localLibraryRouter } from "./localLibrary";

const app = express();
app.use(express.json());
app.use("/library", localLibraryRouter);

beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.parseLocalPdfOnDemand.mockResolvedValue({ status: "ready" });
  mocks.lookupLocalPdfStructure.mockResolvedValue({ status: "found" });
  mocks.readLocalPdfEvidenceReceipt.mockResolvedValue({
    source: { document_id: "document-1", version_id: "version-1" },
  });
  mocks.rehydrateLocalPdfEvidence.mockResolvedValue({ status: "found" });
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
    const response = await request(app)
      .post("/library/files/documents/document-1/lookup")
      .send({ locator_kind: "page", locator: "1" });

    expect(response.status).toBe(200);
    expect(mocks.parseLocalPdfOnDemand).toHaveBeenCalledWith({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: "C:\\data\\source.pdf",
      sourceSha256: "a".repeat(64),
    });
    expect(mocks.lookupLocalPdfStructure).toHaveBeenCalledOnce();
  });

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

  it("queues Tesseract only when the current artifacts require OCR", async () => {
    mocks.readLocalPdfParseState.mockResolvedValue({
      status: "degraded",
      diagnostic_summary: {
        by_code: { OCR_REQUIRED: 2 },
        by_severity: { warning: 2 },
      },
    });

    const response = await request(app)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        version_id: "version-1",
        ocr_provider: "tesseract",
      });

    expect(response.status).toBe(202);
    expect(mocks.queueLocalPdfParse).toHaveBeenCalledWith({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: "C:\\data\\source.pdf",
      sourceSha256: "a".repeat(64),
      force: true,
      ocrProvider: "tesseract",
    });
  });

  it("returns a safe actionable response when Tesseract is unavailable", async () => {
    mocks.readLocalPdfParseState.mockResolvedValue({
      status: "degraded",
      diagnostic_summary: { by_code: { OCR_REQUIRED: 1 } },
    });
    mocks.queueLocalPdfParse.mockRejectedValue(
      new Error(
        "Tesseract was not found. Install it or configure its executable.",
      ),
    );

    const response = await request(app)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ ocr_provider: "tesseract" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      detail:
        "Tesseract was not found. Install it or configure its executable.",
    });
  });

  it("rejects OCR escalation when no page is marked OCR required", async () => {
    const response = await request(app)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({ ocr_provider: "tesseract" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      detail: "No PDF pages currently require OCR",
    });
  });

  it("queues opt-in structural repair with the selected Codex settings", async () => {
    mocks.readLocalPdfParseState.mockResolvedValue({
      status: "degraded",
      structural_repair_available: true,
    });

    const response = await request(app)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        version_id: "version-1",
        repair: { model: "codex:gpt-5.6-luna", effort: "max" },
      });

    expect(response.status).toBe(202);
    expect(mocks.queueLocalPdfParse).toHaveBeenCalledWith({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: "C:\\data\\source.pdf",
      sourceSha256: "a".repeat(64),
      force: true,
      repair: { model: "gpt-5.6-luna", effort: "max" },
    });
  });

  it("fails closed for non-Codex repair settings or ineligible diagnostics", async () => {
    const nonCodex = await request(app)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        repair: { model: "deepseek:deepseek-chat", effort: "low" },
      });

    expect(nonCodex.status).toBe(400);
    expect(nonCodex.body.detail).toContain("requires a Codex model");

    const unsupportedEffort = await request(app)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        repair: { model: "codex:gpt-5.6-luna", effort: "ultra" },
      });

    expect(unsupportedEffort.status).toBe(400);
    expect(unsupportedEffort.body.detail).toContain("is not available");

    const ineligible = await request(app)
      .post("/library/files/documents/document-1/actions/retry-pdf-parse")
      .send({
        repair: { model: "codex:gpt-5.6-luna", effort: "low" },
      });

    expect(ineligible.status).toBe(409);
    expect(ineligible.body).toEqual({
      detail: "No unresolved PDF structure is eligible for bounded repair",
    });
    expect(mocks.queueLocalPdfParse).not.toHaveBeenCalled();
  });

  it("rehydrates evidence only inside the matching Library kind", async () => {
    mocks.getLocalVersionFile.mockResolvedValue({
      path: "C:\\data\\source.pdf",
      fileType: "pdf",
      document: { library_kind: "template" },
      version: { id: "version-1" },
    });

    const response = await request(app)
      .post("/library/templates/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "found" });
    expect(mocks.rehydrateLocalPdfEvidence).toHaveBeenCalledWith(
      "C:\\data\\source.pdf",
      "mike-evidence:v1:receipt",
    );
  });

  it("rejects evidence from a different Library kind", async () => {
    mocks.getLocalVersionFile.mockResolvedValue({
      path: "C:\\private\\template.pdf",
      fileType: "pdf",
      document: { library_kind: "template" },
      version: { id: "version-1" },
    });

    const response = await request(app)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      detail: "PDF evidence source or artifact is unavailable",
    });
    expect(mocks.rehydrateLocalPdfEvidence).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("C:\\private");
  });

  it("distinguishes a missing receipt from a missing downstream artifact", async () => {
    mocks.readLocalPdfEvidenceReceipt.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    const missingReceipt = await request(app)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:missing" });

    expect(missingReceipt.status).toBe(404);
    expect(missingReceipt.body).toEqual({
      detail: "PDF evidence receipt not found",
    });

    mocks.getLocalVersionFile.mockResolvedValue({
      path: "C:\\private\\source.pdf",
      fileType: "pdf",
      document: { library_kind: "file" },
      version: { id: "version-1" },
    });
    mocks.rehydrateLocalPdfEvidence.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT C:\\private\\source.pdf"), {
        code: "ENOENT",
      }),
    );
    const missingArtifact = await request(app)
      .post("/library/files/evidence/rehydrate")
      .send({ handle: "mike-evidence:v1:receipt" });

    expect(missingArtifact.status).toBe(409);
    expect(missingArtifact.body).toEqual({
      detail: "PDF evidence source or artifact is unavailable",
    });
    expect(JSON.stringify(missingArtifact.body)).not.toContain("C:\\private");
  });
});
