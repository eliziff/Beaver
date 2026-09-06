import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";

const scope = { userId: "00000000-0000-0000-0000-000000000001" };
const missingHandle = `mike-evidence:v1:${"a".repeat(64)}`;
let directory: string, documents: DocumentStore, id: string, version: string, handle: string;
const api = express();
api.use(express.json());

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "document-evidence-routes-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
  const [{ createDocumentApplication }, { documentRepository }, objects,
    { documentProjectionService }, { createDocumentsRouter }] = await Promise.all([
    import("../lib/documentApplication"), import("../lib/relationalDocumentRepository"),
    import("../lib/filesystemObjectStorage"), import("../lib/documentProjectionService"),
    import("./documentRoutes"),
  ]);
  documents = createDocumentApplication(documentRepository, objects.filesystemDocumentObjects());
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('First <script>alert("x")</script> & quoted text.');
  const created = await documents.create(scope, { filename: "hearing.pdf", fileType: "pdf",
    bytes: Buffer.from(await pdf.save()) });
  id = created.id; version = created.current_version_id;
  const source = (await documents.projectionSource(scope, id, version))!;
  const receipt = await documentProjectionService.lookupPdf(source.readBytes,
    { locatorKind: "page", locator: "1" }, { ...source, persistEvidence: true });
  if (receipt.status !== "found") throw new Error("Evidence fixture was not found");
  handle = receipt.evidence.handle;
  api.use("/single-documents", createDocumentsRouter({} as LibraryStore, documents));
});

afterAll(async () => {
  await (await import("../lib/relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const evidenceView = (documentId = id, versionId = version, evidence = handle) => request(api)
  .get(`/single-documents/${documentId}/evidence-view`)
  .query({ version_id: versionId, evidence });
const download = (evidence?: string) => request(api).get(`/single-documents/${id}/file`)
  .query({ version_id: version, rendition: "pdf", ...(evidence ? { evidence } : {}) });

describe("receipt-bound document reads", () => {
  it("serves escaped evidence HTML and verifies the linked original PDF", async () => {
    const response = await evidenceView();
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html; charset=utf-8/iu);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.text).toContain('id="page=1"');
    expect(response.text).toContain("First &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; quoted text.");
    expect(response.text).toContain(`href="/api/single-documents/${id}/file?version_id=${version}` +
      `&amp;evidence=${encodeURIComponent(handle)}&amp;rendition=pdf#page=1"`);
    const file = await download(handle);
    expect(file.status).toBe(200);
    expect(file.body).toEqual((await documents.read(scope, id, version, false))!.bytes);
    expect(file.headers["cache-control"]).toBe("private, no-store");
  });

  it("binds receipts to authorized documents and exact versions", async () => {
    const bytes = (await documents.read(scope, id, version, false))!.bytes;
    const hidden = await documents.create({ userId: "someone-else" }, {
      filename: "private.pdf", fileType: "pdf", bytes });
    expect((await evidenceView(hidden.id, hidden.current_version_id)).status).toBe(404);
    const copy = await documents.create(scope, { filename: "copy.pdf", fileType: "pdf", bytes });
    expect((await evidenceView(copy.id, copy.current_version_id)).status).toBe(410);
    expect((await evidenceView(id, "missing-version")).status).toBe(404);
    const next = await documents.addVersion(scope, id, { filename: "renamed.pdf", fileType: "pdf", bytes });
    expect(next).not.toBeNull();
    expect((await evidenceView(id, next!.id)).status).toBe(410);
    const original = await evidenceView();
    expect(original.status).toBe(200);
    expect(original.text).toContain("<h1>hearing.pdf</h1>");
  });

  it("serves ordinary downloads and rejects malformed or unavailable evidence", async () => {
    expect((await download()).status).toBe(200);
    const base = `/single-documents/${id}/file?version_id=${version}&rendition=pdf`;
    for (const query of ["&evidence=", `&evidence=${handle}&evidence=${handle}`]) {
      const response = await request(api).get(base + query);
      expect(response.status).toBe(400);
    }
    for (const response of [await evidenceView(id, version, missingHandle), await download(missingHandle)]) {
      expect(response.status).toBe(410);
    }
  });

  it("serves the authoritative spreadsheet grid with merged-cell coordinates", async () => {
    const XLSX = await import("xlsx"), workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["Merged heading", ""], ["A", "B"]]);
    sheet["!merges"] = [XLSX.utils.decode_range("A1:B1")];
    XLSX.utils.book_append_sheet(workbook, sheet, "Review");
    const created = await documents.create(scope, { filename: "review.xlsx", fileType: "xlsx",
      bytes: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })) });
    const response = await request(api).get(`/single-documents/${created.id}/spreadsheet`)
      .query({ version_id: created.current_version_id });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({ version_id: created.current_version_id,
      sheets: [{ name: "Review", cells: [
        { address: "A1", value: "Merged heading", row: 1, column: 1, columnSpan: 2 },
        { address: "A2", value: "A", row: 2, column: 1 },
        { address: "B2", value: "B", row: 2, column: 2 },
      ] }] });
    expect((await request(api).get(`/single-documents/${id}/spreadsheet`)).status).toBe(400);
    expect(await documents.spreadsheet({ userId: "someone-else" }, created.id, null)).toBeNull();
  });
});
