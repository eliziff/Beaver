import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relationalRepositoryContract } from "./support/relationalRepositoryContract";

let directory = "";
const owner = { userId: randomUUID(), userEmail: "owner@example.test" };

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-repository-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
});
afterEach(async () => {
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

describe("SQLite relational repository contract", () => {
  relationalRepositoryContract();

  it("commits a PDF version and its preparation job in one transaction", async () => {
    const { documentRepository } = await import("../relationalRepositories");
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    const [{ createDocumentApplication }, { filesystemDocumentObjects }] = await Promise.all([
      import("../documentApplication"), import("../filesystemObjectStorage"),
    ]);
    const documentId = randomUUID(), versionId = randomUUID(), created = new Date().toISOString();
    await documentRepository.create(owner, { document: { id: documentId,
      userId: owner.userId, projectId: null, libraryKind: "file", folderId: null,
      status: "ready", currentVersionId: versionId, createdAt: created, updatedAt: created,
    }, version: { id: versionId, documentId, versionNumber: 1, source: "upload",
      createdAt: created, filename: "record.pdf", fileType: "pdf", sizeBytes: 4,
      pageCount: 1, sourceSha256: "a".repeat(64), blobKey: "record", pdfBlobKey: null,
      cleanupKeys: [] } });
    const committed = (await (await relationalDatabase()).query<{
      version_id: string; job_version_id: string;
    }>(sql`SELECT v.id version_id,j.document_version_id job_version_id
      FROM document_versions v JOIN application_jobs j ON j.document_version_id=v.id
      WHERE v.id=${versionId}`)).rows;
    expect(committed).toEqual([{ version_id: versionId, job_version_id: versionId }]);
    const documents = createDocumentApplication(documentRepository, filesystemDocumentObjects());
    const state = async () => (await documents.metadata(owner, documentId))?.parse_state;
    await expect(state()).resolves.toEqual({ status: "queued" });
    const database = await relationalDatabase();
    await database.query(sql`UPDATE application_jobs SET status='running',
      progress=${JSON.stringify({ phase: "ocr", pages: [5] })} WHERE document_version_id=${versionId}`);
    await expect(state()).resolves.toEqual({ status: "parsing", phase: "ocr", pages: [5] });
    await database.query(sql`UPDATE application_jobs SET status='succeeded',
      result=${JSON.stringify({ status: "ready" })} WHERE document_version_id=${versionId}`);
    await expect(state()).resolves.toEqual({ status: "ready", phase: "ocr", pages: [5] });
    await database.query(sql`UPDATE application_jobs SET status='failed'
      WHERE document_version_id=${versionId}`);
    await expect(state()).resolves.toEqual({
      status: "failed", phase: "ocr", pages: [5], error: "PDF processing failed",
    });
    await database.query(sql`UPDATE application_jobs SET status='cancelled'
      WHERE document_version_id=${versionId}`);
    await expect(state()).resolves.toEqual({
      status: "cancelled", phase: "ocr", pages: [5], error: "PDF processing was cancelled",
    });
  });
});
