import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLocalVersionFile: vi.fn(),
  readFile: vi.fn(),
  rehydrateLocalPdfLinkEvidence: vi.fn(),
  verifyLocalPdfLinkEvidence: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isAnonymousLocalMode: () => true }));
vi.mock("../lib/localDocumentStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/localDocumentStore")>()),
  getLocalVersionFile: mocks.getLocalVersionFile,
}));
vi.mock("../lib/localPdfLookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/localPdfLookup")>()),
  rehydrateLocalPdfLinkEvidence: mocks.rehydrateLocalPdfLinkEvidence,
  verifyLocalPdfLinkEvidence: mocks.verifyLocalPdfLinkEvidence,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: mocks.readFile,
}));

import { localDocuments, localLibraryStore } from "../lib/localLibraryStore";
import { createDocumentsRouter } from "./documentRoutes";
import { localDocumentExtensionsRouter } from "./localDocuments";

const app = express();
app.use(express.json());
app.use("/single-documents", localDocumentExtensionsRouter);
app.use(
  "/single-documents",
  createDocumentsRouter(localLibraryStore, localDocuments),
);

const handle = `mike-evidence:v1:${"a".repeat(64)}`;
const file = {
  document: { pdf_storage_path: null },
  version: {
    id: "version-1",
    filename: 'hearing <notes & "orders">.pdf',
  },
  path: "C:\\private\\source.pdf",
  fileType: "pdf",
};
const linkedEvidence = {
  handle,
  documentId: "document-1",
  versionId: "version-1",
  pageNumbers: [7],
  pages: [
    {
      pageNumber: 7,
      label: "[page 7]",
      blockText: 'First <script>alert("x")</script> & quoted text.',
      evidence: {
        url: "/unused",
        blockText: "unused",
        documentText: "unused",
        pageScoped: true as const,
      },
    },
  ],
};

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "anonymous");
  mocks.getLocalVersionFile.mockReset();
  mocks.readFile.mockReset();
  mocks.rehydrateLocalPdfLinkEvidence.mockReset();
  mocks.verifyLocalPdfLinkEvidence.mockReset();
  mocks.getLocalVersionFile.mockResolvedValue(file);
  mocks.readFile.mockResolvedValue(Buffer.from("%PDF"));
  mocks.rehydrateLocalPdfLinkEvidence.mockResolvedValue(linkedEvidence);
  mocks.verifyLocalPdfLinkEvidence.mockResolvedValue({
    documentId: "document-1",
    versionId: "version-1",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local PDF evidence viewer", () => {
  it("serves escaped accessible HTML with a receipt-bound original link", async () => {
    const response = await request(app)
      .get("/single-documents/document-1/evidence-view")
      .query({ version_id: "version-1", evidence: handle });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(
      /^text\/html; charset=utf-8/iu,
    );
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(response.text).toContain('<html lang="en">');
    expect(response.text).toContain('id="page=7"');
    expect(response.text).toContain(
      "hearing &lt;notes &amp; &quot;orders&quot;&gt;.pdf",
    );
    expect(response.text).toContain(
      "First &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; quoted text.",
    );
    expect(response.text).not.toContain("<script>");
    expect(response.text).toContain(
      `href="/single-documents/document-1/display?version_id=version-1&amp;evidence=${encodeURIComponent(handle)}#page=7"`,
    );
    expect(mocks.rehydrateLocalPdfLinkEvidence).toHaveBeenCalledWith(
      "C:\\private\\source.pdf",
      handle,
    );
  });

  it("binds the receipt to the owned route document and exact version", async () => {
    mocks.getLocalVersionFile.mockResolvedValueOnce(null);
    const missing = await request(app)
      .get("/single-documents/other-document/evidence-view")
      .query({ version_id: "other-version", evidence: handle });

    expect(missing.status).toBe(404);
    expect(mocks.getLocalVersionFile).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000001",
      "other-document",
      "other-version",
    );
    expect(mocks.rehydrateLocalPdfLinkEvidence).not.toHaveBeenCalled();

    mocks.rehydrateLocalPdfLinkEvidence.mockResolvedValueOnce({
      ...linkedEvidence,
      documentId: "different-document",
      versionId: "different-version",
    });
    const mismatch = await request(app)
      .get("/single-documents/document-1/evidence-view")
      .query({ version_id: "version-1", evidence: handle });

    expect(mismatch.status).toBe(410);
    expect(mismatch.body).toEqual({
      detail: "Evidence is no longer available",
    });
  });

  it("validates raw PDF evidence without constructing link evidence", async () => {
    const response = await request(app)
      .get("/single-documents/document-1/display")
      .query({ version_id: "version-1", evidence: handle });

    expect(response.status).toBe(200);
    expect(mocks.verifyLocalPdfLinkEvidence).toHaveBeenCalledWith(
      "C:\\private\\source.pdf",
      handle,
    );
    expect(mocks.rehydrateLocalPdfLinkEvidence).not.toHaveBeenCalled();
    expect(mocks.readFile).toHaveBeenCalledWith("C:\\private\\source.pdf");
  });

  it("serves an ordinary display but rejects malformed evidence parameters", async () => {
    const ordinary = await request(app)
      .get("/single-documents/document-1/display")
      .query({ version_id: "version-1" });
    expect(ordinary.status).toBe(200);

    mocks.readFile.mockClear();
    const empty = await request(app).get(
      "/single-documents/document-1/display?version_id=version-1&evidence=",
    );
    const duplicate = await request(app).get(
      `/single-documents/document-1/display?version_id=version-1` +
        `&evidence=${encodeURIComponent(handle)}&evidence=${encodeURIComponent(handle)}`,
    );

    for (const response of [empty, duplicate]) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ detail: "Invalid evidence handle" });
    }
    expect(mocks.verifyLocalPdfLinkEvidence).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("fails closed without leaking drift details or serving stale PDF bytes", async () => {
    mocks.rehydrateLocalPdfLinkEvidence.mockRejectedValue(
      new Error("ENOENT C:\\private\\replacement.pdf"),
    );
    mocks.verifyLocalPdfLinkEvidence.mockRejectedValue(
      new Error("ENOENT C:\\private\\replacement.pdf"),
    );

    const evidenceView = await request(app)
      .get("/single-documents/document-1/evidence-view")
      .query({ version_id: "version-1", evidence: handle });
    const display = await request(app)
      .get("/single-documents/document-1/display")
      .query({ version_id: "version-1", evidence: handle });

    for (const response of [evidenceView, display]) {
      expect(response.status).toBe(410);
      expect(response.body).toEqual({
        detail: "Evidence is no longer available",
      });
      expect(JSON.stringify(response.body)).not.toContain("C:\\private");
    }
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
