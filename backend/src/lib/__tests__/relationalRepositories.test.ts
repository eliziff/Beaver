import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../hash";
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
      result=${JSON.stringify({ status: "ready", pageCount: 3,
        pagesNeedingOcr: [], ocrRoutedPages: [] })}
      WHERE document_version_id=${versionId}`);
    await expect(state()).resolves.toEqual({ status: "ready", page_count: 3 });
    await database.query(sql`UPDATE application_jobs SET status='succeeded',
      result=${JSON.stringify({ status: "ready", pageCount: 3,
        pagesNeedingOcr: [], ocrRoutedPages: [0, 2] })}
      WHERE document_version_id=${versionId}`);
    await expect(state()).resolves.toEqual({
      status: "ready", phase: "ocr", pages: [1, 3], page_count: 3,
    });
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

  it("terminally flags a password-protected PDF with an actionable state", async () => {
    vi.doMock("../structureNative", () => ({ structureNative: () => ({
      preparePdfDocument: async () => { throw new Error("PDF extraction failed: PDF is encrypted"); },
    }) }));
    const [{ createDocumentApplication }, { documentRepository }, objects,
      queue, { pdfJobHandlers }, { relationalDatabase, sql }] = await Promise.all([
      import("../documentApplication"), import("../relationalDocumentRepository"),
      import("../filesystemObjectStorage"), import("../jobQueue"), import("../pdfJobs"),
      import("../relationalDatabase"),
    ]);
    const documents = createDocumentApplication(documentRepository,
      objects.filesystemDocumentObjects());
    const worker = queue.startJobWorker(pdfJobHandlers(documents));
    try {
      const document = await documents.create(owner, {
        filename: "locked.pdf", fileType: "pdf", bytes: Buffer.from("%PDF-1.7\nlocked"),
      });
      await vi.waitFor(async () => expect((await documents.metadata(owner, document.id))?.parse_state)
        .toEqual({ status: "failed", phase: "extracting", pages: [],
          error: "PDF is password-protected. Remove its password, then upload it again." }),
      { timeout: 3_000, interval: 10 });
      await expect((await relationalDatabase()).query(sql`SELECT attempts,last_error FROM
        application_jobs WHERE document_id=${document.id}`)).resolves.toMatchObject({
        rows: [{ attempts: 1, last_error: "PdfEncrypted" }],
      });
    } finally { await worker.stop(); }
  });

  it("preserves selective and all-page OCR routing through the PDF worker", async () => {
    vi.doMock("../structureNative", () => ({ structureNative: () => ({
      preparePdfDocument: async (bytes: Buffer) => {
        const full = bytes.includes(Buffer.from("full"));
        const pages = full ? [0, 1, 2] : [1, 3];
        return { sha256: sha256(bytes), parserVersion: "test", status: "ready",
          cacheKey: sha256(Buffer.concat([bytes, Buffer.from("cache")])),
          pageCount: full ? 3 : 4, projectionPageCount: full ? 3 : 4,
          pagesNeedingOcr: pages, ocrRoutedPages: pages };
      },
    }) }));
    const [{ createDocumentApplication }, { documentRepository }, objects,
      queue, { pdfJobHandlers }] = await Promise.all([
      import("../documentApplication"), import("../relationalDocumentRepository"),
      import("../filesystemObjectStorage"), import("../jobQueue"), import("../pdfJobs"),
    ]);
    const documents = createDocumentApplication(documentRepository,
      objects.filesystemDocumentObjects());
    const worker = queue.startJobWorker(pdfJobHandlers(documents));
    try {
      const selective = await documents.create(owner, { filename: "selective.pdf",
        fileType: "pdf", bytes: Buffer.from("%PDF-1.7\nselective") });
      const full = await documents.create(owner, { filename: "full.pdf",
        fileType: "pdf", bytes: Buffer.from("%PDF-1.7\nfull") });
      await vi.waitFor(async () => {
        await expect(documents.parseStates(owner, [selective.id, full.id])).resolves.toEqual(
          expect.arrayContaining([
            { id: selective.id, parse_state: { status: "ready", phase: "ocr",
              pages: [2, 4], page_count: 4 }, page_count: 4 },
            { id: full.id, parse_state: { status: "ready", phase: "ocr",
              pages: [1, 2, 3], page_count: 3 }, page_count: 3 },
          ]));
      }, { timeout: 3_000, interval: 10 });
    } finally { await worker.stop(); }
  });
});
