import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory = "";
const owner = { userId: randomUUID(), userEmail: "owner@example.test" };
const member = { userId: randomUUID(), userEmail: "member@example.test" };
const stranger = { userId: randomUUID(), userEmail: "stranger@example.test" };

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

describe("shared relational repository", () => {
  it("applies the same explicit project, document, review, and chat scope", async () => {
    const repositories = await import("../relationalRepositories");
    const project = await repositories.projectRepository.create(owner, {
      name: "Matter", cmNumber: null, practice: null,
      sharedWith: [member.userEmail], metadata: {}, notes: null,
    });
    await expect(repositories.projectRepository.project(member, project.id, false))
      .resolves.toMatchObject({ id: project.id, is_owner: false });
    await expect(repositories.projectRepository.project(stranger, project.id, false))
      .resolves.toBeNull();

    const documentId = randomUUID(), versionId = randomUUID(), created = new Date().toISOString();
    await repositories.documentRepository.create(owner, { document: {
      id: documentId, userId: owner.userId, projectId: project.id, libraryKind: "file",
      folderId: null, status: "ready", currentVersionId: versionId,
      createdAt: created, updatedAt: created,
    }, version: { id: versionId, documentId, versionNumber: 1, source: "upload",
      createdAt: created, filename: "record.pdf", fileType: "pdf", sizeBytes: 4,
      pageCount: 1, sourceSha256: "a".repeat(64), blobKey: "record", pdfBlobKey: null,
      cleanupKeys: [] } });
    await expect(repositories.documentRepository.get(member, documentId))
      .resolves.toMatchObject({ document: { id: documentId }, isOwner: false });
    await expect(repositories.documentRepository.get(stranger, documentId)).resolves.toBeNull();

    const review = await repositories.tabularRepository.create(owner, {
      projectId: project.id, title: "Review", columns: [], documentIds: [documentId],
      workflowId: null, sharedWith: [member.userEmail],
    });
    expect(review.status).toBe("committed");
    const reviewId = review.status === "committed" ? review.value.id : "";
    await expect(repositories.tabularRepository.detail(member, reviewId))
      .resolves.toMatchObject({ review: { id: reviewId, is_owner: false } });
    await expect(repositories.tabularRepository.detail(stranger, reviewId)).resolves.toBeNull();

    const chats = repositories.chatRepository(owner), chat = await chats.create({
      projectId: project.id, tabularReviewId: null,
    });
    await chats.commit(chat.id, { kind: "turn", turn: { expectedVersion: 0,
      userMessage: { id: randomUUID(), content: "Question" } } });
    await expect(repositories.chatRepository(member).list({ projectId: project.id }))
      .resolves.toEqual([expect.objectContaining({ id: chat.id })]);
    await expect(repositories.chatRepository(stranger).read(chat.id)).resolves.toBeNull();
  });

  it("commits only one writer at a document revision", async () => {
    const { documentRepository } = await import("../relationalRepositories");
    const documentId = randomUUID(), firstId = randomUUID(), created = new Date().toISOString();
    await documentRepository.create(owner, { document: { id: documentId,
      userId: owner.userId, projectId: null, libraryKind: "file", folderId: null,
      status: "ready", currentVersionId: firstId, createdAt: created, updatedAt: created,
    }, version: { id: firstId, documentId, versionNumber: 1, source: "upload",
      createdAt: created, filename: "draft.docx", fileType: "docx", sizeBytes: 1,
      pageCount: null, sourceSha256: "a".repeat(64), blobKey: "first", pdfBlobKey: null,
      cleanupKeys: [] } });
    const version = (id: string, key: string) => ({ id, documentId, versionNumber: 2,
      source: "upload", createdAt: new Date().toISOString(), filename: "draft.docx",
      fileType: "docx", sizeBytes: 1, pageCount: null, sourceSha256: "b".repeat(64),
      blobKey: key, pdfBlobKey: null, cleanupKeys: [] });
    const result = await Promise.all([
      documentRepository.insertVersion(owner, documentId, {
        expectedCurrentVersionId: firstId, version: version(randomUUID(), "second") }),
      documentRepository.insertVersion(owner, documentId, {
        expectedCurrentVersionId: firstId, version: version(randomUUID(), "rival") }),
    ]);
    expect(result.sort()).toEqual(["conflict", "created"]);
    expect((await documentRepository.get(owner, documentId))?.versions).toHaveLength(2);
  });

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
