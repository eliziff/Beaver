import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
import type { ObjectStorage } from "../lib/storage";
import { sha256 } from "../lib/hash";
const owner = { userId: "00000000-0000-0000-0000-000000000001", userEmail: "owner@example.test" };
let directory: string, documents: DocumentStore, objects: ObjectStorage, id: string, versionId: string, bytes: Buffer;
let app: ReturnType<typeof express>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-document-ranges-"));
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
  const [{ createDocumentApplication }, { documentRepository }, { createFilesystemObjectStorage }, { createDocumentsRouter }] = await Promise.all([
    import("../lib/documentApplication"), import("../lib/relationalDocumentRepository"), import("../lib/storage"), import("./documentRoutes"),
  ]);
  objects = createFilesystemObjectStorage(path.join(directory, "objects"));
  documents = createDocumentApplication(documentRepository, objects);
  const pdf = await PDFDocument.create(); pdf.addPage().drawText("Verified range fixture");
  bytes = Buffer.from(await pdf.save());
  const created = await documents.create(owner, { filename: "Fixture.pdf", fileType: "pdf", bytes });
  id = created.id; versionId = created.current_version_id;
  app = express(); app.use("/single-documents", createDocumentsRouter({} as LibraryStore, documents));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await (await import("../lib/relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});
const get = (range: string, documentId = id) => request(app).get(`/single-documents/${documentId}/file?rendition=pdf`).set("Range", range);

it("serves exact ranges of verified bytes, pins the representation, and reuses one blob read", async () => {
  const reads = vi.spyOn(objects, "get");
  const first = await get("bytes=0-99");
  expect(first.status).toBe(206); expect(first.body).toEqual(bytes.subarray(0, 100));
  expect(first.headers).toMatchObject({ "content-range": `bytes 0-99/${bytes.length}`,
    "content-length": "100", etag: `"${sha256(bytes)}"`, "accept-ranges": "bytes", "cache-control": "private, no-store" });
  const next = await get("bytes=100-199").set("If-Match", first.headers.etag);
  expect(next.status).toBe(206); expect(next.body).toEqual(bytes.subarray(100, 200));
  expect(reads).toHaveBeenCalledOnce();
  expect((await get("bytes=0-10").set("If-Match", `"${"a".repeat(64)}"`)).status).toBe(412);
});

it("supports suffix/open ranges, HEAD and If-Range without fabricated multipart responses", async () => {
  expect((await get("bytes=-20")).body).toEqual(bytes.subarray(-20));
  expect((await get("bytes=10-")).body).toEqual(bytes.subarray(10));
  expect((await get("bytes=0-999999999999999999999")).body).toEqual(bytes);
  for (const range of ["bytes=-0", `bytes=${bytes.length}-`, "bytes=20-10"]) {
    const response = await get(range);
    expect(response.status).toBe(416); expect(response.headers["content-range"]).toBe(`bytes */${bytes.length}`);
  }
  expect((await get("bytes=0-10,20-30")).status).toBe(200);
  const fallback = await get("bytes=0-10").set("If-Range", '"old"');
  expect(fallback.status).toBe(200); expect(fallback.body).toEqual(bytes);
  expect((await get("bytes=0-10").set("If-None-Match", `W/"${sha256(bytes)}"`)).status).toBe(304);
  expect((await get("bytes=0-10").set("If-Match", `W/"${sha256(bytes)}"`)).status).toBe(412);
  const head = await request(app).head(`/single-documents/${id}/file?rendition=pdf`).set("Range", "bytes=0-10");
  expect(head.status).toBe(200); expect(head.text).toBeUndefined(); expect(head.headers["content-length"]).toBe(String(bytes.length));
});

it("rejects changed current versions and deleted documents even after a warm range read", async () => {
  const first = await get("bytes=0-20");
  const updated = Buffer.concat([bytes, Buffer.from("\n%new revision\n")]);
  await documents.addVersion(owner, id, { filename: "Fixture.pdf", fileType: "pdf", bytes: updated });
  expect((await get("bytes=21-40").set("If-Match", first.headers.etag)).status).toBe(412);
  const historical = await request(app).get(`/single-documents/${id}/file?rendition=pdf&version_id=${versionId}`)
    .set("Range", "bytes=21-40").set("If-Match", first.headers.etag);
  expect(historical.status).toBe(206); expect(historical.body).toEqual(bytes.subarray(21, 41));
  await documents.deleteDocument(owner, id);
  expect((await get("bytes=0-20")).status).toBe(404);
});

it("does not release any range of a corrupt blob and retries after recovery", async () => {
  const reads = vi.spyOn(objects, "get").mockResolvedValueOnce(Buffer.from("corrupt"));
  await expect(documents.download(owner, id, null, { preferPdf: true, disposition: "inline", range: true }))
    .rejects.toThrow("integrity check");
  expect((await get("bytes=0-10")).status).toBe(206); expect(reads).toHaveBeenCalledTimes(2);
});

it("enforces each reader's authorization before and after the shared verification", async () => {
  const { relationalDatabase, sql } = await import("../lib/relationalDatabase");
  const db = await relationalDatabase(), projectId = randomUUID(), reader = { userId: randomUUID(), userEmail: "reader@example.test" };
  await db.query(sql`INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(${projectId},${owner.userId},'Shared','now','now')`);
  await db.query(sql`INSERT INTO project_members(project_id,email) VALUES(${projectId},${reader.userEmail})`);
  const shared = await documents.create(owner, { projectId, filename: "Shared.pdf", fileType: "pdf", bytes });
  const raw = objects.get.bind(objects);
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const reads = vi.spyOn(objects, "get").mockImplementation(async key => { const value = await raw(key); started(); await gate; return value; });
  const download = (scope = owner) => documents.download(scope, shared.id, null, { preferPdf: true, disposition: "inline", range: true });
  const pending = download(reader); await ready;
  await db.query(sql`DELETE FROM project_members WHERE project_id=${projectId}`);
  release(); expect(await pending).toBeNull();
  expect(await download()).toMatchObject({ kind: "bytes", content: { bytes } });
  expect(await download(reader)).toBeNull(); expect(reads).toHaveBeenCalledOnce();
});

it("revalidates expired snapshots rather than trusting a changed storage object forever", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  await get("bytes=0-10");
  vi.spyOn(objects, "get").mockResolvedValue(Buffer.from("corrupt"));
  clock.mockReturnValue(160001);
  await expect(documents.download(owner, id, null, { preferPdf: true, disposition: "inline", range: true }))
    .rejects.toThrow("integrity check");
});


it("keeps PDF ranges behind current access checks even when storage supports signed downloads", async () => {
  const signed = objects.signedGet = vi.fn(async () => "https://objects.example.test/verified");
  const ranged = await get("bytes=0-20");
  expect(ranged.status).toBe(206);
  expect(ranged.body).toEqual(bytes.subarray(0, 21));
  expect(signed).not.toHaveBeenCalled();
  const ordinary = await documents.download(owner, id, null, { preferPdf: true, disposition: "inline" });
  expect(ordinary).toEqual({ kind: "redirect", url: "https://objects.example.test/verified" });
  expect(signed).toHaveBeenCalledOnce();
  await documents.deleteDocument(owner, id);
  expect((await get("bytes=21-40")).status).toBe(404);
  expect(signed).toHaveBeenCalledOnce();
});
