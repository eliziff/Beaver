import type { DocumentRecord, DocumentStore } from "./documentStore";
import { normalizeDocumentFilename, type LibraryKind } from "./normalize";
import { validateFolderMove } from "./folderApplication";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { deterministicUuid } from "./hash";

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
  createFolder(scope: LibraryScope, name: string, parentFolderId: string | null,
    stableId?: string): Promise<LibraryFolder | null>;
  updateFolder(scope: LibraryScope, folderId: string, update: { name?: string;
    parentFolderId?: string | null }): Promise<LibraryFolder | null>;
  deleteFolder(scope: LibraryScope, folderId: string): Promise<boolean>;
};

export type LibraryStore = Pick<LibraryRepository, "folder" | "createFolder" |
  "updateFolder" | "deleteFolder"> & {
  ensureRootFolder(scope: LibraryScope, name: string, key: string): Promise<LibraryFolder>;
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
    folder: (scope, id) => repository.folder(scope, id),
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
    async ensureRootFolder(scope, name, key) {
      return await repository.createFolder(scope, name, null, deterministicUuid(
        `workflow-folder\0library\0${scope.userId}\0${scope.kind}\0${key}`,
      )) ?? Promise.reject(new ApplicationError(404, "Folder not found"));
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
      return repository.deleteFolder(scope, id);
    },
    document,
    async moveDocument(scope, id, folderId) {
      const current = await document(scope, id);
      if (!current) return null;
      const moved = await documents.relocate(scope, id, {
        expectedProjectId: null,
        expectedFolderId: typeof current.folder_id === "string" ? current.folder_id : null,
        projectId: null, folderId, owner: true,
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
      const renamed = await documents.renameVersion(scope, id, current.current_version_id,
        filename, Number(current.current_working_revision));
      if (!renamed) return null;
      if (update.metadata === undefined && update.notes === undefined) return isLibraryDocument(
        scope, { ...current, filename, current_working_revision: renamed.working_revision });
      return isLibraryDocument(scope, await documents.updateMetadata(scope, id, {
        ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
        ...(update.notes !== undefined ? { notes: update.notes } : {}),
      }));
    },
  };
}
