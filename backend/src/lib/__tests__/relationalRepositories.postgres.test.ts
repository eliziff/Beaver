import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relationalRepositoryContract } from "./support/relationalRepositoryContract";

const connection = process.env.SUPABASE_TEST_DB_URL;
const suite = connection ? describe : describe.skip;
const owner = { userId: randomUUID(), userEmail: `owner-${randomUUID()}@example.test` };
const users = new Map<string, string>();

async function provisionScopes(scopes: Array<{ userId: string; userEmail?: string }>) {
  const pending = scopes.filter(({ userId }) => !users.has(userId));
  if (!pending.length) return;
  const { relationalDatabase, sql } = await import("../relationalDatabase");
  const created = new Date().toISOString();
  await (await relationalDatabase()).query(sql`INSERT INTO auth.users
    (id,aud,role,email,created_at,updated_at) VALUES ${sql.join(pending.map((scope) =>
      sql`(${scope.userId},'authenticated','authenticated',${scope.userEmail ?? null},
        ${created},${created})`))} ON CONFLICT(id) DO NOTHING`);
  pending.forEach(({ userId, userEmail }) => users.set(userId, userEmail ?? ""));
}

suite("PostgreSQL relational repository contract", () => {
  beforeAll(async () => {
    process.env.AUTH_MODE = "cloud";
    process.env.DATABASE_URL = `${connection}${connection!.includes("?") ? "&" : "?"}sslmode=disable`;
    await provisionScopes([owner]);
  });
  afterAll(async () => {
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    try {
      if (users.size) await (await relationalDatabase()).query(sql`DELETE FROM auth.users
        WHERE id IN(${sql.join([...users.keys()])})`);
    } finally {
      await (await import("../relationalDatabase")).closeRelationalDatabase();
      delete process.env.DATABASE_URL;
    }
  });

  relationalRepositoryContract(provisionScopes);

  it("queues root and named-part blobs removed by an identity cascade", async () => {
    const [{ documentRepository }, { relationalDatabase, sql }] = await Promise.all([
      import("../relationalDocumentRepository"), import("../relationalDatabase"),
    ]);
    const deleted = { userId: randomUUID(),
      userEmail: `deleted-${randomUUID()}@example.test` };
    await provisionScopes([deleted]);
    const documentId = randomUUID(), versionId = randomUUID(), key = randomUUID(),
      partKey = randomUUID();
    const created = new Date().toISOString(), database = await relationalDatabase();
    try {
      await documentRepository.recordOrphans([key, partKey]);
      await expect(documentRepository.create(deleted, { document: { id: documentId,
        userId: deleted.userId, projectId: null, libraryKind: "file", folderId: null,
        status: "ready", currentVersionId: versionId, createdAt: created, updatedAt: created,
      }, version: { id: versionId, documentId, parentVersionId: null, versionNumber: 1,
        workingRevision: 0, source: "upload", createdBy: deleted.userId, comment: null,
        createdAt: created, filename: "record.md", fileType: "md", sizeBytes: 1,
        pageCount: null, sourceSha256: "a".repeat(64), blobKey: key, pdfBlobKey: null },
      parts: [{ documentId, versionId, name: "source.one.json", sizeBytes: 1,
        sha256: "b".repeat(64), blobKey: partKey }] })).resolves.toBe(true);
      await expect(database.query(sql`SELECT storage_path FROM object_cleanup
        WHERE storage_path IN(${key},${partKey})`)).resolves.toMatchObject({ rows: [] });
      await database.query(sql`DELETE FROM auth.users WHERE id=${deleted.userId}`);
      await expect(database.query(sql`SELECT storage_path FROM object_cleanup
        WHERE storage_path IN(${key},${partKey}) ORDER BY storage_path`)).resolves.toMatchObject({
        rows: [key, partKey].sort().map((storage_path) => ({ storage_path })) });
    } finally {
      await database.query(sql`DELETE FROM object_cleanup WHERE storage_path IN(${key},${partKey})`);
    }
  });

  it("deduplicates and atomically claims durable jobs across PostgreSQL workers", async () => {
    const queue = await import("../jobQueue"), handled = new Map<string, number>();
    const prefix = randomUUID();
    const jobs = await Promise.all(Array.from({ length: 20 }, (_, index) => queue.enqueueJob({
      kind: "test.postgres", dedupeKey: `${prefix}:${index}`, userId: owner.userId,
      payload: {}, priority: index,
    })));
    const duplicates = await Promise.all(Array.from({ length: 10 }, () => queue.enqueueJob({
      kind: "test.postgres", dedupeKey: `${prefix}:0`, userId: owner.userId, payload: {},
    })));
    const workers = Array.from({ length: 4 }, () => queue.startJobWorker({
      "test.postgres": async (job) => {
        handled.set(job.id, (handled.get(job.id) ?? 0) + 1);
        return {};
      },
    }));
    try {
      await Promise.all(jobs.map(async ({ id }) => {
        for (;;) {
          const job = await queue.getJob(id, owner.userId);
          if (job?.status === "succeeded") return;
          if (job?.status === "failed") throw new Error("Background job failed");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }));
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
    expect(new Set(duplicates.map(({ id }) => id))).toEqual(new Set([jobs[0].id]));
    expect([...handled.values()]).toEqual(Array(20).fill(1));
  });
});
