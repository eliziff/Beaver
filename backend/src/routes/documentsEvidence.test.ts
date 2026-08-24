import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  rehydratePdfLinkEvidence: vi.fn(),
  verifyPdfLinkEvidence: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isLocalRuntime: () => true }));
vi.mock("../lib/documentProjectionService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/documentProjectionService")>(),
  documentProjectionService: {
    ...(await importOriginal<typeof import("../lib/documentProjectionService")>())
      .documentProjectionService,
    rehydratePdfLink: mocks.rehydratePdfLinkEvidence,
    verifyPdfEvidence: mocks.verifyPdfLinkEvidence,
  },
}));
import { createDocumentsRouter } from "./documentRoutes";

const localDocuments = {
  read: mocks.read,
  download: vi.fn(async () => ({
    kind: "bytes",
    content: {
      bytes: Buffer.from("%PDF"),
      version: { id: "version-1", version_number: 1 },
      filename: "hearing.pdf",
      fileType: "pdf",
      hasPdfRendition: true,
    },
  })),
} as unknown as DocumentStore;
const localLibraryStore = {} as LibraryStore;

const api = express();
api.use(express.json());
api.use(
  "/single-documents",
  createDocumentsRouter(localLibraryStore, localDocuments),
);

const handle = `mike-evidence:v1:${"a".repeat(64)}`;
const file = {
  version: {
    id: "version-1",
    filename: 'hearing <notes & "orders">.pdf',
  },
  bytes: Buffer.from("%PDF"),
  filename: 'hearing <notes & "orders">.pdf',
  fileType: "pdf",
  hasPdfRendition: true,
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
  vi.stubEnv("AUTH_MODE", "local");
  mocks.read.mockReset();
  mocks.rehydratePdfLinkEvidence.mockReset();
  mocks.verifyPdfLinkEvidence.mockReset();
  mocks.read.mockResolvedValue(file);
  mocks.rehydratePdfLinkEvidence.mockResolvedValue(linkedEvidence);
  mocks.verifyPdfLinkEvidence.mockResolvedValue({
    documentId: "document-1",
    versionId: "version-1",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local PDF evidence viewer", () => {
  it("serves escaped accessible HTML with a receipt-bound original link", async () => {
    const response = await request(api)
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
      `href="/api/single-documents/document-1/file?version_id=version-1&amp;evidence=${encodeURIComponent(handle)}&amp;rendition=pdf#page=7"`,
    );
    expect(mocks.rehydratePdfLinkEvidence).toHaveBeenCalledWith(
      file.bytes,
      handle,
    );
  });

  it("binds the receipt to the owned route document and exact version", async () => {
    mocks.read.mockResolvedValueOnce(null);
    const missing = await request(api)
      .get("/single-documents/other-document/evidence-view")
      .query({ version_id: "other-version", evidence: handle });

    expect(missing.status).toBe(404);
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "00000000-0000-0000-0000-000000000001",
      }),
      "other-document", "other-version", false,
    );
    expect(mocks.rehydratePdfLinkEvidence).not.toHaveBeenCalled();

    mocks.rehydratePdfLinkEvidence.mockResolvedValueOnce({
      ...linkedEvidence,
      documentId: "different-document",
      versionId: "different-version",
    });
    const mismatch = await request(api)
      .get("/single-documents/document-1/evidence-view")
      .query({ version_id: "version-1", evidence: handle });

    expect(mismatch.status).toBe(410);
    expect(mismatch.body).toEqual({
      detail: "Evidence is no longer available",
    });
  });

  it("validates raw PDF evidence without constructing link evidence", async () => {
    const response = await request(api)
      .get("/single-documents/document-1/file")
      .query({ version_id: "version-1", evidence: handle, rendition: "pdf" });

    expect(response.status).toBe(200);
    expect(mocks.verifyPdfLinkEvidence).toHaveBeenCalledWith(
      file.bytes,
      handle,
    );
    expect(mocks.rehydratePdfLinkEvidence).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalled();
  });

  it("serves an ordinary display but rejects malformed evidence parameters", async () => {
    const ordinary = await request(api)
      .get("/single-documents/document-1/file")
      .query({ version_id: "version-1", rendition: "pdf" });
    expect(ordinary.status).toBe(200);

    mocks.read.mockClear();
    const empty = await request(api).get(
      "/single-documents/document-1/file?version_id=version-1&rendition=pdf&evidence=",
    );
    const duplicate = await request(api).get(
      `/single-documents/document-1/file?version_id=version-1&rendition=pdf` +
        `&evidence=${encodeURIComponent(handle)}&evidence=${encodeURIComponent(handle)}`,
    );

    for (const response of [empty, duplicate]) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ detail: "Invalid evidence handle" });
    }
    expect(mocks.verifyPdfLinkEvidence).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("fails closed without leaking drift details or serving stale PDF bytes", async () => {
    mocks.rehydratePdfLinkEvidence.mockRejectedValue(
      new Error("ENOENT C:\\private\\replacement.pdf"),
    );
    mocks.verifyPdfLinkEvidence.mockRejectedValue(
      new Error("ENOENT C:\\private\\replacement.pdf"),
    );

    const evidenceView = await request(api)
      .get("/single-documents/document-1/evidence-view")
      .query({ version_id: "version-1", evidence: handle });
    const display = await request(api)
      .get("/single-documents/document-1/file")
      .query({ version_id: "version-1", evidence: handle, rendition: "pdf" });

    for (const response of [evidenceView, display]) {
      expect(response.status).toBe(410);
      expect(response.body).toEqual({
        detail: "Evidence is no longer available",
      });
      expect(JSON.stringify(response.body)).not.toContain("C:\\private");
    }
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});
