import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connection = process.env.SUPABASE_TEST_DB_URL;
const suite = connection ? describe : describe.skip;
const owner = { userId: randomUUID(), userEmail: `owner-${randomUUID()}@example.test` };
const member = { userId: randomUUID(), userEmail: `member-${randomUUID()}@example.test` };
let projectId = "", documentId = "";

suite("PostgreSQL relational repository contract", () => {
  beforeAll(() => {
    process.env.AUTH_MODE = "cloud";
    process.env.DATABASE_URL = `${connection}${connection!.includes("?") ? "&" : "?"}sslmode=disable`;
  });
  afterAll(async () => {
    const repositories = await import("../relationalRepositories");
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    await (await relationalDatabase()).query(
      sql`DELETE FROM application_jobs WHERE user_id=${owner.userId}`,
    );
    if (documentId) await repositories.documentRepository.deleteDocument(owner, documentId);
    if (projectId) await repositories.projectRepository.remove(owner, projectId);
    await (await import("../relationalDatabase")).closeRelationalDatabase();
    delete process.env.DATABASE_URL;
  });

  it("shares scoped aggregates and atomically rejects a stale writer", async () => {
    const repositories = await import("../relationalRepositories");
    const project = await repositories.projectRepository.create(owner, {
      name: "PostgreSQL contract", cmNumber: null, practice: null,
      sharedWith: [member.userEmail], metadata: {}, notes: null,
    });
    projectId = project.id;
    await expect(repositories.projectRepository.project(member, project.id, false))
      .resolves.toMatchObject({ id: project.id, is_owner: false });

    documentId = randomUUID();
    const first = randomUUID(), created = new Date().toISOString();
    await repositories.documentRepository.create(owner, { document: { id: documentId,
      userId: owner.userId, projectId, libraryKind: "file", folderId: null,
      status: "ready", currentVersionId: first, createdAt: created, updatedAt: created,
    }, version: { id: first, documentId, versionNumber: 1, source: "upload",
      createdAt: created, filename: "record.pdf", fileType: "pdf", sizeBytes: 1,
      pageCount: 1, sourceSha256: "a".repeat(64), blobKey: "first", pdfBlobKey: null,
      cleanupKeys: [] } });
    await expect(repositories.documentRepository.get(member, documentId))
      .resolves.toMatchObject({ document: { id: documentId }, isOwner: false });

    const version = (key: string) => ({ id: randomUUID(), documentId, versionNumber: 2,
      source: "upload", createdAt: new Date().toISOString(), filename: "record.pdf",
      fileType: "pdf", sizeBytes: 1, pageCount: 1, sourceSha256: "b".repeat(64),
      blobKey: key, pdfBlobKey: null, cleanupKeys: [] });
    const results = await Promise.all([
      repositories.documentRepository.insertVersion(owner, documentId,
        { expectedCurrentVersionId: first, version: version("second") }),
      repositories.documentRepository.insertVersion(owner, documentId,
        { expectedCurrentVersionId: first, version: version("rival") }),
    ]);
    expect(results.sort()).toEqual(["conflict", "created"]);
    expect((await repositories.documentRepository.get(owner, documentId))?.versions).toHaveLength(2);
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    const jobs = (await (await relationalDatabase()).query<{ document_version_id: string }>(
      sql`SELECT document_version_id FROM application_jobs WHERE document_id=${documentId}`,
    )).rows;
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map(({ document_version_id }) => document_version_id)).size).toBe(2);
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
    queue.wakeJobWorker();
    try {
      await Promise.all(jobs.map(({ id }) => queue.waitForJob(id, owner.userId)));
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
    expect(new Set(duplicates.map(({ id }) => id))).toEqual(new Set([jobs[0].id]));
    expect([...handled.values()]).toEqual(Array(20).fill(1));
  });
});
