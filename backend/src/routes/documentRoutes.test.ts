import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
import { zipDocumentBytes } from "../lib/__tests__/support/documentBytes";
import { MAX_OBJECT_SIZE_BYTES } from "../lib/storage";
import { createDocumentsRouter } from "./documentRoutes";

const version = {
  id: "v1",
  version_number: 1,
  source: "upload",
  created_at: "2026-01-01T00:00:00Z",
  filename: "draft.docx",
  file_type: "docx",
};

function fixture() {
  const library = {
    page: vi.fn().mockResolvedValue({
      items: [{ kind: "document", document: { id: "d1", filename: "draft.docx" } }],
      nextAfter: null,
    }),
  } as unknown as LibraryStore;
  const documents = {
    resumeCleanup: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: "d1", filename: "draft.docx" }),
    deleteDocument: vi.fn().mockResolvedValue(true),
    files: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue({
      bytes: Buffer.from("document"),
      version,
      filename: "draft.docx",
      fileType: "docx",
      hasPdfRendition: false,
    }),
    download: vi.fn().mockResolvedValue({ kind: "bytes", content: {
      bytes: Buffer.from("document"), version, filename: "draft.docx",
      fileType: "docx", hasPdfRendition: false,
    } }),
    versions: vi.fn().mockResolvedValue({
      current_version_id: "v1",
      versions: [version],
    }),
    addVersion: vi.fn().mockResolvedValue(version),
    copyVersion: vi.fn().mockResolvedValue({ status: "created", version }),
    renameVersion: vi.fn().mockResolvedValue(version),
    replaceVersion: vi.fn().mockResolvedValue({ status: "replaced", version }),
    deleteVersion: vi.fn().mockResolvedValue({
      status: "deleted",
      currentVersionId: "v1",
    }),
    resolveEdit: vi.fn().mockResolvedValue({
      status: "resolved",
      editStatus: "accepted",
      versionId: "v1",
      versionNumber: 1,
      downloadUrl: "/single-documents/d1/file?version_id=v1",
    }),
  } as unknown as DocumentStore;
  const app = express();
  app.use(express.json());
  app.use("/single-documents", createDocumentsRouter(library, documents));
  return { app, library, documents };
}

describe("canonical document routes", () => {
  beforeEach(() => process.env.AUTH_MODE = "local");

  it("owns collection paging and upload validation", async () => {
    const { app, library, documents } = fixture();
    expect((await request(app).get("/single-documents?q=DRAFT")).body.items)
      .toEqual([{ id: "d1", filename: "draft.docx" }]);
    expect(library.page).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file" }),
      expect.objectContaining({ q: "draft", documentsOnly: true }),
    );
    expect((await request(app).post("/single-documents")
      .attach("file", Buffer.from("bad"), "draft.exe")).status).toBe(400);
    expect((await request(app).post("/single-documents")).status).toBe(400);
    expect((await request(app).post("/single-documents")
      .attach("file", await zipDocumentBytes(), "draft.docx")).status).toBe(201);
    expect(documents.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filename: "draft.docx", libraryKind: "file" }),
    );
    expect((await request(app).post("/single-documents/download-zip")
      .send({ document_ids: [] })).status).toBe(400);
    expect((await request(app).post("/single-documents/download-zip")
      .send({ document_ids: ["missing"] })).status).toBe(404);
  });

  it("bounds archive work and flattens untrusted filenames", async () => {
    const { app, documents } = fixture();
    expect((await request(app).post("/single-documents/download-zip").send({
      document_ids: Array.from({ length: 101 }, (_, index) => `d${index}`),
    })).status).toBe(400);
    vi.mocked(documents.files).mockResolvedValueOnce([
      { bytes: Buffer.from("one"), version, filename: "../brief?.docx",
        fileType: "docx", hasPdfRendition: false },
      { bytes: Buffer.from("two"), version, filename: "../brief?.docx",
        fileType: "docx", hasPdfRendition: false },
    ]);
    const response = await request(app).post("/single-documents/download-zip")
      .send({ document_ids: ["d1", "d2"] }).buffer(true)
      .parse((incoming, done) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const zip = await (await import("jszip")).default.loadAsync(response.body);
    expect(Object.keys(zip.files)).toEqual([
      "001-_brief_.docx", "002-_brief_.docx",
    ]);
    expect(documents.files).toHaveBeenCalledWith(
      expect.anything(), ["d1", "d2"], MAX_OBJECT_SIZE_BYTES,
    );
  });

  it("serves local bytes and removes the divergent URL endpoint", async () => {
    const { app, documents } = fixture();
    const display = await request(app).get(
      "/single-documents/d1/file?rendition=pdf&version_id=v1",
    );
    expect(display.status).toBe(200);
    expect(display.headers["content-disposition"]).toContain("inline");
    expect(documents.download).toHaveBeenCalledWith(
      expect.anything(), "d1", "v1", true, "inline",
    );
    expect((await request(app).get("/single-documents/d1/url")).status).toBe(404);
  });

  it("serves a bounded spreadsheet projection with merged-cell coordinates", async () => {
    const { app, documents } = fixture();
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["Merged heading", ""], ["A", "B"]]);
    sheet["!merges"] = [XLSX.utils.decode_range("A1:B1")];
    XLSX.utils.book_append_sheet(workbook, sheet, "Review");
    vi.mocked(documents.read).mockResolvedValueOnce({
      bytes: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })),
      version: { ...version, file_type: "xlsx", filename: "review.xlsx" },
      filename: "review.xlsx",
      fileType: "xlsx",
      hasPdfRendition: false,
    });
    const response = await request(app).get(
      "/single-documents/d1/spreadsheet?version_id=v1",
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toMatchObject({
      version_id: "v1",
      sheets: [{ name: "Review", cells: [
        { address: "A1", value: "Merged heading", row: 1, column: 1, columnSpan: 2 },
        { address: "A2", value: "A", row: 2, column: 1 },
        { address: "B2", value: "B", row: 2, column: 2 },
      ] }],
    });
  });

  it("redirects an authorized cloud download without caching it", async () => {
    const { app, documents } = fixture();
    vi.mocked(documents.download).mockResolvedValueOnce({
      kind: "redirect", url: "https://storage.test/private?signature=short",
    });
    const response = await request(app).get("/single-documents/d1/file");
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("https://storage.test/private");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("normalizes version uploads and maps mutation outcomes once", async () => {
    const { app, documents } = fixture();
    const added = await request(app).post("/single-documents/d1/versions")
      .field("filename", " revised.docx ")
      .attach("file", await zipDocumentBytes(), "upload.docx");
    expect(added.status).toBe(201);
    expect(documents.addVersion).toHaveBeenCalledWith(
      expect.anything(),
      "d1",
      expect.objectContaining({ filename: "revised.docx", fileType: "docx" }),
    );
    vi.mocked(documents.deleteVersion).mockResolvedValueOnce({ status: "only" });
    expect((await request(app).delete("/single-documents/d1/versions/v1")).status)
      .toBe(400);
  });

  it("keeps tracked-edit conflicts and successes on one response contract", async () => {
    const { app, documents } = fixture();
    expect((await request(app).post("/single-documents/d1/edits/e1/accept"))
      .body).toMatchObject({ status: "accepted", version_id: "v1" });
    vi.mocked(documents.resolveEdit).mockResolvedValueOnce({
      status: "conflict",
      editStatus: "rejected",
    });
    const conflict = await request(app).post(
      "/single-documents/d1/edits/e1/accept",
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.detail).toBe("Tracked edit is already rejected");
  });
});
