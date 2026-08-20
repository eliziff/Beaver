import type { DocumentStore } from "./documentStore";
import { abortChatTurnForDeletion } from "./chatTurns";
import { normalizeDocumentFilename } from "./normalize";
import { deleteFolderDocuments, validateFolderMove } from "./folderApplication";
import { ApplicationError, notFound as missing, type ApplicationScope } from "./applicationError";

export type ProjectScope = ApplicationScope;
export type ProjectRecord = Record<string, unknown> & { id: string };
export type ProjectFolder = ProjectRecord & { name: string; parent_folder_id: string | null };
type ProjectPage<T, C extends unknown[]> = { items: T[]; nextAfter: C | null };
type ProjectListOptions = { q: string; scope: "all" | "mine" | "shared-with-me";
  limit: number; after: [string, string] | null };
type ProjectDirectoryOptions = { q: string; parentFolderId: string | null;
  limit: number; after: [number, string, string] | null };
type ProjectDirectoryPage = ProjectPage<
  { kind: "folder"; folder: ProjectFolder } | { kind: "document"; id: string },
  [number, string, string]
>;
type ProjectInput = { name: string; cmNumber: string | null; practice: string | null;
  sharedWith: string[]; metadata?: Record<string, unknown>; notes?: string | null };
type ProjectUpdate = Partial<ProjectInput>;
type ProjectPeople = { owner: { user_id: string; email: string | null;
  display_name: string | null }; members: { email: string; display_name: string | null }[] };

export type ProjectRepository = {
  page(scope: ProjectScope, options: ProjectListOptions): Promise<ProjectPage<ProjectRecord, [string, string]>>;
  missingRecipient(scope: ProjectScope, emails: string[]): Promise<string | null>;
  create(scope: ProjectScope, input: ProjectInput): Promise<ProjectRecord>;
  directory(scope: ProjectScope, projectId: string, options: ProjectDirectoryOptions): Promise<ProjectDirectoryPage>;
  project(scope: ProjectScope, projectId: string, owner: boolean): Promise<ProjectRecord | null>;
  people(scope: ProjectScope, projectId: string): Promise<ProjectPeople | null>;
  update(scope: ProjectScope, projectId: string, input: ProjectUpdate): Promise<ProjectRecord | null>;
  remove(scope: ProjectScope, projectId: string): Promise<string[] | null>;
  folder(scope: ProjectScope, projectId: string, folderId: string): Promise<ProjectFolder | null>;
  createFolder(scope: ProjectScope, projectId: string, input: {
    name: string; parentFolderId: string | null;
  }): Promise<ProjectFolder | null>;
  updateFolder(scope: ProjectScope, projectId: string, folderId: string, input: {
    name?: string; parentFolderId?: string | null }): Promise<ProjectFolder | null>;
  folderDocumentIds(scope: ProjectScope, projectId: string, folderId: string): Promise<string[] | null>;
  deleteFolder(scope: ProjectScope, projectId: string, folderId: string): Promise<boolean>;
};

export type ProjectStore = {
  page: ProjectRepository["page"];
  create: ProjectRepository["create"];
  directory(scope: ProjectScope, projectId: string, options: ProjectDirectoryOptions): Promise<ProjectPage<Record<string, unknown>, [number, string, string]>>;
  get(scope: ProjectScope, id: string): Promise<ProjectRecord | null>;
  people: ProjectRepository["people"];
  update: ProjectRepository["update"];
  delete(scope: ProjectScope, id: string): Promise<boolean>;
  deleteAll(scope: ProjectScope): Promise<number>;
  detachDocument(scope: ProjectScope, projectId: string, id: string): Promise<boolean>;
  attachDocument(scope: ProjectScope, projectId: string, id: string):
    Promise<{ document: ProjectRecord; created: boolean }>;
  renameDocument(scope: ProjectScope, projectId: string, id: string,
    filename: unknown): Promise<ProjectRecord>;
  createFolder: ProjectRepository["createFolder"];
  updateFolder: ProjectRepository["updateFolder"];
  deleteFolder(scope: ProjectScope, projectId: string, id: string): Promise<void>;
  moveDocument(scope: ProjectScope, projectId: string, id: string,
    folderId: string | null): Promise<ProjectRecord>;
};

export function createProjectStore(
  repository: ProjectRepository,
  documents: DocumentStore,
): ProjectStore {
  const project = async (scope: ProjectScope, projectId: string, owner = false) =>
    await repository.project(scope, projectId, owner) ?? Promise.reject(missing("Project not found"));
  const folder = async (scope: ProjectScope, projectId: string, folderId: string,
    detail = "Folder not found") =>
    await repository.folder(scope, projectId, folderId) ?? Promise.reject(missing(detail));
  const recipients = async (scope: ProjectScope, emails: string[]) => {
    const email = await repository.missingRecipient(scope, emails);
    if (email) throw new ApplicationError(400, `${email} does not belong to a Beaver user.`);
  };
  const remove = async (scope: ProjectScope, projectId: string) => {
    if (!await repository.project(scope, projectId, true)) return false;
    await documents.deleteUserDocuments(scope, {
      projectIds: [projectId], includeOwned: false, purgeObjects: false,
    });
    const chatIds = await repository.remove(scope, projectId);
    chatIds?.forEach(abortChatTurnForDeletion);
    return !!chatIds;
  };

  return {
    page: (scope, options) => repository.page(scope, options),
    async create(scope, input) {
      await recipients(scope, input.sharedWith);
      return repository.create(scope, input);
    },
    async directory(scope, projectId, options) {
      await project(scope, projectId);
      const page = await repository.directory(scope, projectId, options);
      const items = await Promise.all(page.items.map(async (item) => item.kind === "folder"
        ? item : { kind: "document" as const,
          document: await documents.metadata(scope, item.id) }));
      return { ...page, items: items.flatMap((item) => item.kind === "document" &&
        item.document?.project_id !== projectId ? [] : [item as Record<string, unknown>]) };
    },
    get: (scope, projectId) => repository.project(scope, projectId, false),
    people: (scope, projectId) => repository.people(scope, projectId),
    async update(scope, projectId, input) {
      if (input.sharedWith) await recipients(scope, input.sharedWith);
      return repository.update(scope, projectId, input);
    },
    delete: remove,
    async deleteAll(scope) {
      let count = 0;
      while (true) {
        const page = await repository.page(scope, {
          q: "", scope: "mine", limit: 100, after: null,
        });
        if (!page.items.length) return count;
        let removed = 0;
        for (const item of page.items) if (await remove(scope, item.id)) { count++; removed++; }
        if (!removed) return count;
      }
    },
    async detachDocument(scope, projectId, documentId) {
      const document = await documents.metadata(scope, documentId, true);
      if (document?.project_id !== projectId) return false;
      return (await documents.relocate(scope, documentId, {
        expectedProjectId: projectId, projectId: null, folderId: null, owner: true,
      })).status === "moved";
    },
    async attachDocument(scope, projectId, documentId) {
      await project(scope, projectId);
      const source = await documents.metadata(scope, documentId, true);
      if (!source) throw missing("Document not found");
      if (source.project_id === projectId) return { document: source, created: false };
      if (source.project_id === null) {
        const assigned = await documents.relocate(scope, documentId, {
          expectedProjectId: null, projectId, folderId: null, owner: true,
        });
        if (assigned.status === "conflict") throw new ApplicationError(
          409, "Document moved concurrently");
        if (assigned.status !== "moved") throw missing("Document not found");
        return { document: assigned.document, created: false };
      }
      const content = await documents.read(scope, documentId, null, false);
      if (!content) throw missing("Source document has no active version");
      const copy = await documents.create(scope, {
        projectId,
        filename: content.filename,
        fileType: content.fileType,
        bytes: content.bytes,
      });
      return { document: copy, created: true };
    },
    async renameDocument(scope, projectId, documentId, requested) {
      const current = await documents.metadata(scope, documentId);
      if (!current || current.project_id !== projectId) throw missing("Document not found");
      const currentName = typeof current.filename === "string" && current.filename.trim()
        ? current.filename : "Untitled document";
      const filename = normalizeDocumentFilename(requested, currentName);
      if (!filename) throw new ApplicationError(400, "filename is required");
      const versionId = current.current_version_id;
      if (!versionId || !await documents.renameVersion(
        scope, documentId, versionId, filename,
      )) throw missing("Document not found");
      return { ...current, filename };
    },
    async createFolder(scope, projectId, input) {
      if (input.parentFolderId) {
        await folder(scope, projectId, input.parentFolderId, "Parent folder not found");
      }
      return await repository.createFolder(scope, projectId, input)
        ?? Promise.reject(missing("Parent folder not found"));
    },
    async updateFolder(scope, projectId, folderId, input) {
      await folder(scope, projectId, folderId);
      if (input.parentFolderId !== undefined) await validateFolderMove(
        folderId, input.parentFolderId,
        (id) => folder(scope, projectId, id, "Parent folder not found"),
        (cycle) => new ApplicationError(cycle ? 500 : 400, cycle
          ? "Folder hierarchy contains a cycle"
          : "Cannot move a folder into itself or a descendant"));
      return await repository.updateFolder(scope, projectId, folderId, input)
        ?? Promise.reject(missing("Folder not found"));
    },
    async deleteFolder(scope, projectId, folderId) {
      const ids = await repository.folderDocumentIds(scope, projectId, folderId);
      if (!ids) throw missing("Folder not found");
      await deleteFolderDocuments(ids, (id) => documents.deleteDocument(scope, id));
      if (!await repository.deleteFolder(scope, projectId, folderId)) {
        throw missing("Folder not found");
      }
    },
    async moveDocument(scope, projectId, documentId, folderId) {
      const document = await documents.metadata(scope, documentId);
      if (!document || document.project_id !== projectId) throw missing("Document not found");
      if (folderId) await folder(scope, projectId, folderId);
      const moved = await documents.relocate(scope, documentId, {
        expectedProjectId: projectId, projectId, folderId, owner: false,
      });
      if (moved.status === "conflict") throw new ApplicationError(
        409, "Document moved concurrently");
      return moved.status === "moved"
        ? moved.document : Promise.reject(missing("Document not found"));
    },
  };
}
