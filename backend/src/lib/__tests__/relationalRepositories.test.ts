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

  it("stores assistant history as ordered rows instead of rewriting one JSON blob", async () => {
    const { chatRepository } = await import("../relationalChatRepository");
    const { relationalDatabase, sql } = await import("../relationalDatabase");
    const repository = chatRepository(owner), assistantId = randomUUID();
    const chat = await repository.create({ projectId: null, tabularReviewId: null });
    await repository.commit(chat.id, { kind: "turn", turn: {
      expectedVersion: 0,
      assistantMessage: { id: assistantId, content: [
        { type: "tool_activity", id: "read-1", status: "running" },
      ], citations: [{ kind: "url", url: "https://example.test/one" }] },
    } });
    await repository.commit(chat.id, { kind: "turn", turn: {
      expectedVersion: 1,
      assistantMessage: { id: assistantId, content: [
        { type: "tool_activity", id: "read-1", status: "completed" },
        { type: "content_final", text: "Done" },
      ], citations: [{ kind: "url", url: "https://example.test/one" }] },
    } });
    await repository.commit(chat.id, { kind: "append", messageId: assistantId,
      event: { type: "compaction", status: "completed" } });

    const database = await relationalDatabase();
    await expect(database.query<{ content: unknown }>(sql`SELECT content FROM chat_messages
      WHERE id=${assistantId}`)).resolves.toMatchObject({ rows: [{ content: "[]" }] });
    await expect(database.query<{ count: number }>(sql`SELECT COUNT(*) count
      FROM chat_message_events WHERE message_id=${assistantId}`)).resolves.toMatchObject({
      rows: [{ count: 3 }],
    });
    await expect(repository.read(chat.id, true)).resolves.toMatchObject({
      messages: [{ content: [
        { type: "tool_activity", id: "read-1", status: "completed" },
        { type: "content_final", text: "Done" },
        { type: "compaction", status: "completed" },
      ], citations: [{ kind: "url", url: "https://example.test/one" }] }],
    });
  });

  it("commits a PDF version and its preparation job in one transaction", async () => {
    const { documentRepository } = await import("../relationalDocumentRepository");
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
