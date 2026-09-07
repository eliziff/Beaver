import { verifiedDownloadCache } from "./verifiedDownloadCache";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { docxToPdf } from "./convert";
import type { DocumentAggregate, DocumentRepository,
  StoredDocumentPart, StoredDocumentVersion, StoredPartChanges } from "./documentRepository";
import { contentTypeForDocumentType, isSpreadsheetDocumentType, shouldConvertToPdf,
  validateDocumentFile } from "./documentTypes";
import type { DocumentFile, DocumentPartFile, DocumentPartsChange, DocumentProvenance,
  DocumentRecord, DocumentScope, DocumentSpreadsheet, DocumentStore, DocumentVersion,
  StoredAssistantEdit } from "./documentStore";
import { ApplicationError } from "./applicationError";
import { extractTrackedChangeIds, resolveTrackedChange } from "./docxTrackedChanges";
import { compareDocxVersions } from "./docxCompareVersions";
import { MAX_DRAFTING_DOCX_BYTES } from "./docx/core";
import { sha256 } from "./hash";
import { normalizeDocumentMetadata, normalizeDocumentNotes,
  type LibraryKind } from "./normalize";
import { documentBlobDigest, documentBlobKey, MAX_OBJECT_SIZE_BYTES, normalizeDownloadFilename,
  SIGNED_GET_TTL_SECONDS, type ObjectStorage } from "./storage";
import { assertBoundedZip, loadZip } from "./zip";
import { pdfLifecyclePhase } from "./pdfLifecycleDiagnostics";
import { documentProjectionService } from "./documentProjectionService";
import { spreadsheetToLLMStructure } from "./spreadsheet";

const projectionReference = (documentId: string, version: StoredDocumentVersion) => ({
  documentId, versionId: version.id, sourceSha256: version.sourceSha256,
});
async function availableEvidence<T>(load: () => Promise<T>) {
  try { return await load(); }
  catch { throw new ApplicationError(410, "Evidence is no longer available"); }
}

const safeFilename = (value: string) => {
  if (!value.trim()) throw new ApplicationError(400, "filename is required");
  return normalizeDownloadFilename(value);
};
const safeComment = (value?: string | null) => {
  const comment = value?.trim() || null;
  if (comment && comment.length > 1_000)
    throw new ApplicationError(400, "Version comment is too long");
  return comment;
};
const safePartName = (value: string) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,199}$/iu.test(value) ||
      value.split("/").some((part) => part === "." || part === ".." || !part))
    throw new ApplicationError(400, "Invalid document part name");
  return value;
};

const ARCHIVE_TYPES = new Set(["docx", "xlsx", "xlsm", "pptx"]);
const inspectUpload = async (input: DocumentFile) => {
  if ("bytes" in input) {
    if (input.bytes.byteLength > MAX_OBJECT_SIZE_BYTES)
      throw new ApplicationError(413, "Document exceeds the maximum object size");
    return { head: input.bytes, sizeBytes: input.bytes.byteLength,
      sourceSha256: sha256(input.bytes) };
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 ||
      input.sizeBytes > MAX_OBJECT_SIZE_BYTES)
    throw new ApplicationError(413, "Document exceeds the maximum object size");
  const hash = createHash("sha256"), chunks: Buffer[] = [];
  let headBytes = 0, sizeBytes = 0;
  for await (const chunk of createReadStream(input.path)) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > MAX_OBJECT_SIZE_BYTES)
      throw new ApplicationError(413, "Document exceeds the maximum object size");
    hash.update(chunk);
    if (headBytes < 1_024) {
      const part = chunk.subarray(0, 1_024 - headBytes);
      chunks.push(part); headBytes += part.byteLength;
    }
  }
  if (sizeBytes !== input.sizeBytes) throw new Error("Uploaded file size changed while reading");
  return { head: Buffer.concat(chunks), sizeBytes, sourceSha256: hash.digest("hex") };
};

let archiveValidation = Promise.resolve();
async function validateArchive(input: DocumentFile) {
  const previous = archiveValidation;
  let release!: () => void;
  archiveValidation = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const zip = await loadZip("bytes" in input ? input.bytes : await readFile(input.path));
    assertBoundedZip(zip, "Office document", {
      maxEntries: 4_096, maxExpandedBytes: 256 * 1024 * 1024,
      selected: { test: /\.xml(?:\.rels)?$/iu, maxEntryBytes: 64 * 1024 * 1024,
        maxBytes: 128 * 1024 * 1024, name: "XML part" },
    });
  } finally { release(); }
}

const validateUpload = async (input: DocumentFile) => {
  const { filename, fileType } = input, inspected = await inspectUpload(input);
  if (input.expectedSha256 && input.expectedSha256 !== inspected.sourceSha256) {
    throw new ApplicationError(409, "The uploaded file does not match its build receipt");
  }
  const name = safeFilename(filename);
  const validated = validateDocumentFile(name, inspected.head, inspected.sizeBytes);
  if (!validated.ok || validated.fileType !== fileType.toLowerCase()) {
    throw new ApplicationError(400,
      validated.ok ? "Filename and document type do not match" : validated.error);
  }
  if (ARCHIVE_TYPES.has(validated.fileType)) {
    try {
      await validateArchive(input);
    } catch {
      throw new ApplicationError(400,
        "Office document archive is invalid or exceeds extraction limits");
    }
  }
  return { filename: name, fileType: validated.fileType, ...inspected };
};

const responseVersion = (version: StoredDocumentVersion): DocumentVersion => ({
  id: version.id, version_number: version.versionNumber,
  working_revision: version.workingRevision, source: version.source,
  created_by: version.createdBy, author_email: version.authorEmail,
  comment: version.comment,
  parent_version_id: version.parentVersionId,
  created_at: version.createdAt, filename: version.filename, file_type: version.fileType,
  size_bytes: version.sizeBytes, page_count: version.pageCount,
  source_sha256: version.sourceSha256,
  provenance: version.provenance?.actor === "work-product"
    ? { schema_version: version.provenance.schemaVersion, actor: version.provenance.actor,
      action: version.provenance.action, receipt: { workProduct: {
        kind: version.provenance.receipt.workProduct.kind } } }
    : version.provenance ? { schema_version: version.provenance.schemaVersion,
      actor: version.provenance.actor, action: version.provenance.action,
      change_count: version.provenance.changeCount } : undefined,
});

const responseDocument = (aggregate: Pick<DocumentAggregate, "document" | "versions">): DocumentRecord => {
  const version = activeVersion(aggregate);
  if (!version) throw new Error("Document has no active version");
  const document = aggregate.document;
  return {
    id: document.id, user_id: document.userId, project_id: document.projectId,
    library_kind: document.libraryKind,
    library_folder_id: document.projectId ? null : document.folderId,
    folder_id: document.folderId, filename: version.filename, file_type: version.fileType,
    size_bytes: version.sizeBytes,
    page_count: version.pageCount ?? document.parseState?.page_count ?? null,
    source_sha256: version.sourceSha256, status: document.status,
    current_version_id: document.currentVersionId,
    active_version_number: version.versionNumber, created_at: document.createdAt,
    updated_at: document.updatedAt, metadata: document.metadata ?? {},
    notes: document.notes ?? null, parse_state: document.parseState ?? null,
    current_working_revision: version.workingRevision,
  };
};

function activeVersion(aggregate: Pick<DocumentAggregate, "document" | "versions">,
  requested?: string | null) {
  const id = requested || aggregate.document.currentVersionId;
  return aggregate.versions.find((version) => version.id === id) ?? null;
}

function editedFilename(version: StoredDocumentVersion) {
  const name = version.filename.trim() || "Untitled document.docx";
  if (version.source !== "assistant_edit" || !version.versionNumber) return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name} [Edited V${version.versionNumber}]${
    dot > 0 ? name.slice(dot) : ""
  }`;
}

function revisedProvenance(value: DocumentProvenance | undefined, added: number, turnId?: string,
  continuing = false) {
  const previous = value?.actor === "assistant" ? value : undefined;
  return { ...previous, schemaVersion: 1 as const, actor: "assistant" as const,
    action: continuing ? previous?.action ?? "revised" : "revised" as const,
    turnId: turnId ?? (continuing ? previous?.turnId : undefined),
    changeCount: (continuing ? previous?.changeCount ?? 0 : 0) + added,
    ...(previous?.generation && { generation: { ...previous.generation,
      authorityLedger: undefined } }) };
}

async function mapBounded<T, R>(input: readonly T[], fn: (value: T, index: number) => Promise<R>) {
  const output = new Array<R>(input.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, input.length) }, async () => {
    while (next < input.length) {
      const index = next++;
      output[index] = await fn(input[index], index);
    }
  }));
  return output;
}

export function createDocumentApplication(repository: DocumentRepository,
  objects: ObjectStorage): DocumentStore {
  const writeBlob = async (key: string,
    body: Parameters<ObjectStorage["put"]>[1], type: string, digest: string) => {
    if (await repository.recordOrphans([key]) === "busy")
      throw new ApplicationError(503, "Document storage is busy; retry shortly");
    await objects.put(key, body, type, { expectedSha256: digest });
  };
  const stageParts = async (documentId: string,
    owner: { userId: string; projectId: string | null }, versionId: string,
    input: DocumentPartFile[] = []): Promise<StoredDocumentPart[]> => {
    const names = input.map(({ name }) => safePartName(name));
    if (new Set(names).size !== names.length)
      throw new ApplicationError(400, "Document part names must be unique");
    const output = input.map((part, index) => {
      if (!Buffer.isBuffer(part.bytes) || part.bytes.byteLength > MAX_OBJECT_SIZE_BYTES)
        throw new ApplicationError(413, "Document part exceeds the maximum object size");
      const digest = sha256(part.bytes);
      if (part.expectedSha256 && part.expectedSha256 !== digest)
        throw new ApplicationError(409, "Document part does not match its build receipt");
      return { documentId, versionId, name: names[index], sizeBytes: part.bytes.byteLength,
        sha256: digest, blobKey: documentBlobKey(owner, digest) };
    });
    const uploads = [...new Map(output.map((part, index) =>
      [part.blobKey, { part, bytes: input[index].bytes }] as const)).values()];
    if (uploads.length && await repository.recordOrphans(
      uploads.map(({ part }) => part.blobKey)) === "busy")
      throw new ApplicationError(503, "Document storage is busy; retry shortly");
    await mapBounded(uploads, ({ part, bytes }) =>
      objects.put(part.blobKey, bytes, "application/octet-stream",
        { expectedSha256: part.sha256 }));
    return output;
  };
  const stageChanges = async (documentId: string, owner: {
    userId: string; projectId: string | null }, versionId: string,
    input?: DocumentPartsChange): Promise<StoredPartChanges | undefined> => {
    if (!input) return undefined;
    const remove = (input.remove ?? []).map(safePartName),
      putNames = (input.put ?? []).map(({ name }) => safePartName(name));
    if (new Set(remove).size !== remove.length ||
        putNames.some((name) => remove.includes(name)))
      throw new ApplicationError(400, "Document part changes must be unambiguous");
    const put = await stageParts(documentId, owner, versionId, input.put);
    return { put, remove };
  };

  const makeVersion = async (input: { scope: DocumentScope; documentId: string;
    versionNumber: number; source: string; filename: string;
    ownerUserId: string; projectId: string | null; parentVersionId: string | null;
    provenance?: DocumentProvenance;
    comment?: string | null; } & DocumentFile) => {
    const id = randomUUID();
    const { filename, fileType, sizeBytes, sourceSha256 } = await validateUpload(input);
    const blobKey = documentBlobKey({ userId: input.ownerUserId,
      projectId: input.projectId }, sourceSha256);
    const version: StoredDocumentVersion = {
      id, documentId: input.documentId, parentVersionId: input.parentVersionId,
      versionNumber: input.versionNumber, workingRevision: 0,
      source: input.source, createdBy: input.scope.userId,
      ...(input.scope.userEmail ? { authorEmail: input.scope.userEmail } : {}),
      comment: safeComment(input.comment), createdAt: new Date().toISOString(), filename, fileType,
      sizeBytes,
      pageCount: null,
      sourceSha256, blobKey, pdfBlobKey: fileType === "pdf" ? blobKey : null,
      provenance: input.provenance,
    };
    await pdfLifecyclePhase("upload.blob_write", input.documentId, () =>
      writeBlob(blobKey,
        "bytes" in input ? input.bytes : { path: input.path, sizeBytes },
        contentTypeForDocumentType(fileType), sourceSha256));
    return version;
  };

  const ensurePdf = async (scope: DocumentScope,
    aggregate: Pick<DocumentAggregate, "document" | "versions">,
    version: StoredDocumentVersion) => {
    if (version.pdfBlobKey || !shouldConvertToPdf(version.fileType)) return version;
    const source = await checkedBytes(version);
    if (!source) return version;
    let pdf: Buffer;
    try {
      pdf = await docxToPdf(source);
    } catch (error) {
      console.error("[document-display] Office to PDF conversion failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return version;
    }
    const digest = sha256(pdf);
    const key = documentBlobKey(aggregate.document, digest);
    await writeBlob(key, pdf, "application/pdf", digest);
    const updated = await repository.updateVersion(scope, aggregate.document.id, {
      versionId: version.id,
      expectedBlobKey: version.blobKey,
      expectedPdfBlobKey: version.pdfBlobKey,
      expectedWorkingRevision: version.workingRevision,
      bumpWorkingRevision: false,
      update: { pdfBlobKey: key },
    });
    if (updated !== "updated") {
      return await repository.version(scope, aggregate.document.id, version.id) ?? version;
    }
    return { ...version, pdfBlobKey: key };
  };

  const selectedVersion = async (scope: DocumentScope,
    aggregate: Pick<DocumentAggregate, "document" | "versions">,
    requested: string | null, preferPdf: boolean) => {
    const selected = activeVersion(aggregate, requested);
    if (!selected) return null;
    const version = preferPdf ? await ensurePdf(scope, aggregate, selected) : selected;
    const usePdf = preferPdf && !!version.pdfBlobKey && shouldConvertToPdf(version.fileType);
    return { version, key: usePdf ? version.pdfBlobKey! : version.blobKey,
      fileType: usePdf ? "pdf" : version.fileType, filename: editedFilename(version) };
  };

  const retainedDownloads = verifiedDownloadCache();

  const checkedBlob = async (key: string, digest: string, sizeBytes?: number) => {
    if (documentBlobDigest(key) !== digest)
      throw new Error("Stored document failed its integrity check");
    const bytes = await objects.get(key);
    if (bytes && (sha256(bytes) !== digest || sizeBytes !== undefined &&
        bytes.byteLength !== sizeBytes))
      throw new Error("Stored document failed its integrity check");
    return bytes;
  };
  const blobsAvailable = async (version: StoredDocumentVersion,
    parts: StoredDocumentPart[] = []) => !(await mapBounded([
      { blobKey: version.blobKey, sha256: version.sourceSha256,
        sizeBytes: version.sizeBytes },
      ...(version.pdfBlobKey && version.pdfBlobKey !== version.blobKey ? [{
        blobKey: version.pdfBlobKey, sha256: documentBlobDigest(version.pdfBlobKey) ?? "",
        sizeBytes: undefined,
      }] : []),
      ...parts,
    ], async ({ blobKey, sha256: digest, sizeBytes }) =>
      !(await checkedBlob(blobKey, digest, sizeBytes)))).some(Boolean);
  const checkedBytes = (version: StoredDocumentVersion, key = version.blobKey) =>
    checkedBlob(key, key === version.blobKey ? version.sourceSha256 : documentBlobDigest(key) ?? "");

  const loadVersion = async (version: StoredDocumentVersion, key = version.blobKey,
    fileType = version.fileType, filename = editedFilename(version)) => {
    const bytes = await checkedBytes(version, key);
    return bytes && { bytes, version: responseVersion(version), filename, fileType,
      hasPdfRendition: !!version.pdfBlobKey,
      ...(version.pdfProfile ? { pdfProfile: version.pdfProfile } : {}) };
  };

  const select = async (scope: DocumentScope, documentId: string,
    requested: string | null, preferPdf: boolean) => {
    if (!preferPdf) return repository.version(scope, documentId, requested).then((version) =>
      version && { version, key: version.blobKey, fileType: version.fileType,
        filename: editedFilename(version) });
    const [aggregate, version] = await Promise.all([
      repository.head(scope, documentId),
      requested ? repository.version(scope, documentId, requested) : Promise.resolve(null),
    ]);
    return aggregate && selectedVersion(scope,
      requested ? { ...aggregate, versions: version ? [version] : [] } : aggregate,
      requested, true);
  };

  const add = async (scope: DocumentScope,
    aggregate: Pick<DocumentAggregate, "document" | "versions">,
    file: DocumentFile & { comment?: string | null; parts?: DocumentPartsChange }, input?: {
      source?: string; provenance?: DocumentProvenance; edits?: StoredAssistantEdit[] }) => {
    const current = activeVersion(aggregate);
    if (!current) return null;
    const version = await makeVersion({ scope, documentId: aggregate.document.id,
      versionNumber: current.versionNumber + 1,
      ownerUserId: aggregate.document.userId, projectId: aggregate.document.projectId,
      parentVersionId: current.id,
      source: input?.source ?? "user_upload",
      provenance: input?.provenance, ...file,
    });
    const parts = await stageChanges(aggregate.document.id, aggregate.document,
      version.id, file.parts);
    const result = await repository.insertVersion(scope, aggregate.document.id, {
      expectedCurrentVersionId: current.id,
      expectedCurrentWorkingRevision: current.workingRevision,
      expectedProjectId: aggregate.document.projectId,
      expectedFolderId: aggregate.document.folderId,
      version, edits: input?.edits, clonePartsFromVersionId: current.id, parts });
    return result === "created" ? version : null;
  };

  const replace = async (scope: DocumentScope, documentId: string,
    owner: Readonly<{ userId: string; projectId: string | null }>,
    current: StoredDocumentVersion, input: DocumentFile & {
      pageCount: number | null;
      provenance?: DocumentProvenance | null; createdAt?: string; edits?: StoredAssistantEdit[];
      resolveEdits?: { ids: string[]; status: StoredAssistantEdit["status"] };
      parts?: DocumentPartsChange;
    }) => {
    const { filename, fileType, sizeBytes, sourceSha256 } = await validateUpload(input);
    const key = documentBlobKey(owner, sourceSha256);
    await writeBlob(key,
      "bytes" in input ? input.bytes : { path: input.path, sizeBytes },
      contentTypeForDocumentType(fileType), sourceSha256);
    const parts = await stageChanges(documentId, owner, current.id, input.parts);
    const next: StoredDocumentVersion = { ...current, filename,
      workingRevision: current.workingRevision + 1,
      fileType, sizeBytes, pageCount: input.pageCount,
      sourceSha256, blobKey: key, pdfBlobKey: fileType === "pdf" ? key : null,
      provenance: input.provenance === null
        ? undefined : input.provenance ?? current.provenance,
      createdAt: input.createdAt ?? current.createdAt };
    const result = await repository.updateVersion(scope, documentId, {
      versionId: current.id, expectedBlobKey: current.blobKey,
      expectedWorkingRevision: current.workingRevision,
      expectedCurrentVersionId: current.id,
      update: { filename: next.filename, fileType: next.fileType,
        sizeBytes: next.sizeBytes, pageCount: next.pageCount,
        sourceSha256, blobKey: key, pdfBlobKey: next.pdfBlobKey,
        provenance: input.provenance,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}) },
      edits: input.edits, resolveEdits: input.resolveEdits,
      parts,
    });
    return result === "updated" ? next : null;
  };

  const application: DocumentStore = {
    async resumeCleanup() {
      let removed = 0, batches = 0;
      while (true) {
        const pending = await repository.pendingOrphans(4);
        if (!pending.length) break;
        await Promise.all(pending.map(async ({ key, claimId }) => {
          try {
            if (await repository.removeOrphan(key, claimId, () => objects.remove(key))) removed++;
          } catch (error) {
            console.error("[document-cleanup] orphan retry failed", {
              key, error: error instanceof Error ? error.name : "unknown",
            });
          }
        }));
        if (++batches % 10 === 0)
          console.info("[document-cleanup] removing orphan objects", { count: removed });
      }
      if (removed) console.info("[document-cleanup] removed orphan objects", { count: removed });
    },

    async metadata(scope, documentId, owner = false) {
      const aggregate = await repository.head(scope, documentId, owner);
      return aggregate ? responseDocument(aggregate) : null;
    },

    async metadataMany(scope, documentIds, owner = false) {
      const ids = [...new Set(documentIds)], found = new Map<string, ReturnType<typeof responseDocument>>();
      for (let start = 0; start < ids.length; start += 200) {
        for (const head of await repository.heads(scope, ids.slice(start, start + 200), owner))
          found.set(head.document.id, responseDocument(head));
      }
      return ids.flatMap((id) => found.get(id) ?? []);
    },

    async parseStates(scope, ids) {
      return (await repository.parseStates(scope, ids)).map(({ id, parseState }) =>
        ({ id, parse_state: parseState, page_count: parseState?.page_count ?? null }));
    },

    async create(scope, input) {
      const libraryKind = (input.libraryKind ?? "file") as LibraryKind,
        projectId = input.projectId ?? null, folderId = input.folderId ?? null;
      const authorization = await repository.authorizeCreate(
        scope, { projectId, libraryKind, folderId });
      if (authorization !== "ok") {
        throw new ApplicationError(404,
          authorization === "project-missing" ? "Project not found" : "Folder not found");
      }
      const documentId = randomUUID();
      const version = await makeVersion({ ...input, scope, documentId, versionNumber: 1,
        ownerUserId: scope.userId, projectId, parentVersionId: null,
        source: input.provenance?.actor === "work-product" ||
          input.provenance?.action === "created" ? "generated" : "upload",
      });
      const now = version.createdAt, document = {
        id: documentId, userId: scope.userId, projectId, libraryKind, folderId,
        status: "ready", currentVersionId: version.id, createdAt: now, updatedAt: now,
        metadata: {}, notes: null,
        parseState: version.fileType === "pdf" ? { status: "queued" as const } : null,
      };
      const parts = await stageParts(documentId, document, version.id, input.parts);
      const created = await pdfLifecyclePhase("upload.repository", documentId, () =>
        repository.create(scope, { document, version, parts,
          ...(input.pdfOcrProvider !== undefined ? { pdfOcrProvider: input.pdfOcrProvider } : {}) }));
      if (!created) throw new ApplicationError(409, "Document location changed during upload");
      return responseDocument({ document, versions: [version] });
    },

    async deleteDocument(scope, documentId, owner = true, expected) {
      return repository.deleteDocument(scope, documentId, owner, expected);
    },

    async deleteUserDocuments(scope, input) {
      return repository.deleteDocuments(scope, input.projectIds, input.includeOwned);
    },

    async relocate(scope, documentId, input) {
      let versions: Parameters<DocumentRepository["relocate"]>[2]["versions"] = [],
        parts: Parameters<DocumentRepository["relocate"]>[2]["parts"] = [];
      if (input.projectId !== input.expectedProjectId) {
        const aggregate = await repository.head(scope, documentId, input.owner);
        if (!aggregate) return { status: "missing" as const };
        if (aggregate.document.projectId !== input.expectedProjectId ||
            aggregate.document.folderId !== input.expectedFolderId)
          return { status: "conflict" as const };
        const [authorization, history] = await Promise.all([
          repository.authorizeCreate(scope, { projectId: input.projectId,
            libraryKind: aggregate.document.libraryKind, folderId: input.folderId }),
          repository.history(scope, documentId, true),
        ]);
        if (authorization !== "ok" || !history) return { status: "missing" as const };
        const target = { userId: aggregate.document.userId, projectId: input.projectId };
        const copies = new Map<string, { source: string; digest: string; type: string }>();
        versions = history.versions.map((version) => {
          const pdfDigest = version.pdfBlobKey && documentBlobDigest(version.pdfBlobKey);
          if (version.pdfBlobKey && !pdfDigest)
            throw new Error("Stored document failed its integrity check");
          const blobKey = documentBlobKey(target, version.sourceSha256);
          const pdfBlobKey = pdfDigest ? documentBlobKey(target, pdfDigest) : null;
          copies.set(blobKey, { source: version.blobKey,
            digest: version.sourceSha256, type: contentTypeForDocumentType(version.fileType) });
          if (version.pdfBlobKey && pdfBlobKey) copies.set(pdfBlobKey, {
            source: version.pdfBlobKey, digest: pdfDigest!,
            type: "application/pdf",
          });
          return { versionId: version.id, expectedBlobKey: version.blobKey, blobKey,
            expectedPdfBlobKey: version.pdfBlobKey, pdfBlobKey };
        });
        parts = (history.parts ?? []).map((part) => {
          const blobKey = documentBlobKey(target, part.sha256);
          copies.set(blobKey, { source: part.blobKey, digest: part.sha256,
            type: "application/octet-stream" });
          return { versionId: part.versionId, name: part.name,
            expectedBlobKey: part.blobKey, blobKey };
        });
        const pending = [...copies];
        if (pending.length && await repository.recordOrphans(
          pending.map(([key]) => key)) === "busy")
          throw new ApplicationError(503, "Document storage is busy; retry shortly");
        await mapBounded(pending, async ([key, copy]) => {
          const bytes = await checkedBlob(copy.source, copy.digest);
          if (!bytes) throw new Error("Stored document is unavailable");
          await objects.put(key, bytes, copy.type, { expectedSha256: copy.digest });
        });
      }
      const result = await repository.relocate(scope, documentId, { ...input, versions, parts });
      return typeof result === "string" ? { status: result }
        : { status: "moved", document: responseDocument(result) };
    },

    async updateMetadata(scope, documentId, input) {
      if (!await repository.updateMetadata(scope, documentId, {
        ...(input.metadata !== undefined
          ? { metadata: normalizeDocumentMetadata(input.metadata) } : {}),
        ...(input.notes !== undefined
          ? { notes: normalizeDocumentNotes(input.notes) } : {}),
      })) return null;
      const aggregate = await repository.head(scope, documentId, true);
      return aggregate ? responseDocument(aggregate) : null;
    },

    async files(scope, documentIds, maxBytes) {
      const ids = [...new Set(documentIds)], byId = new Map(
        (await repository.currentVersions(scope, ids)).map((version) => [version.documentId, version]));
      const versions = ids.flatMap((id) => byId.get(id) ?? []);
      if (maxBytes !== undefined && versions.reduce((bytes, version) =>
        bytes + version.sizeBytes, 0) > maxBytes)
        throw new ApplicationError(413, "Selected documents exceed the archive size limit");
      const loaded = await mapBounded(versions, (version) => loadVersion(version));
      return loaded.flatMap((value) => value ? [value] : []);
    },

    async read(scope, documentId, versionId, preferPdf) {
      const selected = await select(scope, documentId, versionId, preferPdf);
      return selected
        ? loadVersion(selected.version, selected.key, selected.fileType, selected.filename)
        : null;
    },

    async readParts(scope, documentId, versionId, names) {
      const requested = [...new Set(names.map(safePartName))];
      if (requested.length > 100)
        throw new ApplicationError(413, "Too many document parts requested");
      const parts = await repository.parts(scope, documentId, versionId, requested);
      if (!parts) return null;
      if (parts.reduce((bytes, part) => bytes + part.sizeBytes, 0) > MAX_OBJECT_SIZE_BYTES)
        throw new ApplicationError(413, "Selected document parts exceed the size limit");
      const loaded = new Map(await mapBounded(parts, async (part) => {
        const bytes = await checkedBlob(part.blobKey, part.sha256, part.sizeBytes);
        if (!bytes) throw new Error("Stored document part is unavailable");
        return [part.name, { name: part.name, bytes, sha256: part.sha256 }] as const;
      }));
      return requested.flatMap((name) => loaded.get(name) ?? []);
    },

    recordPdfPreparation(scope, documentId, input) {
      return repository.recordPdfPreparation(scope, documentId, input);
    },

    async projectionSource(scope, documentId, versionId) {
      const stored = await repository.version(scope, documentId, versionId);
      if (!stored) return null;
      const version = { ...stored };
      const readerScope = { ...scope };
      return {
        documentId,
        versionId: version.id,
        fileType: version.fileType,
        sourceSha256: version.sourceSha256,
        ...(version.pdfProfile ? { pdfProfile: version.pdfProfile } : {}),
        ...(version.provenance ? { provenance: version.provenance } : {}),
        assertAvailable: async () => {
          const current = await repository.version(readerScope, documentId, version.id);
          if (!current) throw new ApplicationError(404, "Document source is unavailable");
          if (current.sourceSha256 !== version.sourceSha256 || current.fileType !== version.fileType ||
              current.blobKey !== version.blobKey || current.sizeBytes !== version.sizeBytes ||
              current.workingRevision !== version.workingRevision)
            throw new ApplicationError(409, "Document source changed; acquire its current version");
        },
        readBytes: async () => {
          const bytes = await checkedBytes(version);
          if (!bytes) throw new Error("Document source is unavailable");
          return bytes;
        },
      };
    },

    async spreadsheet(scope, documentId, versionId) {
      const version = await repository.version(scope, documentId, versionId);
      if (!version) return null;
      if (!isSpreadsheetDocumentType(version.fileType))
        throw new ApplicationError(400, "Document is not a spreadsheet");
      const bytes = await checkedBytes(version);
      if (!bytes) return null;
      const grid = await spreadsheetToLLMStructure(bytes, version.fileType);
      const sheets = new Map<string, DocumentSpreadsheet["sheets"][number]["cells"]>();
      for (const cell of grid.tableCells) {
        const values = sheets.get(cell.tableName) ?? [];
        values.push({ address: cell.address, value: cell.displayValue,
          row: cell.row, column: cell.column,
          ...(cell.rowSpan ? { rowSpan: cell.rowSpan } : {}),
          ...(cell.columnSpan ? { columnSpan: cell.columnSpan } : {}) });
        sheets.set(cell.tableName, values);
      }
      return { version_id: version.id,
        sheets: [...sheets].map(([name, cells]) => ({ name, cells })) };
    },

    async evidenceView(scope, documentId, versionId, handle) {
      const version = await repository.version(scope, documentId, versionId);
      if (!version || version.fileType.toLowerCase() !== "pdf") return null;
      const receipt = await availableEvidence(() => documentProjectionService.rehydratePdfEvidence(
        handle, projectionReference(documentId, version)));
      return { versionId: version.id, filename: version.filename,
        pageNumbers: receipt.link.page_numbers, pages: receipt.pages };
    },

    async download(scope, documentId, versionId, { preferPdf, disposition, evidence, range }) {
      const selected = await select(scope, documentId, versionId, preferPdf);
      if (!selected) return null;
      if (range && !evidence && selected.fileType === "pdf") {
        // Read and verify the entire source before releasing even its first range.
        // Subsequent ranges share those immutable bytes, but recheck access/version.
        const digest = selected.key === selected.version.blobKey
          ? selected.version.sourceSha256 : documentBlobDigest(selected.key) ?? "";
        if (documentBlobDigest(selected.key) !== digest) throw new Error("Stored document failed its integrity check");
        const bytes = await retainedDownloads(selected.key, () => checkedBlob(selected.key, digest));
        if (!bytes) return null;
        const current = await repository.version(scope, documentId, versionId);
        if (!current) return null;
        if (current.id !== selected.version.id || current.sourceSha256 !== selected.version.sourceSha256 ||
            current.fileType !== selected.version.fileType || current.blobKey !== selected.version.blobKey ||
            current.pdfBlobKey !== selected.version.pdfBlobKey ||
            current.workingRevision !== selected.version.workingRevision)
          throw new ApplicationError(409, "Document changed while it was loading");
        return { kind: "bytes", content: { bytes, sha256: digest,
          version: responseVersion(current), filename: selected.filename,
          fileType: selected.fileType, hasPdfRendition: !!current.pdfBlobKey } };
      }
      if (!evidence && objects.signedGet && selected.key === selected.version.blobKey) {
        if (documentBlobDigest(selected.key) !== selected.version.sourceSha256)
          throw new Error("Stored document failed its integrity check");
        const url = await objects.signedGet(selected.key, {
            expiresIn: SIGNED_GET_TTL_SECONDS,
            filename: selected.filename,
            contentType: contentTypeForDocumentType(selected.fileType),
            expectedSha256: selected.version.sourceSha256,
            sizeBytes: selected.version.sizeBytes,
            disposition,
          });
        return url ? { kind: "redirect", url } : null;
      }
      const loaded = await loadVersion(
        selected.version, selected.key, selected.fileType, selected.filename);
      if (loaded && evidence) await availableEvidence(() => documentProjectionService.verifyPdfEvidence(
        loaded.bytes, evidence, projectionReference(documentId, selected.version)));
      return loaded ? { kind: "bytes", content: loaded } : null;
    },

    async versions(scope, documentId) {
      const history = await repository.history(scope, documentId);
      return history && {
        current_version_id: history.currentVersionId,
        versions: history.versions.map(responseVersion),
      };
    },

    async addVersion(scope, documentId, file) {
      const aggregate = await repository.head(scope, documentId);
      const { expectedCurrentVersionId, expectedCurrentWorkingRevision,
        expectedCurrentSha256, ...versionFile } = file;
      if (!aggregate ||
          expectedCurrentVersionId !== undefined &&
          aggregate.document.currentVersionId !== expectedCurrentVersionId ||
          expectedCurrentWorkingRevision !== undefined &&
          aggregate.versions[0].workingRevision !== expectedCurrentWorkingRevision ||
          expectedCurrentSha256 !== undefined &&
          aggregate.versions[0].sourceSha256 !== expectedCurrentSha256) return null;
      const version = await add(scope, aggregate, versionFile,
        file.provenance ? { provenance: file.provenance,
          source: file.provenance.actor === "work-product" ? "generated" : "user_upload" }
          : undefined);
      return version ? { ...responseVersion(version), project_id: aggregate.document.projectId,
        folder_id: aggregate.document.folderId } : null;
    },

    async commitAssistantVersion(scope, documentId, input) {
      const aggregate = await repository.get(scope, documentId);
      if (!aggregate) return { status: "missing" as const };
      const current = activeVersion(aggregate);
      const sameTurn = !!input.turnId && current?.provenance?.actor === "assistant" &&
        current.provenance.turnId === input.turnId;
      if (!current || current.id !== input.sourceVersionId ||
          current.workingRevision !== input.expectedWorkingRevision ||
          (input.turnVersionId && (input.turnVersionId !== current.id ||
            !!input.turnId && !sameTurn))) {
        return { status: "conflict" as const };
      }
      const edits = input.edits.map((edit) => ({
        ...edit,
        id: randomUUID(),
        status: input.status,
      }));
      if (!input.turnVersionId && !sameTurn) {
        if (aggregate.edits.some((edit) => edit.versionId === current.id &&
            edit.status === "pending"))
          throw new ApplicationError(409,
            "Accept or reject pending tracked changes before starting another assistant edit");
        const version = await add(scope, aggregate, {
          filename: input.filename,
          fileType: input.fileType,
          bytes: input.bytes,
          parts: input.parts,
        }, {
          source: "assistant_edit",
          edits,
          provenance: revisedProvenance(current.provenance, edits.length, input.turnId),
        });
        return version
          ? { status: "committed" as const, version: responseVersion(version), edits }
          : { status: "conflict" as const };
      }

      const pendingIds = aggregate.edits.filter((edit) => edit.versionId === current.id &&
        edit.status === "pending").flatMap(({ delWId, insWId }) =>
        [delWId, insWId].filter((id): id is string => !!id));
      const retainedIds = pendingIds.length
        ? new Set((await extractTrackedChangeIds(input.bytes)).map(({ w_id }) => w_id)) : null;
      if (retainedIds && pendingIds.some((id) => !retainedIds.has(id))) {
        throw new ApplicationError(
          409,
          "A later same-turn edit overlaps an earlier tracked change; split it into a new turn so every accept/reject receipt remains valid",
        );
      }
      const next = await replace(scope, documentId, aggregate.document, current, {
        filename: input.filename, fileType: input.fileType,
        bytes: input.bytes, pageCount: null,
        provenance: revisedProvenance(current.provenance, edits.length, input.turnId, true), edits,
        parts: input.parts,
      });
      return next ? { status: "committed" as const, version: responseVersion(next), edits }
        : { status: "conflict" as const };
    },

    async restoreVersion(scope, documentId, versionId, expectedCurrentVersionId,
      expectedCurrentWorkingRevision, comment) {
      const [aggregate, history, pendingEdits] = await Promise.all([
        repository.head(scope, documentId), repository.history(scope, documentId, true),
        repository.hasPendingEdits(scope, documentId, [expectedCurrentVersionId, versionId]),
      ]);
      const source = history?.versions.find(({ id }) => id === versionId);
      const current = aggregate && activeVersion(aggregate);
      if (!aggregate || !source || !current) return { status: "missing" as const };
      if (current.id !== expectedCurrentVersionId ||
          current.workingRevision !== expectedCurrentWorkingRevision)
        return { status: "conflict" as const };
      if (source.id === current.id) return { status: "conflict" as const };
      if (pendingEdits) return { status: "pending-edits" as const };
      if (!await blobsAvailable(source,
        (history?.parts ?? []).filter(({ versionId }) => versionId === source.id)))
        return { status: "missing" as const };
      const restored: StoredDocumentVersion = {
        ...source,
        id: randomUUID(),
        parentVersionId: current.id,
        versionNumber: current.versionNumber + 1,
        workingRevision: 0,
        source: "restore",
        createdBy: scope.userId,
        ...(scope.userEmail ? { authorEmail: scope.userEmail } : { authorEmail: undefined }),
        comment: safeComment(comment),
        createdAt: new Date().toISOString(),
        provenance: source.provenance?.actor === "assistant"
          ? { ...source.provenance, turnId: undefined } : source.provenance,
      };
      const result = await repository.insertVersion(scope, documentId, {
        expectedCurrentVersionId,
        expectedCurrentWorkingRevision: current.workingRevision,
        expectedProjectId: aggregate.document.projectId,
        expectedFolderId: aggregate.document.folderId,
        version: restored, clonePartsFromVersionId: source.id,
      });
      return result === "created"
        ? { status: "restored" as const, version: responseVersion(restored) }
        : { status: result as "missing" | "conflict" };
    },

    async checkpointVersion(scope, documentId, expectedCurrentVersionId,
      expectedCurrentWorkingRevision, comment) {
      const [aggregate, pendingEdits, history] = await Promise.all([
        repository.head(scope, documentId),
        repository.hasPendingEdits(scope, documentId, [expectedCurrentVersionId]),
        repository.history(scope, documentId, true),
      ]);
      const current = aggregate && activeVersion(aggregate);
      if (!aggregate || !current) return { status: "missing" as const };
      if (current.id !== expectedCurrentVersionId ||
          current.workingRevision !== expectedCurrentWorkingRevision)
        return { status: "conflict" as const };
      if (pendingEdits) return { status: "pending-edits" as const };
      if (!history || !await blobsAvailable(current,
        (history.parts ?? []).filter(({ versionId }) => versionId === current.id)))
        return { status: "missing" as const };
      if (current.workingRevision === 0)
        throw new ApplicationError(409, "There are no changes to save as a new version");
      const version: StoredDocumentVersion = { ...current, id: randomUUID(),
        parentVersionId: current.id, versionNumber: current.versionNumber + 1,
        workingRevision: 0, source: "snapshot", createdBy: scope.userId,
        ...(scope.userEmail ? { authorEmail: scope.userEmail } : { authorEmail: undefined }),
        comment: safeComment(comment), createdAt: new Date().toISOString(),
        provenance: current.provenance?.actor === "assistant"
          ? { ...current.provenance, turnId: undefined } : current.provenance };
      const result = await repository.insertVersion(scope, documentId, {
        expectedCurrentVersionId, expectedCurrentWorkingRevision,
        expectedProjectId: aggregate.document.projectId,
        expectedFolderId: aggregate.document.folderId, version,
        clonePartsFromVersionId: current.id });
      return result === "created"
        ? { status: "created" as const, version: responseVersion(version) }
        : { status: result as "missing" | "conflict" };
    },

    async compareVersions(scope, documentId, baselineVersionId, versionId) {
      if (baselineVersionId === versionId) return { status: "same" as const };
      const [baseline, version] = await Promise.all([
        repository.version(scope, documentId, baselineVersionId),
        repository.version(scope, documentId, versionId),
      ]);
      if (!baseline || !version) return { status: "missing" as const };
      if (baseline.fileType !== "docx" || version.fileType !== "docx")
        return { status: "type-mismatch" as const };
      if (Math.max(baseline.sizeBytes, version.sizeBytes) > MAX_DRAFTING_DOCX_BYTES)
        throw new ApplicationError(413, "Document exceeds the drafting size limit");
      const [before, after] = await Promise.all([
        checkedBytes(baseline), checkedBytes(version),
      ]);
      if (!before || !after) return { status: "missing" as const };
      const compared = await compareDocxVersions(before, after, {
        author: "Beaver compare",
      });
      return { status: "compared" as const, bytes: compared.bytes,
        filename: `${version.filename.replace(/\.docx$/iu, "")} (changes).docx` };
    },

    async renameVersion(scope, documentId, versionId, filename, expectedWorkingRevision) {
      const aggregate = await repository.head(scope, documentId);
      const version = aggregate?.document.currentVersionId === versionId
        ? activeVersion(aggregate, versionId) : null;
      const name = safeFilename(filename);
      return version?.workingRevision === expectedWorkingRevision &&
        await repository.updateVersion(scope, documentId, {
          versionId, expectedBlobKey: version.blobKey, expectedWorkingRevision,
          expectedCurrentVersionId: versionId, update: { filename: name },
        }) === "updated"
        ? responseVersion({ ...version, filename: name,
          workingRevision: version.workingRevision + 1 }) : null;
    },

    async replaceVersion(scope, documentId, versionId, expectedWorkingRevision, file) {
      const aggregate = await repository.head(scope, documentId);
      const target = aggregate?.document.currentVersionId === versionId
        ? activeVersion(aggregate, versionId) : null;
      if (!aggregate || !target) return { status: "missing" as const };
      if (target.workingRevision !== expectedWorkingRevision)
        return { status: "conflict" as const };
      if (target.fileType !== file.fileType) return { status: "type-mismatch" as const };
      const updated = await replace(scope, documentId, aggregate.document, target, { ...file,
        pageCount: null, createdAt: new Date().toISOString(), provenance: null });
      return updated ? { status: "replaced" as const, version: responseVersion(updated) }
        : { status: "conflict" as const };
    },

    async deleteVersion(scope, documentId, versionId, expected) {
      const aggregate = await repository.head(scope, documentId);
      if (!aggregate) return { status: "missing" as const };
      const target = activeVersion(aggregate, versionId);
      if (!target || aggregate.document.currentVersionId !== versionId)
        return { status: "missing" as const };
      if (expected && (expected.versionId !== versionId ||
          expected.workingRevision !== target.workingRevision ||
          expected.projectId !== aggregate.document.projectId ||
          expected.folderId !== aggregate.document.folderId))
        return { status: "missing" as const };
      if (!target.parentVersionId) return { status: "only" as const };
      const currentVersionId = target.parentVersionId;
      return await repository.deleteVersion(
        scope, documentId, { versionId, nextCurrentVersionId: currentVersionId,
          expectedCurrentVersionId: aggregate.document.currentVersionId,
          expectedBlobKey: target.blobKey, expectedPdfBlobKey: target.pdfBlobKey,
          expectedWorkingRevision: expected?.workingRevision ?? target.workingRevision,
          expectedProjectId: expected?.projectId ?? aggregate.document.projectId,
          expectedFolderId: expected?.folderId ?? aggregate.document.folderId },
      ) ? { status: "deleted" as const, currentVersionId }
        : { status: "missing" as const };
    },

    async resolveEdits(scope, documentId, editIds, mode) {
      const aggregate = await repository.get(scope, documentId);
      if (!aggregate) return { status: "missing" as const };
      const current = activeVersion(aggregate);
      const requested = new Set(editIds);
      const edits = current ? aggregate.edits.filter((entry) =>
        requested.has(entry.id) && entry.versionId === current.id) : [];
      if (!current || !requested.size || edits.length !== requested.size)
        return { status: "missing" as const };
      const desired = mode === "accept" ? "accepted" as const : "rejected" as const;
      const conflict = edits.find(({ status }) => status !== "pending" && status !== desired);
      if (conflict) return { status: "conflict" as const, editStatus: conflict.status };
      const pending = edits.filter(({ status }) => status === "pending");
      const ids = pending.flatMap(({ delWId, insWId }) =>
        [delWId, insWId].filter((id): id is string => !!id));
      const downloadUrl = `/api/single-documents/${encodeURIComponent(documentId)}/file?version_id=${encodeURIComponent(current.id)}`;
      if (!pending.length) return { status: "unchanged" as const, editStatus: desired,
        versionId: current.id, versionNumber: current.versionNumber, downloadUrl };
      if (!ids.length) return { status: "invalid" as const };
      const source = await checkedBytes(current);
      if (!source) return { status: "invalid" as const };
      const resolved = await resolveTrackedChange(source, ids, mode);
      if (!resolved.found) return { status: "invalid" as const };
      if (!await replace(scope, documentId, aggregate.document, current, {
        filename: current.filename,
        fileType: current.fileType, bytes: resolved.bytes, pageCount: current.pageCount,
        resolveEdits: { ids: pending.map(({ id }) => id), status: desired } }))
        return { status: "conflict" as const, editStatus: pending[0].status };
      return {
        status: "resolved" as const,
        editStatus: desired,
        versionId: current.id,
        versionNumber: current.versionNumber,
        downloadUrl,
      };
    },
  };

  return application;
}
