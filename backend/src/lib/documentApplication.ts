import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { docxToPdf } from "./convert";
import type { DocumentAggregate, DocumentRepository,
  StoredDocumentVersion } from "./documentRepository";
import { contentTypeForDocumentType, shouldConvertToPdf,
  validateDocumentFile } from "./documentTypes";
import type { DocumentContent, DocumentFile, DocumentProvenance, DocumentScope,
  DocumentStore, DocumentVersion, StoredAssistantEdit } from "./documentStore";
import { ApplicationError } from "./applicationError";
import { extractTrackedChangeIds, resolveTrackedChange } from "./docxTrackedChanges";
import { sha256 } from "./hash";
import { normalizeDocumentMetadata, normalizeDocumentNotes,
  type LibraryKind } from "./normalize";
import { MAX_OBJECT_SIZE_BYTES, normalizeDownloadFilename, SIGNED_GET_TTL_SECONDS,
  type ObjectStorage, versionStorageKey } from "./storage";
import { assertBoundedZip, loadZip } from "./zip";
import { pdfLifecyclePhase } from "./pdfLifecycleDiagnostics";

class DocumentWriteConflict extends Error {}

const safeFilename = (value: string) => {
  if (!value.trim()) throw new ApplicationError(400, "filename is required");
  return normalizeDownloadFilename(value);
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
  for await (const value of createReadStream(input.path)) {
    const chunk = Buffer.from(value);
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
  id: version.id, version_number: version.versionNumber, source: version.source,
  created_at: version.createdAt, filename: version.filename, file_type: version.fileType,
  size_bytes: version.sizeBytes, page_count: version.pageCount,
  source_sha256: version.sourceSha256,
  provenance: version.provenance ? { schema_version: version.provenance.schemaVersion,
    actor: version.provenance.actor, action: version.provenance.action,
    parent_version_id: version.provenance.parentVersionId,
    change_count: version.provenance.changeCount } : undefined,
  deleted_at: null,
});

const responseDocument = (aggregate: DocumentAggregate) => {
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
  };
};

function activeVersion(aggregate: DocumentAggregate, requested?: string | null) {
  const id = requested || aggregate.document.currentVersionId;
  return aggregate.versions.find((version) => version.id === id) ?? null;
}

const objectKeys = (version: StoredDocumentVersion) =>
  [version.blobKey, version.pdfBlobKey, ...version.cleanupKeys]
    .filter((key): key is string => !!key);

function editedFilename(version: StoredDocumentVersion) {
  const name = version.filename.trim() || "Untitled document.docx";
  if (version.source !== "assistant_edit" || !version.versionNumber) return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name} [Edited V${version.versionNumber}]${
    dot > 0 ? name.slice(dot) : ""
  }`;
}

function provenanceWithEdits(provenance: DocumentProvenance | undefined,
  edits: StoredAssistantEdit[]) {
  return provenance && {
    ...provenance,
    changeCount: (provenance.changeCount ?? provenance.trackedEdits?.length ?? 0) + edits.length,
    trackedEdits: [...(provenance.trackedEdits ?? []), ...edits],
  };
}

export function createDocumentApplication(repository: DocumentRepository,
  objects: ObjectStorage): DocumentStore {
  const removeObjects = async (scope: DocumentScope, keys: string[]) =>
    Promise.all([...new Set(keys)].map(async (key) => {
      try { await objects.remove(key); }
      catch (error) { await repository.recordOrphan(scope, key).catch((recordError) => {
        throw new AggregateError([error, recordError], "Document object cleanup recording failed");
      }); }
    }));
  const cleanup = async (scope: DocumentScope, documentId: string,
    versionId: string, keys: string[]) => {
    const unique = [...new Set(keys.filter(Boolean))];
    if (!unique.length) return;
    await Promise.all(unique.map((key) => objects.remove(key)));
    await repository.clearCleanup(scope, documentId, versionId, unique);
  };

  const compensate = async (scope: DocumentScope, key: string,
    cause: unknown): Promise<never> => {
    try {
      await objects.remove(key);
    } catch (cleanupError) {
      try {
        await repository.recordOrphan(scope, key);
      } catch (recordError) {
        throw new AggregateError([cause, cleanupError, recordError],
          "Document metadata and durable object cleanup recording failed");
      }
      throw new AggregateError([cause, cleanupError],
        "Document metadata failed and uploaded object cleanup must be retried");
    }
    throw cause;
  };

  const makeVersion = async (input: { scope: DocumentScope; documentId: string;
    versionId?: string; versionNumber: number; source: string; filename: string;
    provenance?: DocumentProvenance;
    } & DocumentFile & {
    edits?: StoredAssistantEdit[] }) => {
    const id = input.versionId ?? randomUUID();
    const { filename, fileType, sizeBytes, sourceSha256 } = await validateUpload(input);
    const blobKey = versionStorageKey(
      input.scope.userId, input.documentId, id, sourceSha256, filename);
    const version: StoredDocumentVersion = {
      id, documentId: input.documentId, versionNumber: input.versionNumber,
      source: input.source, createdAt: new Date().toISOString(), filename, fileType,
      sizeBytes,
      pageCount: null,
      sourceSha256, blobKey, pdfBlobKey: fileType === "pdf" ? blobKey : null, cleanupKeys: [],
      provenance: input.edits
        ? provenanceWithEdits(input.provenance, input.edits)
        : input.provenance,
    };
    await pdfLifecyclePhase("upload.blob_write", input.documentId, () =>
      objects.put(blobKey, "bytes" in input ? input.bytes : { path: input.path, sizeBytes },
        contentTypeForDocumentType(fileType)));
    return version;
  };

  const ensurePdf = async (scope: DocumentScope, aggregate: DocumentAggregate,
    version: StoredDocumentVersion) => {
    if (version.pdfBlobKey || !shouldConvertToPdf(version.fileType)) return version;
    const source = await objects.get(version.blobKey);
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
    const key = versionStorageKey(scope.userId, aggregate.document.id,
      `${version.id}-pdf`, digest, `${version.filename}.pdf`);
    await objects.put(key, pdf, "application/pdf");
    let updated;
    try {
      updated = await repository.updateVersion(scope, aggregate.document.id, {
        versionId: version.id,
        expectedBlobKey: version.blobKey,
        update: { pdfBlobKey: key },
      });
    } catch (error) {
      await compensate(scope, key, error);
    }
    if (updated !== "updated") {
      try {
        await objects.remove(key);
      } catch (error) {
        await repository.recordOrphan(scope, key);
        throw error;
      }
      const refreshed = await repository.get(scope, aggregate.document.id);
      return refreshed ? activeVersion(refreshed, version.id) ?? version : version;
    }
    return { ...version, pdfBlobKey: key };
  };

  const selectedVersion = async (scope: DocumentScope, aggregate: DocumentAggregate,
    requested: string | null, preferPdf: boolean) => {
    const selected = activeVersion(aggregate, requested);
    if (!selected) return null;
    const version = preferPdf ? await ensurePdf(scope, aggregate, selected) : selected;
    const usePdf = preferPdf && !!version.pdfBlobKey && shouldConvertToPdf(version.fileType);
    return { version, key: usePdf ? version.pdfBlobKey! : version.blobKey,
      fileType: usePdf ? "pdf" : version.fileType, filename: editedFilename(version) };
  };

  const content = async (scope: DocumentScope, aggregate: DocumentAggregate,
    requested: string | null, preferPdf: boolean): Promise<DocumentContent | null> => {
    const selected = await selectedVersion(scope, aggregate, requested, preferPdf);
    if (!selected) return null;
    const bytes = await objects.get(selected.key);
    return bytes && { bytes, version: responseVersion(selected.version),
      filename: selected.filename, fileType: selected.fileType,
      hasPdfRendition: !!selected.version.pdfBlobKey };
  };

  const add = async (scope: DocumentScope, aggregate: DocumentAggregate,
    file: DocumentFile, input?: {
      source?: string; provenance?: DocumentProvenance; edits?: StoredAssistantEdit[] }) => {
    const version = await makeVersion({ scope, documentId: aggregate.document.id,
      versionNumber: Math.max(...aggregate.versions.map(({ versionNumber }) => versionNumber)) + 1,
      source: input?.source ?? "user_upload",
      provenance: input?.provenance, edits: input?.edits, ...file,
    });
    let result: Awaited<ReturnType<DocumentRepository["insertVersion"]>>;
    try {
      result = await repository.insertVersion(scope, aggregate.document.id, {
        expectedCurrentVersionId: aggregate.document.currentVersionId,
        version, edits: input?.edits });
    } catch (error) {
      return compensate(scope, version.blobKey, error);
    }
    if (result !== "created") await compensate(scope, version.blobKey,
      new DocumentWriteConflict(result));
    return version;
  };

  const replace = async (scope: DocumentScope, documentId: string,
    current: StoredDocumentVersion, input: DocumentFile & {
      pageCount: number | null;
      provenance?: DocumentProvenance | null; createdAt?: string; edits?: StoredAssistantEdit[];
      resolveEdit?: { id: string; status: StoredAssistantEdit["status"] };
    }) => {
    const { filename, fileType, sizeBytes, sourceSha256 } = await validateUpload(input);
    const key = versionStorageKey(scope.userId, documentId, current.id,
      sourceSha256, filename);
    await objects.put(key, "bytes" in input ? input.bytes : { path: input.path, sizeBytes },
      contentTypeForDocumentType(fileType));
    const oldKeys = objectKeys(current).filter((value) => value !== key);
    const next: StoredDocumentVersion = { ...current, filename,
      fileType, sizeBytes, pageCount: input.pageCount,
      sourceSha256, blobKey: key, pdfBlobKey: fileType === "pdf" ? key : null,
      cleanupKeys: oldKeys, provenance: input.provenance === null
        ? undefined : input.provenance ?? current.provenance,
      createdAt: input.createdAt ?? current.createdAt };
    let result;
    try {
      result = await repository.updateVersion(scope, documentId, {
        versionId: current.id, expectedBlobKey: current.blobKey,
        update: { filename: next.filename, fileType: next.fileType,
          sizeBytes: next.sizeBytes, pageCount: next.pageCount,
          sourceSha256, blobKey: key, pdfBlobKey: next.pdfBlobKey,
          cleanupKeys: oldKeys, provenance: input.provenance,
          ...(input.createdAt ? { createdAt: input.createdAt } : {}) },
        edits: input.edits, resolveEdit: input.resolveEdit,
      });
    } catch (error) { await compensate(scope, key, error); }
    if (result !== "updated") await compensate(scope, key,
      new DocumentWriteConflict("Document version conflict"));
    await cleanup(scope, documentId, current.id, oldKeys);
    return next;
  };

  const application: DocumentStore = {
    async resumeCleanup() {
      for (const key of await repository.pendingOrphans("system")) {
        try {
          await objects.remove(key);
          await repository.clearOrphan("system", key);
        } catch (error) {
          console.error("[document-cleanup] orphan retry failed", {
            key, error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      for (const pending of await repository.pendingCleanup("system")) {
        try {
          await cleanup(pending.scope, pending.documentId, pending.versionId, pending.keys);
        } catch (error) {
          console.error("[document-cleanup] retry failed", {
            documentId: pending.documentId,
            versionId: pending.versionId,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    },

    async metadata(scope, documentId, owner = false) {
      const aggregate = await repository.get(scope, documentId, owner);
      return aggregate ? responseDocument(aggregate) : null;
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
        if (authorization === "folder-unavailable")
          throw new ApplicationError(409, "Project folders are unavailable");
        throw new ApplicationError(404,
          authorization === "project-missing" ? "Project not found" : "Folder not found");
      }
      const documentId = randomUUID();
      const version = await makeVersion({ scope, documentId, versionNumber: 1,
        source: input.provenance?.action === "created" ? "generated" : "upload",
        ...input,
      });
      const now = version.createdAt, document = {
        id: documentId, userId: scope.userId, projectId, libraryKind, folderId,
        status: "ready", currentVersionId: version.id, createdAt: now, updatedAt: now,
        metadata: {}, notes: null,
        parseState: version.fileType === "pdf" ? { status: "queued" as const } : null,
      };
      try {
        await pdfLifecyclePhase("upload.repository", documentId, () =>
          repository.create(scope, { document, version }));
      } catch (error) {
        await compensate(scope, version.blobKey, error);
      }
      return responseDocument({ document, versions: [version], edits: [], isOwner: true });
    },

    async deleteDocument(scope, documentId) {
      const aggregate = await repository.get(scope, documentId, true);
      if (!aggregate) return false;
      const keys = aggregate.versions.flatMap(objectKeys);
      if (!await repository.deleteDocument(scope, documentId)) return false;
      await removeObjects(scope, keys);
      return true;
    },

    async deleteUserDocuments(scope, input) {
      const ids = await repository.deletionIds(scope, input.projectIds, input.includeOwned);
      const deleted = await Promise.all(ids.map((id) => application.deleteDocument(scope, id)));
      if (deleted.some((ok) => !ok)) throw new Error("Document deletion was incomplete");
      if (!input.purgeObjects) return ids.length;
      let cursor: string | null = null;
      do {
        const page = await objects.list(scope.userId, { cursor });
        await Promise.all(page.keys.map((key) => objects.remove(key)));
        cursor = page.cursor;
      } while (cursor);
      return ids.length;
    },

    async relocate(scope, documentId, input) {
      const result = await repository.relocate(scope, documentId, input);
      if (result !== "moved") return { status: result };
      const aggregate = await repository.get(scope, documentId, input.owner);
      return aggregate
        ? { status: "moved", document: responseDocument(aggregate) }
        : { status: "missing" };
    },

    async updateMetadata(scope, documentId, input) {
      if (!await repository.updateMetadata(scope, documentId, {
        ...(input.metadata !== undefined
          ? { metadata: normalizeDocumentMetadata(input.metadata) } : {}),
        ...(input.notes !== undefined
          ? { notes: normalizeDocumentNotes(input.notes) } : {}),
      })) return null;
      const aggregate = await repository.get(scope, documentId, true);
      return aggregate ? responseDocument(aggregate) : null;
    },

    async files(scope, documentIds, maxBytes) {
      const aggregates = await repository.getMany(scope, [...new Set(documentIds)]);
      if (maxBytes !== undefined && aggregates.reduce((bytes, aggregate) =>
        bytes + (activeVersion(aggregate)?.sizeBytes ?? 0), 0) > maxBytes)
        throw new ApplicationError(413, "Selected documents exceed the archive size limit");
      const loaded = await Promise.all(aggregates.map((aggregate) =>
        content(scope, aggregate, null, false)));
      return loaded.flatMap((value) => value ? [value] : []);
    },

    async read(scope, documentId, versionId, preferPdf) {
      const aggregate = await repository.get(scope, documentId);
      return aggregate ? content(scope, aggregate, versionId, preferPdf) : null;
    },

    async download(scope, documentId, versionId, preferPdf, disposition) {
      const aggregate = await repository.get(scope, documentId);
      if (!aggregate) return null;
      const selected = await selectedVersion(scope, aggregate, versionId, preferPdf);
      if (!selected) return null;
      if (objects.signedGet) {
        return {
          kind: "redirect",
          url: await objects.signedGet(selected.key, {
            expiresIn: SIGNED_GET_TTL_SECONDS,
            filename: selected.filename,
            disposition,
          }),
        };
      }
      const loaded = await content(scope, aggregate, versionId, preferPdf);
      return loaded ? { kind: "bytes", content: loaded } : null;
    },

    async versions(scope, documentId) {
      const aggregate = await repository.get(scope, documentId);
      return aggregate && {
        current_version_id: aggregate.document.currentVersionId,
        versions: aggregate.versions.map(responseVersion),
      };
    },

    async addVersion(scope, documentId, file) {
      const aggregate = await repository.get(scope, documentId);
      if (!aggregate) return null;
      try {
        return responseVersion(await add(scope, aggregate, {
          ...file,
          filename: safeFilename(file.filename),
        }));
      } catch (error) {
        if (error instanceof DocumentWriteConflict) return null;
        throw error;
      }
    },

    async commitAssistantVersion(scope, documentId, input) {
      const aggregate = await repository.get(scope, documentId);
      if (!aggregate) return { status: "missing" as const };
      const current = activeVersion(aggregate);
      if (!current || current.id !== input.sourceVersionId ||
          (input.turnVersionId && input.turnVersionId !== current.id)) {
        return { status: "conflict" as const };
      }
      const edits = input.edits.map((edit) => ({
        ...edit,
        id: randomUUID(),
        status: input.status,
      }));
      if (!input.turnVersionId) {
        try {
          const version = await add(scope, aggregate, {
            filename: safeFilename(input.filename),
            fileType: "docx",
            bytes: input.bytes,
          }, {
            source: "assistant_edit",
            edits,
            provenance: {
              schemaVersion: 1,
              actor: "assistant",
              action: "revised",
              parentVersionId: input.parentVersionId,
              trackedEdits: [],
            },
          });
          return { status: "committed" as const, version: responseVersion(version), edits };
        } catch (error) {
          if (error instanceof DocumentWriteConflict) {
            return { status: "conflict" as const };
          }
          throw error;
        }
      }

      const retainedIds = new Set(
        (await extractTrackedChangeIds(input.bytes)).map(({ w_id }) => w_id),
      );
      if (aggregate.edits.some((edit) => edit.versionId === current.id &&
          edit.status === "pending" &&
          [edit.delWId, edit.insWId].filter((id): id is string => !!id)
            .some((id) => !retainedIds.has(id)))) {
        throw new ApplicationError(
          409,
          "A later same-turn edit overlaps an earlier tracked change; split it into a new turn so every accept/reject receipt remains valid",
        );
      }
      const filename = safeFilename(input.filename);
      const next = await replace(scope, documentId, current, {
        filename, fileType: "docx", bytes: input.bytes, pageCount: null,
        provenance: provenanceWithEdits(current.provenance, edits), edits,
      });
      return { status: "committed" as const, version: responseVersion(next), edits };
    },

    async copyVersion(scope, targetId, sourceId, filename) {
      const [target, source] = await Promise.all([
        repository.get(scope, targetId),
        repository.get(scope, sourceId),
      ]);
      if (!target) return { status: "target-missing" as const };
      if (!source) return { status: "source-missing" as const };
      const move = source.document.projectId && target.document.projectId
        ? source.document.projectId === target.document.projectId
        : !source.document.projectId && !target.document.projectId &&
          source.document.userId === scope.userId && target.document.userId === scope.userId;
      if (move && !source.isOwner) return { status: "forbidden" as const };
      const sourceVersion = activeVersion(source);
      if (!sourceVersion) return { status: "source-missing" as const };
      const bytes = await objects.get(sourceVersion.blobKey);
      if (!bytes) return { status: "source-missing" as const };
      const version = await add(scope, target, {
        filename: safeFilename(filename ?? sourceVersion.filename),
        fileType: sourceVersion.fileType,
        bytes,
      });
      if (move) await application.deleteDocument(scope, sourceId);
      return { status: "created" as const, version: responseVersion(version) };
    },

    async renameVersion(scope, documentId, versionId, filename) {
      const aggregate = await repository.get(scope, documentId);
      const version = aggregate && activeVersion(aggregate, versionId);
      const name = safeFilename(filename);
      return version && await repository.renameVersion(
        scope, documentId, versionId, name,
      ) ? responseVersion({ ...version, filename: name }) : null;
    },

    async replaceVersion(scope, documentId, versionId, file) {
      const aggregate = await repository.get(scope, documentId, true);
      const target = aggregate && activeVersion(aggregate, versionId);
      if (!aggregate || !target) return { status: "missing" as const };
      if (target.fileType !== file.fileType) return { status: "type-mismatch" as const };
      const updated = await replace(scope, documentId, target, { ...file,
        pageCount: null,
        createdAt: new Date().toISOString(), provenance: null });
      return { status: "replaced" as const, version: responseVersion(updated) };
    },

    async deleteVersion(scope, documentId, versionId) {
      const aggregate = await repository.get(scope, documentId, true);
      if (!aggregate) return { status: "missing" as const };
      if (aggregate.versions.length <= 1) return { status: "only" as const };
      const target = activeVersion(aggregate, versionId);
      if (!target) return { status: "missing" as const };
      const remaining = aggregate.versions.filter(({ id }) => id !== versionId)
        .sort((left, right) => right.versionNumber - left.versionNumber ||
          Date.parse(right.createdAt) - Date.parse(left.createdAt));
      const currentVersionId = aggregate.document.currentVersionId === versionId
        ? remaining[0]?.id ?? ""
        : aggregate.document.currentVersionId;
      return await repository.deleteVersion(
        scope, documentId, { versionId, nextCurrentVersionId: currentVersionId,
          expectedCurrentVersionId: aggregate.document.currentVersionId,
          expectedBlobKey: target.blobKey, expectedPdfBlobKey: target.pdfBlobKey,
          expectedCleanupKeys: target.cleanupKeys },
      ) ? (await removeObjects(scope, objectKeys(target)),
          { status: "deleted" as const, currentVersionId })
        : { status: "missing" as const };
    },

    async resolveEdit(scope, documentId, editId, mode) {
      const aggregate = await repository.get(scope, documentId);
      if (!aggregate) return { status: "missing" as const };
      const current = activeVersion(aggregate);
      const edit = current && aggregate.edits.find((entry) =>
        entry.id === editId && entry.versionId === current.id);
      if (!current || !edit) return { status: "missing" as const };
      const desired = mode === "accept" ? "accepted" as const : "rejected" as const;
      if (edit.status !== "pending") return edit.status === desired
        ? {
            status: "unchanged" as const,
            editStatus: edit.status,
            versionId: current.id,
            versionNumber: current.versionNumber,
            downloadUrl: `/api/single-documents/${encodeURIComponent(documentId)}/file?version_id=${encodeURIComponent(current.id)}`,
          }
        : { status: "conflict" as const, editStatus: edit.status };
      const ids = [edit.delWId, edit.insWId].filter((id): id is string => !!id);
      if (!ids.length) return { status: "invalid" as const };
      const source = await objects.get(current.blobKey);
      if (!source) return { status: "invalid" as const };
      const resolved = await resolveTrackedChange(source, ids, mode);
      if (!resolved.found) return { status: "invalid" as const };
      try {
        await replace(scope, documentId, current, { filename: current.filename,
          fileType: current.fileType, bytes: resolved.bytes, pageCount: current.pageCount,
          provenance: current.provenance && { ...current.provenance,
            trackedEdits: current.provenance.trackedEdits?.map((stored) =>
              stored.id === editId ? { ...stored, status: desired } : stored) },
          resolveEdit: { id: editId, status: desired } });
      } catch (error) {
        if (error instanceof DocumentWriteConflict)
          return { status: "conflict" as const, editStatus: edit.status };
        throw error;
      }
      return {
        status: "resolved" as const,
        editStatus: desired,
        versionId: current.id,
        versionNumber: current.versionNumber,
        downloadUrl: `/api/single-documents/${encodeURIComponent(documentId)}/file?version_id=${encodeURIComponent(current.id)}`,
      };
    },
  };

  return application;
}
