import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationError } from "./applicationError";
import { createCourtRecordsApplication } from "./courtRecordsApplication";
import type { DocumentStore } from "./documentStore";
import type { WorkProduct, WorkProductBuildReceipt } from "./workProduct";
import { canonicalJsonSha256, sha256 } from "./hash";

const scope = { userId: "user-1" };

function documents(fileType = "pdf") {
  return {
    metadata: vi.fn(async (_scope, id: string) => ({
      id, current_version_id: id === "document-1" ? "version-1" : "authority-version",
      filename: id === "document-1" ? `document.${fileType}` : "Authorities.pdf",
      file_type: fileType, size_bytes: 20, page_count: 2,
      source_sha256: (id === "document-1" ? "a" : "d").repeat(64),
      updated_at: "2026-08-30T12:00:00.000Z",
    })),
    projectionSource: vi.fn(async (_scope, id: string, versionId: string | null) => ({
      documentId: id, versionId: versionId ?? (id === "document-1"
        ? "version-1" : "authority-version"), fileType,
      sourceSha256: (id === "document-1" ? "a" : "d").repeat(64),
      pdfProfile: { cacheKey: "b".repeat(64), profile: {}, status: "ready" as const },
      readBytes: async () => Buffer.from("%PDF-1.7"),
    })),
    addVersion: vi.fn(async (_scope, _id, file: { expectedSha256?: string }) => ({
      id: "version-2", working_revision: 0, source_sha256: file.expectedSha256,
      project_id: null, folder_id: null,
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
      current_working_revision: 0, source_sha256: file.expectedSha256,
      project_id: value.projectId, folder_id: "output-folder",
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
      workProducts as never, { lookupPdf: lookupPdf as never, preparePdf: vi.fn() as never });
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

  it("retains readable pages beside a blank page and accepts an entirely blank prepared PDF", async () => {
    const store = documents(), { files, workProducts } = dependencies();
    const lookupPdf = vi.fn(async (_bytes, query: { locator: string }) => query.locator === "1"
      ? { status: "found", pages: [{ page_number: 1, text: "Recognised affidavit" }] }
      : { status: "unavailable", error: "The requested structural unit has no exact text", pages: [] });
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never, { lookupPdf: lookupPdf as never, preparePdf: vi.fn() as never });
    await expect(application.preparedPageText(scope, "document-1", null)).resolves.toMatchObject({
      pages: [{ page_number: 1, text: "Recognised affidavit" }, { page_number: 2, text: "" }],
    });
    lookupPdf.mockImplementation(async () => ({ status: "unavailable",
      error: "The requested structural unit has no exact text", pages: [] }));
    await expect(application.preparedPageText(scope, "document-1", null)).resolves.toMatchObject({
      pages: [{ page_number: 1, text: "" }, { page_number: 2, text: "" }],
    });
    lookupPdf.mockImplementation(async () => ({ status: "unavailable",
      error: "PDF source bytes no longer match their version", pages: [] }));
    await expect(application.preparedPageText(scope, "document-1", null))
      .rejects.toMatchObject({ status: 409 });
  });

  it("does not route non-PDFs through a second conversion or parser", async () => {
    const lookupPdf = vi.fn(), { files, workProducts } = dependencies();
    const application = createCourtRecordsApplication(documents("docx"), files as never,
      workProducts as never, { lookupPdf: lookupPdf as never, preparePdf: vi.fn() as never });
    await expect(application.preparedPageText(scope, "document-1", null))
      .rejects.toMatchObject({ status: 409 });
    expect(lookupPdf).not.toHaveBeenCalled();
  });

  it("prepares only selected standalone PDF pages and returns their searchable text", async () => {
    const bytes = Buffer.from("%PDF-1.7\nscanned\n%%EOF"), digest = sha256(bytes);
    const preparePdf = vi.fn(async () => ({ sourceSha256: digest, pageCount: 2,
      projectionPageCount: 2, parserVersion: "legalpdf-test", cacheKey: "b".repeat(64),
      status: "ready" as const, pagesNeedingOcr: [], ocrRoutedPages: [1], profile: {} }));
    const lookupPdf = vi.fn(async () => ({ status: "found" as const, pages: [
      { page_number: 1, text: "Native first page" },
      { page_number: 2, text: "Recognized second page" },
    ] }));
    const { files, workProducts } = dependencies();
    const application = createCourtRecordsApplication(documents(), files as never,
      workProducts as never, { preparePdf: preparePdf as never, lookupPdf: lookupPdf as never });

    await expect(application.prepareUploadedPdf({ filename: "scan.pdf", fileType: "pdf", bytes },
      [2, 2])).resolves.toEqual({ source_sha256: digest, page_count: 2,
      parser_status: "ready", ocr_pages: [2], pages: [
        { page_number: 1, text: "Native first page" },
        { page_number: 2, text: "Recognized second page" },
      ] });
    expect(preparePdf).toHaveBeenCalledWith(expect.objectContaining({
      documentId: `court-record:${digest}`, versionId: `source:${digest}`,
      sourceSha256: digest, pages: [2], ocrProvider: "kraken-lite",
    }));
    expect(lookupPdf).toHaveBeenCalledWith(expect.any(Function), {
      locatorKind: "page", locator: "1-2", contextBlocks: 0,
    }, expect.objectContaining({ documentId: `court-record:${digest}`,
      versionId: `source:${digest}`, persistEvidence: false }));
  });

  it("rejects invalid and password-protected standalone PDFs", async () => {
    const encrypted = Object.assign(new Error(
      "PDF is password-protected. Remove its password, then upload it again."),
    { name: "PdfEncrypted" });
    const { files, workProducts } = dependencies();
    const application = createCourtRecordsApplication(documents(), files as never,
      workProducts as never, { preparePdf: vi.fn(async () => { throw encrypted; }) as never,
        lookupPdf: vi.fn() as never });
    await expect(application.prepareUploadedPdf({ filename: "bad.pdf", fileType: "pdf",
      bytes: Buffer.from("not a PDF") }, [1])).rejects.toMatchObject({ status: 400 });
    await expect(application.prepareUploadedPdf({ filename: "locked.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nlocked") }, [1])).rejects.toMatchObject({ status: 409,
        message: expect.stringContaining("password-protected") });
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

  it("saves a separate-file record with more than 32 document outputs", async () => {
    const { files, workProducts } = dependencies();
    const application = createCourtRecordsApplication(
      documents(), files as never, workProducts as never,
    );
    const artifacts = Array.from({ length: 33 }, (_, index) => {
      const filename = `Part ${index + 1}.pdf`;
      return { file: { filename, fileType: "pdf" as const,
        bytes: Buffer.from(`part-${index + 1}`) }, receipt: receipt({
        role: `entry-${index + 1}`, filename, sha256: index.toString(16).padStart(64, "0"),
      }) };
    });

    await expect(application.saveBuild(scope, artifacts)).resolves.toMatchObject({ revision: 4 });
    expect(files.create).toHaveBeenCalledTimes(33);
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

  it("replaces a deleted stable output and lets the WorkProduct CAS verify it", async () => {
    const store = documents() as DocumentStore & { addVersion: ReturnType<typeof vi.fn>;
      metadata: ReturnType<typeof vi.fn> };
    store.addVersion.mockResolvedValueOnce(null);
    store.metadata.mockResolvedValueOnce(null);
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
      current_working_revision: 0, source_sha256: "0".repeat(64),
      project_id: null, folder_id: "output-folder" });
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never);
    await expect(application.saveBuild(scope, [{ file: {
      filename: "Motion record.pdf", fileType: "pdf", bytes: Buffer.from("record"),
    }, receipt: receipt() }])).rejects.toThrow(/hash does not match/iu);
    expect(store.deleteDocument).toHaveBeenCalledWith(scope, "bad-output", true, {
      versionId: "bad-version", workingRevision: 0,
      projectId: null, folderId: "output-folder",
    });
    expect(workProducts.save).not.toHaveBeenCalled();
  });

  it("fills an empty Authorities slot from a live second-volume output", async () => {
    const record = product();
    record.state = { profileId: "ab-kb-chambers-justice-applicant-set",
      cover: { counselName: "Ada Lawyer" }, entries: [], bindings: {} };
    const child: WorkProduct = { ...product({ "book-2": { documentId: "authority-document",
      versionId: "authority-version", filename: "Authorities volume 2.pdf",
      mimeType: "application/pdf", sha256: "d".repeat(64), pageCount: 2 } }),
      id: "authorities-1", kind: "authorities", state: {} };
    const saved = { ...record, revision: 4 };
    const workProducts = { get: vi.fn(async (_scope, id: string) =>
      id === record.id ? record : child), save: vi.fn(async () => saved) };
    const application = createCourtRecordsApplication(documents(), { create: vi.fn() } as never,
      workProducts as never);
    await expect(application.bindOutput(scope, { courtRecordId: record.id, revision: 3,
      kindId: "authorities", childWorkProductId: child.id, role: "book-2" }))
      .resolves.toMatchObject({ product: saved, entryId: expect.any(String) });
    expect(workProducts.save).toHaveBeenCalledWith(scope, record.id, expect.objectContaining({
      revision: 3, state: expect.objectContaining({
        cover: { counselName: "Ada Lawyer" },
        entries: [expect.objectContaining({ kindId: "authorities",
          title: "Authorities volume 2", lastSeen: { name: "Authorities volume 2.pdf", size: 20,
            modified: Date.parse("2026-08-30T12:00:00.000Z"), sha256: "d".repeat(64) } })],
      }),
    }));
    const state = workProducts.save.mock.calls[0][2].state as { entries: Array<{ id: string }>;
      bindings: Record<string, unknown> };
    expect(state.bindings[state.entries[0].id]).toEqual({ kind: "work-product-output",
      workProductId: child.id, role: "book-2" });
    child.outputs["book-1"] = child.outputs["book-2"]!;
    await expect(application.bindOutput(scope, { courtRecordId: record.id, revision: 3,
      kindId: "authorities", childWorkProductId: child.id, role: "book-1" }))
      .rejects.toMatchObject({ status: 409 });
    expect(workProducts.save).toHaveBeenCalledOnce();
  });

  it("binds an affidavit package only into matching-court evidence slots", async () => {
    const record = product();
    record.state = { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} };
    const child: WorkProduct = { ...product({ record: { documentId: "affidavit-document",
      versionId: "authority-version", filename: "Affidavit.pdf", mimeType: "application/pdf",
      sha256: "d".repeat(64), pageCount: 2 } }), id: "affidavit-1",
      state: { profileId: "fc-affidavit-exhibits", cover: {}, entries: [], bindings: {} } };
    const saved = { ...record, revision: 4 };
    const workProducts = { get: vi.fn(async (_scope, id: string) =>
      id === record.id ? record : child), save: vi.fn(async () => saved) };
    const application = createCourtRecordsApplication(documents(), { create: vi.fn() } as never,
      workProducts as never);
    await expect(application.bindOutput(scope, { courtRecordId: record.id, revision: 3,
      kindId: "moving-evidence", childWorkProductId: child.id, role: "record" }))
      .resolves.toMatchObject({ product: saved, entryId: expect.any(String) });
    expect(workProducts.save).toHaveBeenCalledOnce();

    child.state = { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} };
    await expect(application.bindOutput(scope, { courtRecordId: record.id, revision: 3,
      kindId: "moving-evidence", childWorkProductId: child.id, role: "record" }))
      .rejects.toMatchObject({ status: 409 });
    expect(workProducts.save).toHaveBeenCalledOnce();
  });

  it("preserves a replaced slot's lawyer-authored fields and refuses missing child output", async () => {
    const existing = { id: "entry-1", kindId: "authorities", title: "My authorities",
      date: "August 30, 2026", lastSeen: { name: "old.pdf", size: 1, modified: 1 } };
    const record = product();
    record.state = { profileId: "ab-kb-chambers-justice-applicant-set",
      cover: {}, entries: [existing],
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
      replaceEntryId: "entry-1", description: "Generated authorities",
      date: "September 1, 2026" });
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

  it("fills empty cover and party fields and binds a described Library entry", async () => {
    const record = product(), sourceSha256 = "d".repeat(64);
    record.state = { profileId: "ab-kb-affidavit-exhibits",
      cover: { courtFileNumber: "2401-10000", registry: "", partyStyleId: "application",
        partyGroups: [{ id: "party-a", role: "Applicant", parties: [
          { id: "applicant-1", name: "Ada Applicant",
            contact: { name: "Typed Counsel" } },
        ] }] }, entries: [{
        id: "affidavit", kindId: "affidavit", title: "Affidavit",
        lastSeen: { name: "affidavit.pdf", size: 20, modified: 1, sha256: sourceSha256 },
        sourceExhibits: { sourceSha256, labels: ["A"] },
      }], bindings: { affidavit: { kind: "document", documentId: "affidavit-document",
        version: "latest" } } };
    const saved = { ...record, revision: 4 };
    const workProducts = { get: vi.fn(async () => record), save: vi.fn(async () => saved) };
    const application = createCourtRecordsApplication(documents(),
      { create: vi.fn() } as never, workProducts as never);
    const partyGroups = [{ id: "party-a", parties: [
      { id: "applicant-1", name: "Ada Applicant",
        contact: { name: "A. Counsel", phone: "555-0100" } },
      { id: "applicant-2", name: "Apex Ltd." },
    ] }, { id: "intervener", parties: [
      { id: "intervener-1", name: "Public Interest Group",
        contact: { name: "I. Counsel", email: "i@example.test" } },
    ] }];
    await expect(application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      cover: { courtFileNumber: "2401-99999", registry: "Calgary",
        partyStyleId: "application", partyGroups,
        filingPartyIds: ["applicant-1", "applicant-2"] },
      entry: { slotId: "exhibit", description: "Employment agreement",
        date: "August 30, 2026", exhibitLabel: "A",
        document: { documentId: "library-1", versionId: "authority-version" } } }))
      .resolves.toMatchObject({ product: saved,
        filled: ["registry", "partyGroups", "filingPartyIds"],
        entryId: expect.any(String) });
    const state = workProducts.save.mock.calls[0][2].state as {
      profileId: string; cover: Record<string, string>;
      entries: Array<{ id: string; kindId: string; title: string }>;
      bindings: Record<string, unknown>;
    };
    expect(state).toMatchObject({ profileId: "ab-kb-affidavit-exhibits",
      cover: { courtFileNumber: "2401-10000", registry: "Calgary",
        partyStyleId: "application", partyGroups: [
          { id: "party-a", role: "Applicant", parties: [
            { id: "applicant-1", name: "Ada Applicant",
              contact: { name: "Typed Counsel", phone: "555-0100" } },
            partyGroups[0].parties[1],
          ] },
          { id: "intervener", role: "Intervener", parties: partyGroups[1].parties },
        ], filingPartyIds: ["applicant-1", "applicant-2"] },
      entries: [{ kindId: "affidavit" }, { kindId: "exhibit", title: "Employment agreement",
        date: "August 30, 2026", exhibitLabel: "A" }] });
    expect(state.bindings[state.entries[1].id]).toEqual({ kind: "document",
      documentId: "library-1", version: "latest" });

    await expect(application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      entry: { slotId: "not-a-slot",
        document: { documentId: "library-1", versionId: "authority-version" } } }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("retains case fields extracted from a Library filing attached by the assistant", async () => {
    const record = product();
    record.state = { profileId: "fc-application-record-applicant",
      cover: {}, entries: [], bindings: {} };
    const workProducts = { get: vi.fn(async () => record),
      save: vi.fn(async (_scope, _id, patch) => ({ ...record, revision: 4, state: patch.state })) };
    const lookupPdf = vi.fn(async () => ({ status: "found" as const, pages: [
      { page_number: 1, text: ["Court File No. T-123-26", "FEDERAL COURT", "BETWEEN:",
        "Alpha Ltd.", "Applicant", "and", "Beta Ltd.", "Respondent"].join("\n") },
      { page_number: 2, text: "Notice of application" },
    ] }));
    const application = createCourtRecordsApplication(documents(), { create: vi.fn() } as never,
      workProducts as never, { lookupPdf: lookupPdf as never, preparePdf: vi.fn() as never });

    await application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      entry: { slotId: "notice-application",
        document: { documentId: "library-1", versionId: "authority-version" } } });

    expect(workProducts.save.mock.calls[0][2].state).toMatchObject({ entries: [{
      kindId: "notice-application",
      sourceFields: { cover: { courtFileNumber: "T-123-26" },
        exhibitLabels: [] },
    }] });
  });

  it("rejects invented, duplicate, and stale source exhibit labels", async () => {
    const sourceSha256 = "d".repeat(64);
    const sourceRecord = (labels: Array<string | undefined>, pinned = false) => {
      const record = product();
      record.state = { profileId: "ab-kb-affidavit-exhibits", cover: {}, entries: [{
        id: "affidavit", kindId: "affidavit", title: "Affidavit",
        lastSeen: { name: "affidavit.pdf", size: 20, modified: 1, sha256: sourceSha256 },
        sourceExhibits: { sourceSha256, labels: ["A"] },
      }, ...labels.map((exhibitLabel, index) => ({
        id: `exhibit-${index}`, kindId: "exhibit", title: `Exhibit ${index + 1}`,
        lastSeen: { name: `${index}.pdf`, size: 20, modified: 1, sha256: sourceSha256 },
        ...(exhibitLabel && { exhibitLabel }),
      }))], bindings: { affidavit: { kind: "document", documentId: "affidavit-document",
        version: pinned ? { versionId: "affidavit-version", sha256: sourceSha256 }
          : "latest" }, ...Object.fromEntries(labels.map((_, index) => [`exhibit-${index}`,
        { kind: "document", documentId: `exhibit-document-${index}`, version: "latest" }])) } };
      return record;
    };
    const change = (record: WorkProduct, exhibitLabel: string, store = documents()) => {
      const workProducts = { get: vi.fn(async () => record), save: vi.fn() };
      const application = createCourtRecordsApplication(store, { create: vi.fn() } as never,
        workProducts as never);
      const savedEntries = record.state.entries as unknown[];
      return application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
        entry: { slotId: "exhibit", replaceEntryId: `exhibit-${savedEntries.length - 2}`,
          exhibitLabel } });
    };

    await expect(change(sourceRecord([undefined]), "B")).rejects.toMatchObject({ status: 409 });
    await expect(change(sourceRecord(["A", undefined]), "A")).rejects.toMatchObject({ status: 409 });
    const staleLatest = documents() as DocumentStore & {
      projectionSource: ReturnType<typeof vi.fn> };
    staleLatest.projectionSource.mockResolvedValue({ documentId: "affidavit-document",
      versionId: "new-version", fileType: "pdf", sourceSha256: "e".repeat(64),
      readBytes: async () => Buffer.alloc(0) });
    await expect(change(sourceRecord([undefined]), "A", staleLatest))
      .rejects.toMatchObject({ status: 409 });
    await expect(change(sourceRecord([undefined], true), "A", staleLatest))
      .rejects.toMatchObject({ status: 409 });
  });

  it("clears source slots and assignments when the affidavit file is replaced", async () => {
    const sourceSha256 = "d".repeat(64), record = product();
    record.state = { profileId: "ab-kb-affidavit-exhibits", cover: {}, entries: [{
      id: "affidavit", kindId: "affidavit", title: "Affidavit",
      lastSeen: { name: "old.pdf", size: 20, modified: 1, sha256: sourceSha256 },
      sourceExhibits: { sourceSha256, labels: ["A"] },
    }, { id: "exhibit", kindId: "exhibit", title: "Contract", exhibitLabel: "A",
      lastSeen: { name: "contract.pdf", size: 20, modified: 1, sha256: sourceSha256 } }],
    bindings: {
      affidavit: { kind: "document", documentId: "old-affidavit", version: "latest" },
      exhibit: { kind: "document", documentId: "contract", version: "latest" },
    } };
    const workProducts = { get: vi.fn(async () => record),
      save: vi.fn(async (_scope, _id, patch) => ({ ...record, revision: 4, state: patch.state })) };
    const application = createCourtRecordsApplication(documents(), { create: vi.fn() } as never,
      workProducts as never);

    await application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      entry: { slotId: "affidavit", replaceEntryId: "affidavit",
        document: { documentId: "new-affidavit", versionId: "authority-version" } } });

    const state = workProducts.save.mock.calls[0][2].state as { entries: Array<Record<string, unknown>> };
    expect(state.entries).toEqual([
      expect.not.objectContaining({ sourceExhibits: expect.anything() }),
      expect.not.objectContaining({ exhibitLabel: expect.anything() }),
    ]);
  });

  it("adds a description-only entry and never creates a file binding for it", async () => {
    const record = product();
    record.state = { profileId: "fc-application-record-applicant",
      cover: {}, entries: [], bindings: {} };
    const saved = { ...record, revision: 4 };
    const workProducts = { get: vi.fn(async () => record), save: vi.fn(async () => saved) };
    const application = createCourtRecordsApplication(documents(),
      { create: vi.fn() } as never, workProducts as never);
    await expect(application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      entry: { slotId: "physical-exhibit",
        description: "Original scale model tendered before the tribunal" } }))
      .resolves.toMatchObject({ product: saved, entryId: expect.any(String) });
    expect(workProducts.save.mock.calls[0][2].state).toMatchObject({
      entries: [{ kindId: "physical-exhibit",
        title: "Original scale model tendered before the tribunal", descriptionOnly: true,
        lastSeen: { name: "description-only", size: 0, modified: 0 } }],
      bindings: {},
    });
  });

  it("uses a preparer's note when an Alberta appeal-record document is unavailable", async () => {
    const record = product();
    record.state = { profileId: "ab-ca-appeal-record", cover: {}, entries: [], bindings: {} };
    const saved = { ...record, revision: 4 };
    const workProducts = { get: vi.fn(async () => record), save: vi.fn(async () => saved) };
    const application = createCourtRecordsApplication(documents(),
      { create: vi.fn() } as never, workProducts as never);
    await expect(application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      entry: { slotId: "part-2-order" } })).resolves.toMatchObject({
        product: saved, entryId: expect.any(String),
      });
    expect(workProducts.save.mock.calls[0][2].state).toMatchObject({
      entries: [{ kindId: "part-2-order",
        title: "Formal order or decision was not available when this appeal record was prepared.",
        descriptionOnly: true }],
      bindings: {},
    });
  });

  it("does not turn an assistant-selected historical version into a latest binding", async () => {
    const record = product();
    record.state = { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} };
    const store = documents() as DocumentStore & { metadata: ReturnType<typeof vi.fn> };
    store.metadata.mockResolvedValue({ id: "library-1", current_version_id: "current-version",
      filename: "motion.pdf", file_type: "pdf", size_bytes: 21,
      source_sha256: "f".repeat(64), updated_at: "2026-08-30T12:00:00.000Z" });
    const { files } = dependencies(record);
    const workProducts = { get: vi.fn(async () => record), save: vi.fn() };
    const application = createCourtRecordsApplication(store, files as never,
      workProducts as never);
    await expect(application.updateDraft(scope, { courtRecordId: record.id, revision: 3,
      entry: { slotId: "notice-motion",
        document: { documentId: "library-1", versionId: "historical-version" } } }))
      .rejects.toMatchObject({ status: 409 });
    expect(workProducts.save).not.toHaveBeenCalled();
  });
});
