import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationError } from "./applicationError";
import { createCourtRecordsApplication } from "./courtRecordsApplication";
import type { DocumentStore } from "./documentStore";
import type { WorkProduct, WorkProductBuildReceipt } from "./workProduct";
import { canonicalJsonSha256 } from "./hash";

const scope = { userId: "user-1" };

function documents(fileType = "pdf") {
  return {
    metadata: vi.fn(async () => ({
      id: "document-1", current_version_id: "version-1", page_count: 2,
    })),
    projectionSource: vi.fn(async () => ({
      documentId: "document-1", versionId: "version-1", fileType,
      sourceSha256: "a".repeat(64),
      pdfProfile: { cacheKey: "b".repeat(64), profile: {}, status: "ready" as const },
      readBytes: async () => Buffer.from("%PDF-1.7"),
    })),
    addVersion: vi.fn(async (_scope, _id, file: { expectedSha256?: string }) => ({
      id: "version-2", source_sha256: file.expectedSha256,
    })),
    deleteDocument: vi.fn(async () => true),
    deleteVersion: vi.fn(async () => ({ status: "deleted" as const,
      currentVersionId: "version-1" })),
    versions: vi.fn(async () => ({ current_version_id: "authority-version",
      versions: [{ id: "authority-version", version_number: 1, source: "generated",
        created_at: "2026-08-30T12:00:00.000Z", filename: "Authorities.pdf",
        file_type: "pdf", size_bytes: 20, source_sha256: "d".repeat(64) }] })),
  } as unknown as DocumentStore;
}

function product(outputs: WorkProduct["outputs"] = {}): WorkProduct {
  return {
    id: "record-1", kind: "court-record", title: "Motion record", projectId: null,
    revision: 3, state: { profileId: "fc-motion-record-moving", bindings: {} }, outputs,
    createdAt: "2026-08-30T12:00:00.000Z", updatedAt: "2026-08-30T12:00:00.000Z",
  };
}

function receipt(output: Partial<WorkProductBuildReceipt["output"]> = {}): WorkProductBuildReceipt {
  return {
    schemaVersion: "beaver.work-product-build.v2", builtAt: "2026-08-30T12:00:00.000Z",
    workProduct: { id: "record-1", kind: "court-record", revision: 3 }, inputs: [],
    settings: { profileId: "fc-motion-record-moving", outputMode: "combined-record",
      stateSha256: canonicalJsonSha256(product().state),
      settingsSha256: "c".repeat(64),
      sourceReceiptIds: ["fc-rules"], audit: { effective: { from: "2025-12-21", to: null },
        valuesJson: "{}" } },
    steps: ["index"], output: { role: "record", filename: "Motion record.pdf",
      mimeType: "application/pdf", pageCount: 2, sha256: "b".repeat(64), ...output },
  };
}

function dependencies(value = product()) {
  return {
    files: { create: vi.fn(async (_scope, _workflow, file: { expectedSha256?: string }) => ({
      id: "output-1", current_version_id: "created-version",
      source_sha256: file.expectedSha256,
    })) },
    workProducts: { get: vi.fn(async () => value),
      save: vi.fn(async () => ({ ...value, revision: value.revision + 1 })) },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("court records application", () => {
  it("reads all prepared page text through the existing projection service", async () => {
    const store = documents(), { files, workProducts } = dependencies();
    const lookupPdf = vi.fn(async () => ({
      status: "found" as const,
      pages: [
        { page_number: 1, text: "First page" },
        { page_number: 2, text: "Second page" },
      ],
    }));
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never, { lookupPdf: lookupPdf as never });
    await expect(application.preparedPageText(scope, "document-1", null)).resolves.toEqual({
      document_id: "document-1", version_id: "version-1",
      source_sha256: "a".repeat(64), page_count: 2, parser_status: "ready",
      pages: [
        { page_number: 1, text: "First page" },
        { page_number: 2, text: "Second page" },
      ],
    });
    expect(lookupPdf).toHaveBeenCalledWith(expect.any(Function), {
      locatorKind: "page", locator: "1-2", contextBlocks: 0,
    }, expect.objectContaining({
      documentId: "document-1", versionId: "version-1", persistEvidence: false,
    }));
  });

  it("does not route non-PDFs through a second conversion or parser", async () => {
    const lookupPdf = vi.fn(), { files, workProducts } = dependencies();
    const application = createCourtRecordsApplication(documents("docx"), files as never,
      workProducts as never, { lookupPdf: lookupPdf as never });
    await expect(application.preparedPageText(scope, "document-1", null))
      .rejects.toMatchObject({ status: 409 });
    expect(lookupPdf).not.toHaveBeenCalled();
  });

  it("reuses the document converter for an ephemeral Word PDF rendition", async () => {
    const convert = vi.fn(async (bytes: Buffer) => Buffer.concat([
      Buffer.from("%PDF-1.7\n"), bytes,
    ]));
    const { files, workProducts } = dependencies();
    const application = createCourtRecordsApplication(
      documents(), files as never, workProducts as never, undefined, convert,
    );
    await expect(application.pdfRendition({
      filename: "record.docx", fileType: "docx", bytes: Buffer.from("word bytes"),
    })).resolves.toEqual(Buffer.from("%PDF-1.7\nword bytes"));
    expect(convert).toHaveBeenCalledOnce();
    await expect(application.pdfRendition({
      filename: "record.pdf", fileType: "pdf", bytes: Buffer.from("%PDF"),
    })).rejects.toMatchObject({ status: 400 });
  });

  it("contains a direct upload in its authorized Court draft project", async () => {
    const scoped = { ...product(), projectId: "project-1" };
    const { files, workProducts } = dependencies(scoped);
    const application = createCourtRecordsApplication(
      documents(), files as never, workProducts as never,
    );
    const file = { filename: "motion.pdf", fileType: "pdf" as const,
      bytes: Buffer.from("source") };
    await application.saveFile(scope, file, scoped.id);
    expect(workProducts.get).toHaveBeenCalledWith(scope, scoped.id);
    expect(files.create).toHaveBeenCalledWith(scope, "court-records", file,
      { projectId: "project-1" });
  });

  it("atomically saves a first build in the Court draft's project", async () => {
    const scoped = { ...product(), projectId: "project-1" };
    const { files, workProducts } = dependencies(scoped);
    const application = createCourtRecordsApplication(
      documents(), files as never, workProducts as never,
    );
    const built = receipt();
    await expect(application.saveBuild(scope, [{ file: {
      filename: "Motion record.pdf", fileType: "pdf", bytes: Buffer.from("record"),
    }, receipt: built }])).resolves.toMatchObject({ revision: 4 });
    expect(files.create).toHaveBeenCalledWith(scope, "court-records", expect.objectContaining({
      expectedSha256: "b".repeat(64),
      provenance: { schemaVersion: 1, actor: "work-product", action: "built",
        receipt: built },
    }), { projectId: "project-1" });
    expect(workProducts.save).toHaveBeenCalledWith(scope, scoped.id, {
      revision: 3, outputs: { record: {
        documentId: "output-1", versionId: "created-version",
      } },
    });
  });

  it("accepts the same exact Draft state regardless of object-key order", async () => {
    const reordered = { ...product(), state: {
      bindings: {}, profileId: "fc-motion-record-moving",
    } };
    const { files, workProducts } = dependencies(reordered);
    const application = createCourtRecordsApplication(
      documents(), files as never, workProducts as never,
    );
    await expect(application.saveBuild(scope, [{ file: {
      filename: "Motion record.pdf", fileType: "pdf", bytes: Buffer.from("record"),
    }, receipt: receipt() }])).resolves.toMatchObject({ revision: 4 });
  });

  it("rejects stale and open-ended receipts before writing", async () => {
    const { files, workProducts } = dependencies({ ...product(), revision: 4 });
    const application = createCourtRecordsApplication(
      documents(), files as never, workProducts as never,
    );
    const file = { filename: "Motion record.pdf", fileType: "pdf",
      bytes: Buffer.from("record") };
    await expect(application.saveBuild(scope, [{ file, receipt: receipt() }]))
      .rejects.toMatchObject({ status: 409 });
    await expect(application.saveBuild(scope, [{ file,
      receipt: { ...receipt(), extra: true } }]))
      .rejects.toMatchObject({ status: 400 });
    const indexReceipt = receipt({ role: "index", filename: "Index.pdf" });
    indexReceipt.settings.settingsSha256 = "d".repeat(64);
    await expect(application.saveBuild(scope, [{ file, receipt: receipt() }, { file: {
      filename: "Index.pdf", fileType: "pdf", bytes: Buffer.from("index"),
    }, receipt: indexReceipt }])).rejects.toMatchObject({ status: 400 });
    expect(files.create).not.toHaveBeenCalled();
  });

  it("rebuilds only the stable output document before committing the new ref", async () => {
    const store = documents();
    const outputs = { record: { documentId: "output-1", versionId: "old-version",
      filename: "Motion record.pdf", mimeType: "application/pdf",
      sha256: "c".repeat(64), pageCount: 2 } };
    const { files, workProducts } = dependencies(product(outputs));
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never);
    const file = { filename: "Motion record.pdf", fileType: "pdf",
      bytes: Buffer.from("record") };
    await expect(application.saveBuild(scope, [{ file, receipt: receipt() }]))
      .resolves.toMatchObject({ revision: 4 });
    expect(store.addVersion).toHaveBeenCalledWith(scope, "output-1",
      expect.objectContaining({ expectedSha256: "b".repeat(64) }));
    expect(workProducts.save).toHaveBeenCalledWith(scope, "record-1", {
      revision: 3, outputs: { record: {
        documentId: "output-1", versionId: "version-2",
      } },
    });
    expect(files.create).not.toHaveBeenCalled();
  });

  it("replaces a deleted stable output and lets the WorkProduct CAS verify it", async () => {
    const store = documents() as DocumentStore & { addVersion: ReturnType<typeof vi.fn> };
    store.addVersion.mockResolvedValueOnce(null);
    const outputs = { record: { documentId: "deleted-output", versionId: "old-version",
      filename: "Motion record.pdf", mimeType: "application/pdf",
      sha256: "a".repeat(64), pageCount: 2 } };
    const { files, workProducts } = dependencies(product(outputs));
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never);
    await application.saveBuild(scope, [{ file: { filename: "Motion record.pdf",
      fileType: "pdf", bytes: Buffer.from("record") }, receipt: receipt() }]);
    expect(files.create).toHaveBeenCalledWith(scope, "court-records", expect.anything(),
      { projectId: null });
    expect(workProducts.save).toHaveBeenCalledWith(scope, "record-1", {
      revision: 3, outputs: { record: {
        documentId: "output-1", versionId: "created-version",
      } },
    });
  });

  it("rolls back a first-build document whose persisted hash is not exact", async () => {
    const store = documents();
    const { files, workProducts } = dependencies();
    files.create.mockResolvedValueOnce({ id: "bad-output", current_version_id: "bad-version",
      source_sha256: "0".repeat(64) });
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never);
    await expect(application.saveBuild(scope, [{ file: {
      filename: "Motion record.pdf", fileType: "pdf", bytes: Buffer.from("record"),
    }, receipt: receipt() }])).rejects.toThrow(/hash does not match/iu);
    expect(store.deleteDocument).toHaveBeenCalledWith(scope, "bad-output");
    expect(workProducts.save).not.toHaveBeenCalled();
  });

  it("compensates all writes in reverse when a batch fails before CAS", async () => {
    const store = documents() as DocumentStore & {
      deleteDocument: ReturnType<typeof vi.fn>; deleteVersion: ReturnType<typeof vi.fn>;
    };
    const events: string[] = [];
    store.deleteDocument.mockImplementation(async (_scope: unknown, id: string) => {
      events.push(`document:${id}`); return true;
    });
    store.deleteVersion.mockImplementation(async (_scope: unknown, id: string,
      versionId: string) => {
      events.push(`version:${id}:${versionId}`);
      return { status: "deleted", currentVersionId: "version-1" };
    });
    const outputs = { record: { documentId: "stable-output", versionId: "old-version",
      filename: "Motion record.pdf", mimeType: "application/pdf",
      sha256: "a".repeat(64), pageCount: 2 } };
    const { files, workProducts } = dependencies(product(outputs));
    workProducts.save.mockRejectedValueOnce(new Error("stale CAS"));
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never);
    const second = receipt({ role: "index", filename: "Index.pdf", sha256: "d".repeat(64) });
    await expect(application.saveBuild(scope, [{ file: {
      filename: "Motion record.pdf", fileType: "pdf", bytes: Buffer.from("record"),
    }, receipt: receipt() }, { file: {
      filename: "Index.pdf", fileType: "pdf", bytes: Buffer.from("index"),
    }, receipt: second }])).rejects.toThrow("stale CAS");
    expect(events).toEqual(["document:output-1", "version:stable-output:version-2"]);
  });

  it("rolls a newly added stable version back when the output CAS is stale", async () => {
    const store = documents();
    const outputs = { record: { documentId: "stable-output", versionId: "old-version",
      filename: "Motion record.pdf", mimeType: "application/pdf",
      sha256: "a".repeat(64), pageCount: 2 } };
    const { files, workProducts } = dependencies(product(outputs));
    workProducts.save.mockRejectedValueOnce(new ApplicationError(409, "Draft changed"));
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never);
    await expect(application.saveBuild(scope, [{ file: {
      filename: "Motion record.pdf", fileType: "pdf", bytes: Buffer.from("record"),
    }, receipt: receipt() }])).rejects.toMatchObject({ status: 409 });
    expect(store.deleteVersion).toHaveBeenCalledWith(scope, "stable-output", "version-2");
  });

  it("fills an empty Authorities slot from a live named output without changing cover fields", async () => {
    const record = product();
    record.state = { profileId: "fc-motion-record-moving",
      cover: { counselName: "Ada Lawyer" }, entries: [], bindings: {} };
    const child: WorkProduct = { ...product({ book: { documentId: "authority-document",
      versionId: "authority-version", filename: "Authorities.pdf",
      mimeType: "application/pdf", sha256: "d".repeat(64), pageCount: 2 } }),
      id: "authorities-1", kind: "authorities", state: {} };
    const saved = { ...record, revision: 4 };
    const workProducts = { get: vi.fn(async (_scope, id: string) =>
      id === record.id ? record : child), save: vi.fn(async () => saved) };
    const application = createCourtRecordsApplication(documents(), { create: vi.fn() } as never,
      workProducts as never);
    await expect(application.bindOutput(scope, { courtRecordId: record.id, revision: 3,
      kindId: "authorities", childWorkProductId: child.id, role: "book" }))
      .resolves.toMatchObject({ product: saved, entryId: expect.any(String) });
    expect(workProducts.save).toHaveBeenCalledWith(scope, record.id, expect.objectContaining({
      revision: 3, state: expect.objectContaining({
        cover: { counselName: "Ada Lawyer" },
        entries: [expect.objectContaining({ kindId: "authorities",
          title: "Authorities", lastSeen: { name: "Authorities.pdf", size: 20,
            modified: Date.parse("2026-08-30T12:00:00.000Z"), sha256: "d".repeat(64) } })],
      }),
    }));
    const state = workProducts.save.mock.calls[0][2].state as { entries: Array<{ id: string }>;
      bindings: Record<string, unknown> };
    expect(state.bindings[state.entries[0].id]).toEqual({ kind: "work-product-output",
      workProductId: child.id, role: "book" });
  });

  it("preserves a replaced slot's lawyer-authored fields and refuses missing child output", async () => {
    const existing = { id: "entry-1", kindId: "authorities", title: "My authorities",
      date: "August 30, 2026", lastSeen: { name: "old.pdf", size: 1, modified: 1 } };
    const record = product();
    record.state = { profileId: "fc-motion-record-moving", cover: {}, entries: [existing],
      bindings: { "entry-1": { kind: "document", documentId: "old", version: "latest" } } };
    const child: WorkProduct = { ...product({ book: { documentId: "authority-document",
      versionId: "authority-version", filename: "Authorities.pdf",
      mimeType: "application/pdf", sha256: "d".repeat(64), pageCount: 2 } }),
      id: "authorities-1", kind: "authorities", state: {} };
    const workProducts = { get: vi.fn(async (_scope, id: string) =>
      id === record.id ? record : child), save: vi.fn(async () => ({ ...record, revision: 4 })) };
    const application = createCourtRecordsApplication(documents(), { create: vi.fn() } as never,
      workProducts as never);
    await application.bindOutput(scope, { courtRecordId: record.id, revision: 3,
      kindId: "authorities", childWorkProductId: child.id, role: "book",
      replaceEntryId: "entry-1" });
    expect(workProducts.save.mock.calls[0][2].state).toMatchObject({
      entries: [{ id: "entry-1", title: "My authorities", date: "August 30, 2026",
        lastSeen: { name: "Authorities.pdf", sha256: "d".repeat(64) } }],
      bindings: { "entry-1": { kind: "work-product-output",
        workProductId: "authorities-1", role: "book" } },
    });
    child.outputs = {};
    await expect(application.bindOutput(scope, { courtRecordId: record.id, revision: 3,
      kindId: "authorities", childWorkProductId: child.id, role: "book",
      replaceEntryId: "entry-1" })).rejects.toMatchObject({ status: 409 });
    child.outputs.book = { documentId: "authority-document",
      versionId: "authority-version", filename: "Authorities.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: "d".repeat(64), pageCount: 2 };
    await expect(application.bindOutput(scope, { courtRecordId: record.id, revision: 3,
      kindId: "authorities", childWorkProductId: child.id, role: "book",
      replaceEntryId: "entry-1" })).rejects.toMatchObject({ status: 409 });
    expect(workProducts.save).toHaveBeenCalledOnce();
  });

  it("selects a profile, fills only empty cover fields, and follows the current Library version", async () => {
    const record = product();
    record.state = { profileId: "general-court-record",
      cover: { courtFileNumber: "T-100-26", counselEmail: "" }, entries: [], bindings: {} };
    const saved = { ...record, revision: 4 };
    const workProducts = { get: vi.fn(async () => record), save: vi.fn(async () => saved) };
    const application = createCourtRecordsApplication(documents(),
      { create: vi.fn() } as never, workProducts as never);
    await expect(application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      profileId: "fc-motion-record-moving",
      cover: { courtFileNumber: "T-999-26", counselEmail: "ada@example.test" },
      document: { documentId: "library-1", versionId: "authority-version",
        slotId: "notice-motion" } })).resolves.toMatchObject({ product: saved,
      filled: ["counselEmail"], entryId: expect.any(String) });
    const state = workProducts.save.mock.calls[0][2].state as {
      profileId: string; cover: Record<string, string>;
      entries: Array<{ id: string; kindId: string; title: string }>;
      bindings: Record<string, unknown>;
    };
    expect(state).toMatchObject({ profileId: "fc-motion-record-moving",
      cover: { courtFileNumber: "T-100-26", counselEmail: "ada@example.test" },
      entries: [{ kindId: "notice-motion", title: "Notice of motion" }] });
    expect(state.bindings[state.entries[0].id]).toEqual({ kind: "document",
      documentId: "library-1", version: "latest" });

    await expect(application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      document: { documentId: "library-1", versionId: "authority-version",
        slotId: "not-a-slot" } })).rejects.toMatchObject({ status: 409 });
  });

  it("does not turn an assistant-selected historical version into a latest binding", async () => {
    const record = product();
    record.state = { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} };
    const store = documents() as DocumentStore & { versions: ReturnType<typeof vi.fn> };
    store.versions.mockResolvedValue({ current_version_id: "current-version", versions: [{
      id: "historical-version", version_number: 1, source: "upload",
      created_at: "2026-08-29T12:00:00.000Z", filename: "old-motion.pdf",
      file_type: "pdf", size_bytes: 20, source_sha256: "e".repeat(64),
    }, {
      id: "current-version", version_number: 2, source: "upload",
      created_at: "2026-08-30T12:00:00.000Z", filename: "motion.pdf",
      file_type: "pdf", size_bytes: 21, source_sha256: "f".repeat(64),
    }] });
    const { files } = dependencies(record);
    const workProducts = { get: vi.fn(async () => record), save: vi.fn() };
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never);
    await expect(application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      document: { documentId: "library-1", versionId: "historical-version",
        slotId: "notice-motion" } })).rejects.toMatchObject({ status: 409 });
    expect(workProducts.save).not.toHaveBeenCalled();
  });
});
