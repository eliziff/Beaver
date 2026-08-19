import type { DocumentRecord, DocumentStore } from "./documentStore";
import { normalizeDocumentFilename, type LibraryKind } from "./normalize";
import { deleteFolderDocuments, validateFolderMove } from "./folderApplication";
import { ApplicationError, type ApplicationScope } from "./applicationError";

export type LibraryScope = ApplicationScope & { kind: LibraryKind };
type LibraryDocument = DocumentRecord;
export type LibraryFolder = Record<string, unknown> & { id: string; name: string;
  parent_folder_id: string | null };
type LibraryPageItem =
  | { kind: "folder"; folder: LibraryFolder }
  | { kind: "document"; document: LibraryDocument };
type LibraryPageOptions = { q: string; parentFolderId: string | null; limit: number;
  after: [number, string, string] | null; documentsOnly?: boolean };
type LibraryPage = { items: LibraryPageItem[]; nextAfter: [number, string, string] | null };
type LibraryRepositoryPage = Omit<LibraryPage, "items"> & {
  items: Array<{ kind: "folder"; folder: LibraryFolder } |
    { kind: "document"; id: string }>;
};

export type LibraryRepository = {
  page(scope: LibraryScope, options: LibraryPageOptions): Promise<LibraryRepositoryPage>;
  folder(scope: LibraryScope, folderId: string): Promise<LibraryFolder | null>;
  createFolder(scope: LibraryScope, name: string, parentFolderId: string | null): Promise<LibraryFolder | null>;
  updateFolder(scope: LibraryScope, folderId: string, update: { name?: string;
    parentFolderId?: string | null }): Promise<LibraryFolder | null>;
  folderDocumentIds(scope: LibraryScope, folderId: string): Promise<string[] | null>;
  deleteFolder(scope: LibraryScope, folderId: string): Promise<boolean>;
};

export type LibraryStore = Pick<LibraryRepository, "createFolder" |
  "updateFolder" | "deleteFolder"> & {
  page(scope: LibraryScope, options: LibraryPageOptions): Promise<LibraryPage>;
  document(scope: LibraryScope, id: string): Promise<LibraryDocument | null>;
  moveDocument(scope: LibraryScope, id: string, folderId: string | null): Promise<LibraryDocument | null>;
  updateDocument(scope: LibraryScope, id: string, update: { filename: unknown;
    metadata?: unknown; notes?: string | null }): Promise<LibraryDocument | null>;
};

const isLibraryDocument = (scope: LibraryScope, document: DocumentRecord | null) =>
  document?.project_id === null && document.library_kind === scope.kind
    ? document : null;

export function createLibraryStore(
  repository: LibraryRepository,
  documents: DocumentStore,
): LibraryStore {
  const folder = async (scope: LibraryScope, id: string, detail = "Folder not found") =>
    await repository.folder(scope, id) ??
      Promise.reject(new ApplicationError(404, detail));
  const document = async (scope: LibraryScope, id: string) =>
    isLibraryDocument(scope, await documents.metadata(scope, id, true));

  return {
    async page(scope, options) {
      const page = await repository.page(scope, options);
      const items = await Promise.all(page.items.map(async (item) => item.kind === "folder"
        ? item : { kind: "document" as const,
          document: await documents.metadata(scope, item.id) }));
      return { ...page, items: items.flatMap((item) =>
        item.kind === "document" && !isLibraryDocument(scope, item.document)
          ? [] : [item as LibraryPageItem]) };
    },
    async createFolder(scope, name, parentId) {
      if (parentId) await folder(scope, parentId, "Parent folder not found");
      return repository.createFolder(scope, name, parentId);
    },
    async updateFolder(scope, id, update) {
      if (!await repository.folder(scope, id)) return null;
      if (update.parentFolderId !== undefined) await validateFolderMove(
        id, update.parentFolderId, (parent) => folder(scope, parent, "Parent folder not found"),
        (cycle) => cycle ? new Error("Folder hierarchy contains a cycle")
          : new ApplicationError(400, "Cannot move a folder into itself or a descendant"));
      return repository.updateFolder(scope, id, update);
    },
    async deleteFolder(scope, id) {
      if (!await repository.folder(scope, id)) return false;
      const ids = await repository.folderDocumentIds(scope, id);
      if (!ids) return false;
      await deleteFolderDocuments(ids, (documentId) => documents.deleteDocument(scope, documentId));
      return repository.deleteFolder(scope, id);
    },
    document,
    async moveDocument(scope, id, folderId) {
      if (!await document(scope, id)) return null;
      if (folderId) await folder(scope, folderId, "Parent folder not found");
      const moved = await documents.relocate(scope, id, {
        expectedProjectId: null, projectId: null, folderId, owner: true,
      });
      if (moved.status === "conflict") throw new ApplicationError(
        409, "Document moved concurrently");
      return moved.status === "moved" ? isLibraryDocument(scope, moved.document) : null;
    },
    async updateDocument(scope, id, update) {
      const current = await document(scope, id);
      if (!current?.current_version_id) return null;
      const currentName = typeof current.filename === "string" && current.filename.trim()
        ? current.filename : "Untitled document";
      const filename = normalizeDocumentFilename(update.filename, currentName);
      if (!filename) throw new ApplicationError(400, "filename is required");
      if (!await documents.renameVersion(scope, id, current.current_version_id, filename)) {
        return null;
      }
      return isLibraryDocument(scope, await documents.updateMetadata(scope, id, {
        ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
        ...(update.notes !== undefined ? { notes: update.notes } : {}),
      }));
    },
  };
}
