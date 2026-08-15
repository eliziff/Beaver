import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  addLocalVersion,
  createLocalDocument,
  createLocalFolder,
  deleteLocalDocument,
  deleteLocalFolder,
  deleteLocalVersion,
  getLocalDocumentResponse,
  getLocalFolder,
  getLocalVersionFile,
  getLocalVersionFiles,
  listLocalVersions,
  moveLocalDocument,
  pageLocalLibrary,
  renameLocalVersion,
  replaceLocalVersion,
  resolveLocalTrackedEdit,
  updateLocalDocument,
  updateLocalAssistantTurnVersion,
  updateLocalFolder,
} from "./localDocumentStore";
import {
  DocumentStoreError,
  type DocumentContent,
  type DocumentStore,
} from "./documentStore";
import type { LibraryStore } from "./libraryStore";
import { legalKnowledgeGraphStore } from "./legalKnowledgeGraphStore";

export const localLibraryStore = {
  page: (scope, options) => pageLocalLibrary(scope.userId, scope.kind, {
    ...options,
    flat: options.documentsOnly,
  }),
  folder: (scope, folderId) =>
    getLocalFolder(scope.userId, scope.kind, folderId),
  createFolder: (scope, name, parentFolderId) =>
    createLocalFolder(scope.userId, scope.kind, name, parentFolderId),
  updateFolder: (scope, folderId, update) => updateLocalFolder({
    userId: scope.userId,
    kind: scope.kind,
    folderId,
    name: update.name,
    parentFolderId: update.parentFolderId,
  }),
  deleteFolder: (scope, folderId) =>
    deleteLocalFolder(scope.userId, scope.kind, folderId),
  document: async (scope, documentId) => {
    const document = await getLocalDocumentResponse(scope.userId, documentId);
    return document?.library_kind === scope.kind ? document : null;
  },
  moveDocument: (scope, documentId, folderId) =>
    moveLocalDocument(scope.userId, scope.kind, documentId, folderId),
  updateDocument: (scope, documentId, update) => updateLocalDocument({
    userId: scope.userId,
    kind: scope.kind,
    documentId,
    ...update,
  }),
} satisfies LibraryStore;

const content = async (
  userId: string,
  documentId: string,
  versionId: string | null,
  preferPdf: boolean,
): Promise<DocumentContent | null> => {
  const file = await getLocalVersionFile(
    userId,
    documentId,
    versionId,
    preferPdf,
  );
  return file && {
    bytes: await readFile(file.path),
    localPath: file.path,
    version: file.version,
    filename: file.version.filename,
    fileType: file.fileType,
    hasPdfRendition: !!file.document.pdf_storage_path,
  };
};

export const localDocuments = {
  async create(scope, input) {
    if (input.projectId && input.folderId) {
      throw new DocumentStoreError(409, "Local project folders are unavailable");
    }
    const graph = input.projectId ? legalKnowledgeGraphStore() : null;
    if (input.projectId && !graph!.getMatter(scope.userId, input.projectId)) {
      throw new DocumentStoreError(404, "Project not found");
    }
    const document = await createLocalDocument({
      userId: scope.userId,
      kind: input.libraryKind ?? "file",
      filename: input.filename,
      bytes: input.bytes,
      provenance: input.provenance,
    });
    try {
      if (input.projectId) {
        if (!graph!.attachMatterDocument(scope.userId, input.projectId, document.id)) {
          throw new DocumentStoreError(404, "Project not found");
        }
        return { ...document, project_id: input.projectId, folder_id: null };
      }
      if (input.folderId && !await moveLocalDocument(
        scope.userId,
        input.libraryKind ?? "file",
        document.id,
        input.folderId,
      )) throw new DocumentStoreError(404, "Folder not found");
      return document;
    } catch (error) {
      await deleteLocalDocument(scope.userId, document.id).catch(() => undefined);
      throw error;
    }
  },

  deleteDocument: (scope, documentId) =>
    deleteLocalDocument(scope.userId, documentId),

  async files(scope, documentIds) {
    const files = await getLocalVersionFiles(scope.userId, documentIds);
    return Promise.all([...files.values()].map(async (file) => ({
      bytes: await readFile(file.path),
      localPath: file.path,
      version: file.version,
      filename: file.filename,
      fileType: file.fileType,
      hasPdfRendition: file.hasPdfRendition,
    })));
  },

  read: (scope, documentId, versionId, preferPdf) =>
    content(scope.userId, documentId, versionId, preferPdf),

  async link(scope, documentId, versionId) {
    const file = await getLocalVersionFile(scope.userId, documentId, versionId);
    return file && {
      version: file.version,
      filename: file.version.filename,
      fileType: file.fileType,
      hasPdfRendition: !!file.document.pdf_storage_path,
    };
  },

  versions: (scope, documentId) => listLocalVersions(scope.userId, documentId),

  addVersion: (scope, documentId, file) => addLocalVersion({
    userId: scope.userId,
    documentId,
    ...file,
  }),

  async commitAssistantVersion(scope, documentId, input) {
    const edits = input.edits.map((edit) => ({
      ...edit,
      id: randomUUID(),
      status: input.status,
    }));
    const version = input.turnVersionId
      ? input.turnVersionId === input.sourceVersionId
        ? await updateLocalAssistantTurnVersion({
            userId: scope.userId,
            documentId,
            versionId: input.turnVersionId,
            parentVersionId: input.parentVersionId,
            filename: input.filename,
            bytes: input.bytes,
            trackedEdits: edits,
          })
        : null
      : await addLocalVersion({
          userId: scope.userId,
          documentId,
          filename: input.filename,
          bytes: input.bytes,
          expectedVersionId: input.sourceVersionId,
          provenance: {
            schemaVersion: 1,
            actor: "assistant",
            action: "revised",
            parentVersionId: input.parentVersionId,
            changeCount: edits.length,
            trackedEdits: edits,
          },
        });
    if (version) return { status: "committed" as const, version, edits };
    return await listLocalVersions(scope.userId, documentId)
      ? { status: "conflict" as const }
      : { status: "missing" as const };
  },

  async copyVersion(scope, targetId, sourceId, filename) {
    if (!await listLocalVersions(scope.userId, targetId)) {
      return { status: "target-missing" as const };
    }
    const source = await getLocalVersionFile(scope.userId, sourceId);
    if (!source) return { status: "source-missing" as const };
    const version = await addLocalVersion({
      userId: scope.userId,
      documentId: targetId,
      filename: filename ?? source.version.filename,
      bytes: await readFile(source.path),
    });
    if (!version) return { status: "target-missing" as const };
    await deleteLocalDocument(scope.userId, sourceId);
    return { status: "created" as const, version };
  },

  renameVersion: (scope, documentId, versionId, filename) =>
    renameLocalVersion(scope.userId, documentId, versionId, filename),

  async replaceVersion(scope, documentId, versionId, file) {
    const target = (await listLocalVersions(scope.userId, documentId))
      ?.versions.find((version) => version.id === versionId);
    if (!target) return { status: "missing" as const };
    if (target.file_type !== file.fileType) {
      return { status: "type-mismatch" as const };
    }
    const version = await replaceLocalVersion({
      userId: scope.userId,
      documentId,
      versionId,
      filename: file.filename,
      bytes: file.bytes,
    });
    return version
      ? { status: "replaced" as const, version }
      : { status: "missing" as const };
  },

  async deleteVersion(scope, documentId, versionId) {
    const result = await deleteLocalVersion(scope.userId, documentId, versionId);
    return result.status === "deleted"
      ? { status: "deleted" as const, currentVersionId: result.currentVersionId }
      : result;
  },

  async resolveEdit(scope, documentId, editId, mode) {
    const result = await resolveLocalTrackedEdit({
      userId: scope.userId,
      documentId,
      editId,
      mode,
    });
    if (result.status === "conflict") {
      return { status: "conflict" as const, editStatus: result.edit.status };
    }
    if (result.status === "missing" || result.status === "invalid") return result;
    return {
      status: result.status,
      editStatus: result.edit.status,
      versionId: result.version.id,
      versionNumber: result.version.version_number,
      downloadUrl:
        `/single-documents/${encodeURIComponent(documentId)}/file` +
        `?version_id=${encodeURIComponent(result.version.id)}` +
        `&rev=${encodeURIComponent(result.version.source_sha256 ?? "")}`,
    };
  },
} satisfies DocumentStore;
