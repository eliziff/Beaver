import type { DocumentStore } from "./documentStore";
import type { LibraryStore } from "./libraryStore";
import {
  createLocalFolder,
  deleteLocalFolder,
  getLocalDocumentResponse,
  getLocalFolder,
  listLocalFolderDocumentIds,
  moveLocalDocument,
  pageLocalLibrary,
  updateLocalDocument,
  updateLocalFolder,
} from "./localDocumentStore";

export const createLocalLibraryStore = (documents: DocumentStore): LibraryStore => ({
  page: (scope, options) => pageLocalLibrary(scope.userId, scope.kind, {
    ...options, flat: options.documentsOnly,
  }),
  folder: (scope, id) => getLocalFolder(scope.userId, scope.kind, id),
  createFolder: (scope, name, parent) =>
    createLocalFolder(scope.userId, scope.kind, name, parent),
  updateFolder: (scope, id, update) => updateLocalFolder({
    userId: scope.userId, kind: scope.kind, folderId: id,
    name: update.name, parentFolderId: update.parentFolderId,
  }),
  async deleteFolder(scope, id) {
    const documentIds = await listLocalFolderDocumentIds(scope.userId, scope.kind, id);
    if (!documentIds) return false;
    for (const documentId of documentIds) {
      if (!await documents.deleteDocument(scope, documentId)) {
        throw new Error("Failed to delete folder document");
      }
    }
    return deleteLocalFolder(scope.userId, scope.kind, id);
  },
  async document(scope, id) {
    const document = await getLocalDocumentResponse(scope.userId, id);
    return document?.library_kind === scope.kind ? document : null;
  },
  moveDocument: (scope, id, folderId) =>
    moveLocalDocument(scope.userId, scope.kind, id, folderId),
  async updateDocument(scope, id, update) {
    const current = await getLocalDocumentResponse(scope.userId, id);
    const versionId = current?.library_kind === scope.kind
      ? current.current_version_id : null;
    if (!versionId || !await documents.renameVersion(
      scope, id, versionId, update.filename,
    )) return null;
    return updateLocalDocument({
      userId: scope.userId, kind: scope.kind, documentId: id,
      metadata: update.metadata, notes: update.notes,
    });
  },
});
