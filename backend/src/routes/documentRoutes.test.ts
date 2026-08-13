import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
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
    upload: vi.fn().mockResolvedValue({ id: "d1", filename: "draft.docx" }),
  } as unknown as LibraryStore;
  const documents = {
    deleteDocument: vi.fn().mockResolvedValue(true),
    files: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue({
      bytes: Buffer.from("document"),
      version,
      filename: "draft.docx",
      fileType: "docx",
      hasPdfRendition: false,
    }),
    link: vi.fn().mockResolvedValue({
      version,
      filename: "draft.docx",
      fileType: "docx",
      hasPdfRendition: false,
    }),
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
  beforeEach(() => process.env.AUTH_MODE = "anonymous");

  it("owns collection paging and upload validation", async () => {
    const { app, library } = fixture();
    expect((await request(app).get("/single-documents?q=DRAFT")).body.items)
      .toEqual([{ id: "d1", filename: "draft.docx" }]);
    expect(library.page).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file" }),
      expect.objectContaining({ q: "draft", documentsOnly: true }),
    );
    expect((await request(app).post("/single-documents")
      .attach("file", Buffer.from("bad"), "draft.exe")).status).toBe(400);
    expect((await request(app).post("/single-documents")
      .attach("file", Buffer.from("docx"), "draft.docx")).status).toBe(201);
    expect(library.upload).toHaveBeenCalledOnce();
  });

  it("serves bytes and constructs the authenticated local link", async () => {
    const { app, documents } = fixture();
    const display = await request(app).get(
      "/single-documents/d1/display?version_id=v1",
    );
    expect(display.status).toBe(200);
    expect(display.headers["content-disposition"]).toContain("inline");
    expect(documents.read).toHaveBeenCalledWith(
      expect.anything(), "d1", "v1", true,
    );
    const link = await request(app).get("/single-documents/d1/url");
    expect(link.body.version_id).toBe("v1");
    expect(link.body.url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/single-documents\/d1\/file\?version_id=v1$/u,
    );
  });

  it("normalizes version uploads and maps mutation outcomes once", async () => {
    const { app, documents } = fixture();
    const added = await request(app).post("/single-documents/d1/versions")
      .field("filename", " revised.docx ")
      .attach("file", Buffer.from("docx"), "upload.docx");
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
