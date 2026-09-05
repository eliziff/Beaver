import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
import { zipDocumentBytes } from "../lib/__tests__/support/documentBytes";
import { MAX_OBJECT_SIZE_BYTES } from "../lib/storage";
import { sha256 } from "../lib/hash";
import { createA2AJPassageEvidence } from "../lib/chat/legalEvidence";
import { createResearchFileState, researchFileMarkdown } from "../lib/researchFile";
import { verifyResearchPassage } from "../lib/researchFileQuery";
import { createDocumentsRouter } from "./documentRoutes";

vi.mock("../lib/researchFileQuery", async (original) => { const module =
  await original<typeof import("../lib/researchFileQuery")>();
return { ...module, verifyResearchPassage: vi.fn(module.verifyResearchPassage) }; });

const version = {
  id: "v1",
  version_number: 1,
  working_revision: 0,
  created_by: "owner",
  source: "upload",
  created_at: "2026-01-01T00:00:00Z",
  filename: "draft.docx",
  file_type: "docx",
  source_sha256: sha256(Buffer.from("document")),
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
    metadata: vi.fn().mockResolvedValue(null),
    deleteDocument: vi.fn().mockResolvedValue(true),
    files: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue({
      bytes: Buffer.from("document"),
      version,
      filename: "draft.docx",
      fileType: "docx",
      hasPdfRendition: false,
    }),
    readParts: vi.fn().mockResolvedValue([]),
    download: vi.fn().mockResolvedValue({ kind: "bytes", content: {
      bytes: Buffer.from("document"), version, filename: "draft.docx",
      fileType: "docx", hasPdfRendition: false,
    } }),
    versions: vi.fn().mockResolvedValue({
      current_version_id: "v1",
      versions: [version],
    }),
    addVersion: vi.fn().mockResolvedValue(version),
    restoreVersion: vi.fn().mockResolvedValue({ status: "restored", version }),
    checkpointVersion: vi.fn().mockResolvedValue({ status: "created", version }),
    compareVersions: vi.fn().mockResolvedValue({ status: "compared",
      bytes: Buffer.from("redline"), filename: "changes.docx" }),
    renameVersion: vi.fn().mockResolvedValue(version),
    replaceVersion: vi.fn().mockResolvedValue({ status: "replaced", version }),
    deleteVersion: vi.fn().mockResolvedValue({
      status: "deleted",
      currentVersionId: "v1",
    }),
    resolveEdits: vi.fn().mockResolvedValue({
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
    const { app, documents } = fixture();
    expect((await request(app).get("/single-documents?q=DRAFT")).body.items)
      .toEqual([{ id: "d1", filename: "draft.docx" }]);
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

  it("deletes only the exact document state the user confirmed", async () => {
    const { app, documents } = fixture();
    expect((await request(app).delete("/single-documents/d1")).status).toBe(400);
    const expected = { expected_current_version_id: "v1", expected_working_revision: 0,
      expected_project_id: null, expected_folder_id: null };
    expect((await request(app).delete("/single-documents/d1").send({ ...expected,
      expected_working_revision: null })).status).toBe(400);
    expect((await request(app).delete("/single-documents/d1").send(expected)).status).toBe(204);
    expect(documents.deleteDocument).toHaveBeenCalledWith(expect.anything(), "d1", true, {
      versionId: "v1", workingRevision: 0, projectId: null, folderId: null,
    });
    vi.mocked(documents.deleteDocument).mockResolvedValueOnce(false);
    expect((await request(app).delete("/single-documents/d1").send(expected)).status).toBe(409);
  });

  it("commits one snapshot and returns passage IDs without a rescan", async () => {
    const { app, documents } = fixture(), sourceId = "10000000-0000-4000-8000-000000000001",
      state = createResearchFileState(), receipt = createA2AJPassageEvidence({
        citation: "Example", name: "Example", dataset: "scc", language: "en",
        sourceText: "holding", spanText: "holding", start: 0, end: 7, externalUrl: null,
        sourceClass: "case", sourceReference: { id: "case-1" } });
    state.sources[sourceId] = { id: sourceId, reference: { provider: "a2aj", id: "case-1",
      kind: "case" }, labelIds: [], badge: "", note: "", passages: null };
    const bytes = Buffer.from(researchFileMarkdown("Cases", state));
    vi.mocked(documents.metadata).mockResolvedValueOnce({ id: "d1",
      filename: "Cases.research.md", current_version_id: "v1", current_working_revision: 0 });
    vi.mocked(documents.read).mockResolvedValueOnce({ bytes, filename: "Cases.research.md",
      fileType: "md", hasPdfRendition: false, version: { ...version,
        filename: "Cases.research.md", file_type: "md", size_bytes: bytes.length,
        source_sha256: sha256(bytes) } });
    vi.mocked(documents.replaceVersion).mockResolvedValueOnce({ status: "replaced",
      version: { ...version, working_revision: 1, filename: "Cases.research.md",
        file_type: "md", size_bytes: bytes.length } });
    vi.mocked(verifyResearchPassage).mockResolvedValueOnce({ type: "merge", evidence: [receipt] });
    const response = await request(app).post("/single-documents/d1/research/actions").send({
      version_id: "v1", working_revision: 0, action: { type: "passage", sourceId,
        locator: { kind: "paragraph", value: "1" }, quote: "holding" }, });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sourceId, evidenceId: receipt.evidence_id });
    expect(documents.metadata).toHaveBeenCalledTimes(1);
    expect(documents.read).toHaveBeenCalledTimes(1);
    expect(documents.replaceVersion).toHaveBeenCalledWith(
      expect.anything(), "d1", "v1", 0, expect.objectContaining({ fileType: "md" }),
    );
  });

  it("marks stale research revisions as retryable", async () => {
    const { app } = fixture();
    const action = await request(app).post("/single-documents/d1/research/actions").send({
      version_id: "v1", working_revision: 0, action: { type: "note", markdown: "Reviewed" },
    });
    const query = await request(app).post("/single-documents/d1/research/query").send({
      version_id: "v1", working_revision: 0, text: "fairness", syntax: "literal", target: "sources",
    });
    expect([action.status, query.status]).toEqual([409, 409]);
    expect([action.body, query.body]).toEqual([
      expect.objectContaining({ code: "revision_conflict" }),
      expect.objectContaining({ code: "revision_conflict" }),
    ]);
  });

  it("passes the Unclassified scope through research queries", async () => {
    const { app, documents } = fixture();
    const bytes = Buffer.from(researchFileMarkdown("Cases", createResearchFileState()));
    vi.mocked(documents.metadata).mockResolvedValueOnce({ id: "d1",
      filename: "Cases.research.md", current_version_id: "v1", current_working_revision: 0 });
    vi.mocked(documents.read).mockResolvedValueOnce({ bytes, filename: "Cases.research.md",
      fileType: "md", hasPdfRendition: false, version: { ...version,
        filename: "Cases.research.md", file_type: "md", size_bytes: bytes.length } });
    vi.mocked(documents.replaceVersion).mockResolvedValueOnce({ status: "replaced",
      version: { ...version, working_revision: 1, filename: "Cases.research.md",
        file_type: "md", size_bytes: bytes.length } });
    const response = await request(app).post("/single-documents/d1/research/query").send({
      version_id: "v1", working_revision: 0, text: "fairness", syntax: "literal",
      target: "sources", unlabelled: true,
    });
    expect(response.status).toBe(200);
    expect(response.body.coverage).toMatchObject({ complete: true, next_after: null,
      attempted_sources: 0, selected_sources: 0 });
    const written = vi.mocked(documents.replaceVersion).mock.calls[0][4], queryPart =
      written.parts?.put?.find(({ name }) => name === "queries.json");
    const saved = JSON.parse(queryPart!.bytes.toString()).queries[response.body.receipt.query_id];
    expect(response.body.receipt).toEqual(saved);
    expect(saved.input).toMatchObject({ unlabelled: true });
  });

  it("keeps research cursors across metadata edits but rejects changed passage content", async () => {
    const { app, documents } = fixture(), sourceId = "10000000-0000-4000-8000-000000000001",
      receipts = Array.from({ length: 3 }, (_, index) => createA2AJPassageEvidence({
        citation: "Example", name: "Example", dataset: "scc", language: "en",
        sourceText: `holding ${index}`, spanText: `holding ${index}`, start: 0, end: 9,
        externalUrl: null, sourceClass: "case", sourceReference: { id: "case-1" } })),
      evidence = Object.fromEntries(receipts.map((receipt) => [receipt.evidence_id,
        { receipt, sourceId, labelIds: [], note: "" }])), part = Buffer.from(JSON.stringify({
          schemaVersion: "beaver.research-source.v1", sourceId, evidence })),
      state = createResearchFileState();
    state.sources[sourceId] = { id: sourceId, reference: { provider: "a2aj", id: "case-1",
      kind: "case", citation: "Example" }, labelIds: [], badge: "", note: "",
      passages: { count: 3, sha256: sha256(part), labelCounts: {}, unlabelledCount: 3 } };
    let bytes = Buffer.from(researchFileMarkdown("Cases", state)), revision = 0;
    vi.mocked(documents.metadata).mockImplementation(async () => ({ id: "d1",
      filename: "Cases.research.md", current_version_id: "v1",
      current_working_revision: revision }));
    vi.mocked(documents.read).mockImplementation(async () => ({ bytes,
      filename: "Cases.research.md", fileType: "md", hasPdfRendition: false,
      version: { ...version, filename: "Cases.research.md", file_type: "md",
        size_bytes: bytes.length, working_revision: revision, source_sha256: sha256(bytes) } }));
    vi.mocked(documents.readParts).mockImplementation(async (_scope, _id, _version, names) =>
      names.includes(`source.${sourceId}.json`)
        ? [{ name: `source.${sourceId}.json`, bytes: part, sha256: sha256(part) }] : []);

    const first = await request(app).get(`/single-documents/d1/research/items`)
      .query({ kind: "passages", source_id: sourceId, limit: 2 });
    expect(first.body).toMatchObject({ total: 3, items: [{ index: 0 }, { index: 1 }] });
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await request(app).get(`/single-documents/d1/research/items`)
      .query({ kind: "passages", source_id: sourceId, limit: 2,
        cursor: first.body.next_cursor });
    expect(second.body).toMatchObject({ total: 3, items: [{ index: 2 }], next_cursor: null });
    expect((await request(app).get(`/single-documents/d1/research/items`).query({
      kind: "passages", source_id: "20000000-0000-4000-8000-000000000002" })).status).toBe(404);
    revision = 1;
    state.sources[sourceId]!.note = "Updated source note";
    bytes = Buffer.from(researchFileMarkdown("Renamed", state));
    const continued = await request(app).get(`/single-documents/d1/research/items`).query({
      kind: "passages", source_id: sourceId, limit: 2, cursor: first.body.next_cursor });
    expect(continued.status).toBe(200);
    expect(continued.body).toMatchObject({ items: [{ index: 2 }], next_cursor: null });
    state.sources[sourceId]!.passages!.sha256 = sha256("changed");
    bytes = Buffer.from(researchFileMarkdown("Renamed", state));
    expect((await request(app).get(`/single-documents/d1/research/items`).query({
      kind: "passages", source_id: sourceId, limit: 2,
      cursor: first.body.next_cursor })).status).toBe(400);
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
    const bytes = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    vi.mocked(documents.read).mockResolvedValueOnce({
      bytes,
      version: { ...version, file_type: "xlsx", filename: "review.xlsx",
        source_sha256: sha256(bytes) },
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
      .field("expected_current_version_id", "v1")
      .field("expected_working_revision", "0")
      .attach("file", await zipDocumentBytes(), "upload.docx");
    expect(added.status).toBe(201);
    expect(documents.addVersion).toHaveBeenCalledWith(
      expect.anything(),
      "d1",
      expect.objectContaining({ filename: "revised.docx", fileType: "docx",
        expectedCurrentVersionId: "v1", expectedCurrentWorkingRevision: 0 }),
    );
    expect((await request(app).post("/single-documents/d1/versions/v1/restore")).status)
      .toBe(400);
    expect((await request(app).post("/single-documents/d1/versions/v1/restore")
      .send({ expected_current_version_id: "v2", expected_working_revision: 0 })).status)
      .toBe(201);
    expect(documents.restoreVersion).toHaveBeenCalledWith(
      expect.anything(), "d1", "v1", "v2", 0, undefined,
    );
    expect((await request(app).post("/single-documents/d1/versions/checkpoint")
      .send({ expected_current_version_id: "v1", expected_working_revision: 0,
        comment: "Reviewed" })).status).toBe(201);
    expect(documents.checkpointVersion).toHaveBeenCalledWith(
      expect.anything(), "d1", "v1", 0, "Reviewed");
    vi.mocked(documents.restoreVersion).mockResolvedValueOnce({ status: "pending-edits" });
    const pendingRestore = await request(app).post(
      "/single-documents/d1/versions/v1/restore",
    ).send({ expected_current_version_id: "v2", expected_working_revision: 0 });
    expect([pendingRestore.status, pendingRestore.body.detail]).toEqual([
      409, "Versions with pending tracked changes cannot be restored",
    ]);
    vi.mocked(documents.checkpointVersion).mockResolvedValueOnce({ status: "pending-edits" });
    const pendingCheckpoint = await request(app).post(
      "/single-documents/d1/versions/checkpoint",
    ).send({ expected_current_version_id: "v1", expected_working_revision: 0 });
    expect([pendingCheckpoint.status, pendingCheckpoint.body.detail]).toEqual([
      409, "Resolve pending tracked changes before creating a version",
    ]);
    expect((await request(app).get(
      "/single-documents/d1/versions/v1/compare?baseline_version_id=v0",
    )).status).toBe(200);
  });

  it("keeps tracked-edit conflicts and successes on one response contract", async () => {
    const { app, documents } = fixture();
    expect((await request(app).post("/single-documents/d1/edits/accept")
      .send({ edit_ids: ["e1", "e2"] }))
      .body).toMatchObject({ status: "accepted", version_id: "v1" });
    expect(documents.resolveEdits).toHaveBeenCalledWith(
      expect.anything(), "d1", ["e1", "e2"], "accept",
    );
    vi.mocked(documents.resolveEdits).mockResolvedValueOnce({
      status: "conflict",
      editStatus: "rejected",
    });
    const conflict = await request(app).post(
      "/single-documents/d1/edits/accept",
    ).send({ edit_ids: ["e1"] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.detail).toBe("Tracked edit is already rejected");
  });
});
