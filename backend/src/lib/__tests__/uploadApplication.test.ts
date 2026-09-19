import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUploadApplication } from "../uploadApplication";
import { createDocumentApplication } from "../documentApplication";
import { documentRepository } from "../relationalDocumentRepository";
import { createFilesystemObjectStorage } from "../storage";
import { relationalDatabase, closeRelationalDatabase, sql } from "../relationalDatabase";
import { sha256 } from "../hash";
import { createOrganizationApplication } from "../organizationApplication";
import type { ApplicationJob } from "../jobQueue";
import express from "express";
import request from "supertest";

let directory: string, app: ReturnType<typeof createUploadApplication>;
let objects: ReturnType<typeof createFilesystemObjectStorage>, documents: ReturnType<typeof createDocumentApplication>;
const owner = { userId: randomUUID(), userEmail: "owner@example.test" }, other = { userId: randomUUID(), userEmail: "other@example.test" };
const bytes = Buffer.from("A durable upload."), input = () => ({ client_key: randomUUID(), filename: "record.txt",
  source_sha256: sha256(bytes), size_bytes: bytes.length });
const context = { signal: new AbortController().signal, progress: async () => {}, checkpoint: async () => {} };
const job = (id: string, userId = owner.userId) => ({ userId, payload: { sessionId: id } }) as ApplicationJob;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-uploads-"));
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
  vi.stubEnv("LOCAL_USER_ID", owner.userId);
  objects = createFilesystemObjectStorage(path.join(directory, "objects"));
  documents = createDocumentApplication(documentRepository, objects);
  app = createUploadApplication(await relationalDatabase(), objects, documentRepository, documents);
});
afterEach(async () => { vi.restoreAllMocks(); await closeRelationalDatabase(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
async function receive(id: string) {
  const filename = path.join(directory, "upload.txt"); await writeFile(filename, bytes);
  await app.receive(owner, id, { path: filename, sizeBytes: bytes.length });
}
it("resumes the same session and publishes exactly one document across duplicate workers", async () => {
  const fields = input(), first = await app.start(owner, fields);
  expect((await app.start(owner, fields)).id).toBe(first.id);
  expect(await app.transfer(owner, first.id)).toEqual({ kind: "proxy" });
  await receive(first.id); await app.complete(owner, first.id); await app.complete(owner, first.id);
  await Promise.all([app.handlers["upload-document"](job(first.id), context), app.handlers["upload-document"](job(first.id), context)]);
  const finished = await app.get(owner, first.id);
  expect(finished).toMatchObject({ status: "complete", document: { filename: "record.txt", source_sha256: sha256(bytes) } });
  expect((await (await relationalDatabase()).query(sql`SELECT id FROM documents`)).rows).toHaveLength(1);
  expect((await app.complete(owner, first.id)).document?.id).toBe(finished.document?.id);
  await expect(app.get(other, first.id)).rejects.toMatchObject({ status: 404 });
  await expect(app.start(owner, { ...fields, filename: "changed.txt" })).rejects.toMatchObject({ status: 409 });
});
it("rejects corrupt direct-upload bytes before publishing a document", async () => {
  const first = await app.start(owner, input()), db = await relationalDatabase();
  const key = String((await db.query(sql`SELECT storage_path FROM upload_sessions WHERE id=${first.id}`)).rows[0].storage_path);
  const corrupt = Buffer.alloc(bytes.length, 42);
  await objects.put(key, corrupt, "text/plain", { expectedSha256: sha256(corrupt) });
  await app.complete(owner, first.id); await app.handlers["upload-document"](job(first.id), context);
  expect(await app.get(owner, first.id)).toMatchObject({ status: "failed", document: null });
  expect((await db.query(sql`SELECT id FROM documents`)).rows).toEqual([]);
});
it("fences cancellation while document preparation is in flight", async () => {
  const first = await app.start(owner, input()); await receive(first.id); await app.complete(owner, first.id);
  const create = documents.create.bind(documents);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(documents, "create").mockImplementation(async (...args) => { entered(); await gate; return create(...args); });
  const running = app.handlers["upload-document"](job(first.id), context);
  await ready; await app.cancel(owner, first.id); release(); await running;
  expect(await app.get(owner, first.id)).toMatchObject({ status: "cancelled", document: null });
  expect((await (await relationalDatabase()).query(sql`SELECT id FROM documents`)).rows).toEqual([]);
});
it("rechecks destination permissions when queued uploads publish", async () => {
  const db = await relationalDatabase(), projectId = randomUUID(), access = createOrganizationApplication(db);
  await db.query(sql`INSERT INTO projects(id,user_id,name,created_at,updated_at) VALUES(${projectId},${other.userId},'Matter','now','now')`);
  await access.grant(other, "project", projectId, owner.userEmail, "editor");
  const first = await app.start(owner, { ...input(), project_id: projectId });
  await receive(first.id); await app.complete(owner, first.id);
  await access.grant(other, "project", projectId, owner.userEmail, null);
  await app.handlers["upload-document"](job(first.id), context);
  expect((await db.query(sql`SELECT id FROM documents`)).rows).toEqual([]);
  await expect(app.get(owner, first.id)).rejects.toMatchObject({ status: 404 });
});
it("keeps active uploads out of blob cleanup and removes abandoned bytes after expiry", async () => {
  const first = await app.start(owner, input()); await receive(first.id);
  const db = await relationalDatabase();
  await db.query(sql`UPDATE object_cleanup SET created_at='2000-01-01T00:00:00.000Z'`);
  expect(await documentRepository.pendingOrphans()).toEqual([]);
  await db.query(sql`UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=${first.id}`);
  const [orphan] = await documentRepository.pendingOrphans(); expect(orphan).toBeDefined();
  expect(await documentRepository.removeOrphan(orphan.key, orphan.claimId, () => objects.remove(orphan.key))).toBe(true);
  expect(await objects.get(orphan.key)).toBeNull();
  await expect(app.complete(owner, first.id)).rejects.toMatchObject({ status: 410 });
});
it("runs the local HTTP session lifecycle with strict metadata and multipart staging", async () => {
  const { createUploadsRouter } = await import("../../routes/uploads");
  const api = express(); api.use(express.json()); api.use("/uploads", createUploadsRouter(app));
  expect((await request(api).post("/uploads").send({ ...input(), user_id: other.userId })).status).toBe(400);
  const created = await request(api).post("/uploads").send(input());
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await request(api).post(`/uploads/${id}/transfer`)).body).toEqual({ kind: "proxy" });
  expect((await request(api).post(`/uploads/${id}/content`).attach("file", bytes, "record.txt")).status).toBe(200);
  expect((await request(api).post(`/uploads/${id}/complete`)).status).toBe(202);
  await app.handlers["upload-document"](job(id), context);
  const finished = await request(api).get(`/uploads/${id}`);
  expect(finished.body).toMatchObject({ status: "complete", document: { filename: "record.txt" } });
  expect(JSON.stringify(finished.body)).not.toContain("storage_path");
});

it.each(["version_create", "version_replace"])("durably publishes %s once despite duplicate workers and a lost response", async (purpose) => {
  const initial = await documents.create(owner, { filename: "old.txt", fileType: "txt", bytes: Buffer.from("Before") });
  const fields = { ...input(), purpose, target_document_id: initial.id,
    expected_version_id: initial.current_version_id, expected_working_revision: initial.current_working_revision };
  const session = await app.start(owner, fields);
  await receive(session.id); await app.complete(owner, session.id);
  await Promise.all([app.handlers["upload-document"](job(session.id), context), app.handlers["upload-document"](job(session.id), context)]);
  const finished = await app.start(owner, fields);
  expect(finished).toMatchObject({ id: session.id, status: "complete", document: { id: initial.id, source_sha256: sha256(bytes) },
    version: { working_revision: purpose === "version_create" ? 0 : 1 } });
  expect((await documents.versions(owner, initial.id))?.versions).toHaveLength(purpose === "version_create" ? 2 : 1);
  expect((await app.complete(owner, session.id)).version?.id).toBe(finished.version?.id);
  await expect(app.start(other, { ...fields, client_key: randomUUID() })).rejects.toMatchObject({ status: 404 });
});

it.each(["version_create", "version_replace"])("does not overwrite intervening edits during %s", async (purpose) => {
  const initial = await documents.create(owner, { filename: "old.txt", fileType: "txt", bytes: Buffer.from("Before") });
  const session = await app.start(owner, { ...input(), purpose, target_document_id: initial.id,
    expected_version_id: initial.current_version_id, expected_working_revision: initial.current_working_revision });
  await receive(session.id); await app.complete(owner, session.id);
  const edited = Buffer.from("Keep my edits");
  await documents.replaceVersion(owner, initial.id, initial.current_version_id, initial.current_working_revision,
    { filename: "old.txt", fileType: "txt", bytes: edited });
  await app.handlers["upload-document"](job(session.id), context);
  expect(await app.get(owner, session.id)).toMatchObject({ status: "failed", document: null });
  expect((await documents.metadata(owner, initial.id))?.source_sha256).toBe(sha256(edited));
  expect((await documents.versions(owner, initial.id))?.versions).toHaveLength(1);
});

it("fences cancelled version publication after preparation starts", async () => {
  const initial = await documents.create(owner, { filename: "old.txt", fileType: "txt", bytes: Buffer.from("Before") });
  const session = await app.start(owner, { ...input(), purpose: "version_create", target_document_id: initial.id,
    expected_version_id: initial.current_version_id, expected_working_revision: initial.current_working_revision });
  await receive(session.id); await app.complete(owner, session.id);
  const add = documents.addVersion.bind(documents);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(documents, "addVersion").mockImplementation(async (...args) => { entered(); await gate; return add(...args); });
  const running = app.handlers["upload-document"](job(session.id), context);
  await ready; await app.cancel(owner, session.id); release(); await running;
  expect(await app.get(owner, session.id)).toMatchObject({ status: "cancelled", document: null });
  expect((await documents.versions(owner, initial.id))?.versions).toHaveLength(1);
});
