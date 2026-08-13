import {
  createLocalDocument,
  createLocalFolder,
  deleteLocalFolder,
  getLocalDocumentResponse,
  getLocalFolder,
  moveLocalDocument,
  pageLocalLibrary,
  updateLocalDocument,
  updateLocalFolder,
} from "./localDocumentStore";
import type { LibraryStore } from "./libraryStore";

export const localLibraryStore = {
  page: (scope, options) => pageLocalLibrary(scope.userId, scope.kind, options),
  upload: (scope, file) => createLocalDocument({
    userId: scope.userId,
    kind: scope.kind,
    filename: file.originalname,
    bytes: file.buffer,
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
