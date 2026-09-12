import type { DocumentRecord, DocumentStore, LegalPdfOcrProvider } from "./documentStore";
import { normalizeDocumentFilename, type LibraryKind } from "./normalize";
import { validateFolderMove } from "./folderApplication";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { deterministicUuid } from "./hash";
import { enqueuePdfReprocess } from "./pdfJobs";

export type LibraryScope = ApplicationScope & { kind: LibraryKind };
export type LibraryFolder = Record<string, unknown> & { id: string; name: string;
  parent_folder_id: string | null };
export type LibraryPageItem =
  | { kind: "folder"; folder: LibraryFolder }
  | { kind: "document"; document: DocumentRecord };
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
  document(scope: LibraryScope, id: string): Promise<DocumentRecord | null>;
  reprocessPdf(scope: LibraryScope, id: string, input: { versionId: string | null;
    ocrProvider?: LegalPdfOcrProvider; layout?: boolean | null }): Promise<{ id: string; status: string }>;
  moveDocument(scope: LibraryScope, id: string, folderId: string | null): Promise<DocumentRecord | null>;
  updateDocument(scope: LibraryScope, id: string, update: { filename: unknown;
    metadata?: unknown; notes?: string | null }): Promise<DocumentRecord | null>;
};

/** Every file of one library, deepest folders included, each carrying the folder path it sits in today. */
export async function libraryDocuments(library: LibraryStore, scope: LibraryScope) {
  const queue: Array<{ id: string | null; path: string }> = [{ id: null, path: "" }],
    documents: Array<DocumentRecord & { folder_path?: string }> = [];
  for (const parent of queue) {
    let after: [number, string, string] | null = null;
    do {
      const page = await library.page(scope, { q: "", parentFolderId: parent.id, limit: 100, after });
      for (const item of page.items) {
        if (item.kind === "folder") queue.push({ id: item.folder.id,
          path: [parent.path, item.folder.name.trim()].filter(Boolean).join(" / ") });
        else documents.push({ ...item.document, ...(parent.path ? { folder_path: parent.path } : {}) });
      }
      after = page.nextAfter;
    } while (after);
  }
  return documents;
}

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
      const found = new Map((await documents.metadataMany(scope, page.items.flatMap((item) =>
        item.kind === "document" ? [item.id] : []))).map((document) => [document.id, document]));
      return { ...page, items: page.items.flatMap((item): LibraryPageItem[] => {
        if (item.kind === "folder") return [item];
        const document = isLibraryDocument(scope, found.get(item.id) ?? null);
        return document ? [{ kind: "document", document }] : [];
      }) };
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
    async reprocessPdf(scope, id, { versionId, ocrProvider, layout }) {
      const current = await documents.metadata(scope, id);
      if (!current || current.library_kind !== scope.kind)
        throw new ApplicationError(404, "Document not found");
      const source = await documents.projectionSource(scope, id, versionId);
      if (!source) throw new ApplicationError(404, "Version not found");
      if (source.fileType !== "pdf") throw new ApplicationError(409, "Version is not a PDF");
      try {
        const job = await enqueuePdfReprocess({ userId: scope.userId, documentId: id,
          versionId: source.versionId, sourceSha256: source.sourceSha256,
          ...(ocrProvider ? { ocrProvider } : {}), ...(layout !== undefined ? { layout } : {}) });
        return { id: job.id, status: job.status };
      } catch (error) {
        if (layout !== undefined) throw new ApplicationError(503,
          "PDF layout analysis could not start. Check the local runtime and model files.");
        if (!ocrProvider) throw error;
        const message = error instanceof Error ? error.message : "";
        throw new ApplicationError(503, ocrProvider === "tesseract" && message.startsWith("Tesseract was not found")
          ? "Tesseract was not found. Install it or configure its executable."
          : ocrProvider === "tesseract"
            ? "OCR could not start. Check the local Tesseract installation and retry."
            : "OCR could not start. Check the local Kraken-lite runtime and retry.");
      }
    },
    async moveDocument(scope, id, folderId) {
      const current = await document(scope, id);
      if (!current) return null;
      const moved = await documents.relocate(scope, id, {
        expectedProjectId: null,
        expectedFolderId: current.folder_id,
        projectId: null, folderId, owner: true,
      });
      if (moved.status === "conflict") throw new ApplicationError(
        409, "Document moved concurrently");
      return moved.status === "moved" ? isLibraryDocument(scope, moved.document) : null;
    },
    async updateDocument(scope, id, update) {
      const current = await document(scope, id);
      if (!current) return null;
      const filename = normalizeDocumentFilename(update.filename, current.filename);
      if (!filename) throw new ApplicationError(400, "filename is required");
      const renamed = await documents.renameVersion(scope, id, current.current_version_id,
        filename, current.current_working_revision);
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
