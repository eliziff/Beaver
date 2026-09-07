import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "beaver-text-access-"));
  vi.resetModules(); vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("MIKE_LOCAL_DATA_DIR", root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs(); vi.resetModules(); await rm(root, { recursive: true, force: true });
});

async function fixture(project = false) {
  const [{ createDocumentApplication }, { documentRepository }, { createFilesystemObjectStorage },
    { documentProjectionService }, { relationalDatabase, sql }] = await Promise.all([
    import("../documentApplication"), import("../relationalDocumentRepository"), import("../storage"),
    import("../documentProjectionService"), import("../relationalDatabase"),
  ]);
  const objects = createFilesystemObjectStorage(path.join(root, "objects"));
  const documents = createDocumentApplication(documentRepository, objects);
  const owner = { userId: randomUUID(), userEmail: "owner@example.test" };
  const reader = { userId: randomUUID(), userEmail: "reader@example.test" };
  const db = await relationalDatabase(), projectId = project ? randomUUID() : null;
  if (projectId) {
    await db.query(sql`INSERT INTO projects(id,user_id,name,created_at,updated_at)
      VALUES(${projectId},${owner.userId},'Matter','2026-01-01','2026-01-01')`);
    await db.query(sql`INSERT INTO project_members(project_id,email) VALUES(${projectId},${reader.userEmail})`);
  }
  const created = await documents.create(owner, { filename: "Memo.txt", fileType: "txt", projectId,
    bytes: Buffer.from("Verified original passage 😀") });
  const rawGet = objects.get.bind(objects), reads = vi.spyOn(objects, "get");
  const source = (scope = owner, versionId: string | null = null) =>
    documents.projectionSource(scope, created.id, versionId);
  return { objects, rawGet, documents, projection: documentProjectionService, owner, reader,
    created, source, reads, db, sql, projectId };
}

it("reauthorizes repeated repository reads without rereading the content-addressed blob", async () => {
  const f = await fixture();
  expect(await f.projection.text((await f.source())!)).toBe("Verified original passage 😀");
  const second = (await f.source())!;
  expect(await f.projection.text(second)).toBe("Verified original passage 😀");
  expect(f.reads).toHaveBeenCalledOnce();
  expect(await f.source(f.reader)).toBeNull();
  expect(await f.documents.deleteDocument(f.owner, f.created.id)).toBe(true);
  await expect(f.projection.text(second)).rejects.toMatchObject({ status: 404 });
});

it("rejects an old shared descriptor after revocation while the owner can still reuse the text", async () => {
  const f = await fixture(true), readerSource = (await f.source(f.reader))!;
  expect(readerSource).not.toBeNull();
  expect(await f.projection.text(readerSource)).toContain("Verified original");
  await f.db.query(f.sql`DELETE FROM project_members WHERE project_id=${f.projectId} AND email=${f.reader.userEmail}`);
  expect(await f.source(f.reader)).toBeNull();
  // Mutating the caller's scope does not escalate a captured descriptor's authority.
  f.reader.userId = f.owner.userId;
  await expect(f.projection.text(readerSource)).rejects.toMatchObject({ status: 404 });
  expect(await f.projection.text((await f.source())!)).toContain("Verified original");
  expect(f.reads).toHaveBeenCalledOnce();
});

it("detects in-place version replacement and serves only the new text from a fresh descriptor", async () => {
  const f = await fixture(), original = (await f.source())!;
  await f.projection.text(original);
  const changed = await f.documents.replaceVersion(f.owner, f.created.id, f.created.current_version_id,
    f.created.current_working_revision, { filename: "Memo.txt", fileType: "txt", bytes: Buffer.from("Revised passage") });
  expect(changed.status).toBe("replaced");
  await expect(f.projection.text(original)).rejects.toMatchObject({ status: 409 });
  const current = (await f.source())!;
  expect(current.versionId).toBe(original.versionId);
  expect(current.sourceSha256).not.toBe(original.sourceSha256);
  expect(await f.projection.text(current)).toBe("Revised passage");
});

it("keeps explicit historical versions separate after a new current version is published", async () => {
  const f = await fixture(), original = (await f.source())!;
  await f.projection.text(original);
  expect(await f.documents.addVersion(f.owner, f.created.id, {
    filename: "Memo.txt", fileType: "txt", bytes: Buffer.from("Version two"),
  })).not.toBeNull();
  expect(await f.projection.text((await f.source())!)).toBe("Version two");
  expect(await f.projection.text(original)).toBe("Verified original passage 😀");
  expect(await f.projection.text((await f.source(f.owner, original.versionId))!)).toBe("Verified original passage 😀");
});

it("rechecks authority after a shared load, including revocation during blob I/O", async () => {
  const f = await fixture(true), raw = f.rawGet;
  let deliver!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { deliver = resolve; });
  f.reads.mockImplementation(async key => { const bytes = await raw(key); started(); await held; return bytes; });
  const pending = f.projection.text((await f.source(f.reader))!);
  await began;
  await f.db.query(f.sql`DELETE FROM project_members WHERE project_id=${f.projectId} AND email=${f.reader.userEmail}`);
  deliver();
  await expect(pending).rejects.toMatchObject({ status: 404 });
  expect(await f.projection.text((await f.source())!)).toContain("Verified original");
  expect(f.reads).toHaveBeenCalledOnce();
});

it("does not retain corrupt source reads and retries after source recovery", async () => {
  const f = await fixture(), input = (await f.source())!;
  f.reads.mockResolvedValueOnce(Buffer.from("Corrupt storage"));
  await expect(f.projection.text(input)).rejects.toThrow("integrity check");
  expect(await f.projection.text(input)).toBe("Verified original passage 😀");
  expect(f.reads).toHaveBeenCalledTimes(2);
});

it("reuses text across separate real Grep tool turns without changing the matched passage", async () => {
  const f = await fixture();
  const { runLocalAssistantTools } = await import("./support/localAssistantTools");
  for (const pattern of ["Verified", "passage"]) {
    const [result] = await runLocalAssistantTools(f.owner.userId, [{ id: randomUUID(), name: "Grep",
      input: { pattern, path: `document://${f.created.id}/version/${f.created.current_version_id}`, output_mode: "content" } }],
    { documents: f.documents });
    expect(result.content).toContain("Verified original passage 😀");
  }
  expect(f.reads).toHaveBeenCalledOnce();
});
