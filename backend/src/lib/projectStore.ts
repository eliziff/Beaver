import type { DocumentRecord, DocumentStore } from "./documentStore";
import { abortChatTurnForDeletion } from "./chatTurns";
import { normalizeDocumentFilename } from "./normalize";
import { validateFolderMove } from "./folderApplication";
import { ApplicationError, notFound as missing, type ApplicationScope } from "./applicationError";
import { deterministicUuid } from "./hash";

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
export type ProjectDirectoryItem = { kind: "folder"; folder: ProjectFolder }
  | { kind: "document"; document: DocumentRecord };
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
    name: string; parentFolderId: string | null; stableId?: string;
  }): Promise<ProjectFolder | null>;
  updateFolder(scope: ProjectScope, projectId: string, folderId: string, input: {
    name?: string; parentFolderId?: string | null }): Promise<ProjectFolder | null>;
  deleteFolder(scope: ProjectScope, projectId: string, folderId: string): Promise<boolean>;
};

export type ProjectStore = {
  page: ProjectRepository["page"];
  create: ProjectRepository["create"];
  directory(scope: ProjectScope, projectId: string, options: ProjectDirectoryOptions): Promise<ProjectPage<ProjectDirectoryItem, [number, string, string]>>;
  get(scope: ProjectScope, id: string): Promise<ProjectRecord | null>;
  people: ProjectRepository["people"];
  update: ProjectRepository["update"];
  delete(scope: ProjectScope, id: string): Promise<boolean>;
  deleteAll(scope: ProjectScope): Promise<number>;
  detachDocument(scope: ProjectScope, projectId: string, id: string): Promise<boolean>;
  attachDocument(scope: ProjectScope, projectId: string, id: string):
    Promise<{ document: DocumentRecord; created: boolean }>;
  renameDocument(scope: ProjectScope, projectId: string, id: string,
    filename: unknown): Promise<DocumentRecord>;
  getFolder: ProjectRepository["folder"];
  createFolder: ProjectRepository["createFolder"];
  ensureRootFolder(scope: ProjectScope, projectId: string, name: string,
    key: string): Promise<ProjectFolder>;
  updateFolder: ProjectRepository["updateFolder"];
  deleteFolder(scope: ProjectScope, projectId: string, id: string): Promise<void>;
  moveDocument(scope: ProjectScope, projectId: string, id: string,
    folderId: string | null): Promise<DocumentRecord>;
};

export async function projectDocuments(projects: ProjectStore, scope: ApplicationScope,
  projectId: string) {
  if (!await projects.get(scope, projectId)) return null;
  const queue: Array<{ id: string | null; path: string }> = [{ id: null, path: "" }],
    documents: Array<DocumentRecord & { folder_path?: string }> = [];
  for (const parent of queue) {
    let after: [number, string, string] | null = null;
    do {
      const page = await projects.directory(scope, projectId, {
        q: "", parentFolderId: parent.id, limit: 100, after,
      });
      for (const row of page.items) {
        if (row.kind === "folder") queue.push({ id: row.folder.id,
          path: [parent.path, row.folder.name.trim()].filter(Boolean).join(" / ") });
        else documents.push({ ...row.document,
          ...(parent.path ? { folder_path: parent.path } : {}) });
      }
      after = page.nextAfter;
    } while (after);
  }
  return documents;
}

export function createProjectStore(
  repository: ProjectRepository,
  documents: DocumentStore,
  cancel?: (scope: ProjectScope, chatId: string) => Promise<unknown>,
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
    const chatIds = await repository.remove(scope, projectId);
    chatIds?.forEach(abortChatTurnForDeletion);
    if (chatIds && cancel) await Promise.all(chatIds.map((id) => cancel(scope, id)));
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
      const found = new Map((await documents.metadataMany(scope, page.items.flatMap((item) =>
        item.kind === "document" ? [item.id] : []))).map((document) => [document.id, document]));
      return { ...page, items: page.items.flatMap((item): ProjectDirectoryItem[] => {
        if (item.kind === "folder") return [item];
        const document = found.get(item.id);
        return document?.project_id === projectId ? [{ kind: "document", document }] : [];
      }) };
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
        expectedProjectId: projectId,
        expectedFolderId: document.folder_id,
        projectId: null, folderId: null, owner: true,
      })).status === "moved";
    },
    async attachDocument(scope, projectId, documentId) {
      await project(scope, projectId);
      const source = await documents.metadata(scope, documentId, true);
      if (!source) throw missing("Document not found");
      if (source.project_id === projectId) return { document: source, created: false };
      if (source.project_id === null) {
        const assigned = await documents.relocate(scope, documentId, {
          expectedProjectId: null,
          expectedFolderId: source.folder_id,
          projectId, folderId: null, owner: true,
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
      const filename = normalizeDocumentFilename(requested, current.filename);
      if (!filename) throw new ApplicationError(400, "filename is required");
      const renamed = await documents.renameVersion(
        scope, documentId, current.current_version_id, filename, current.current_working_revision,
      );
      if (!renamed) throw missing("Document not found");
      return { ...current, filename, current_working_revision: renamed.working_revision };
    },
    getFolder: (scope, projectId, folderId) =>
      repository.folder(scope, projectId, folderId),
    async createFolder(scope, projectId, input) {
      if (input.parentFolderId) {
        await folder(scope, projectId, input.parentFolderId, "Parent folder not found");
      }
      return await repository.createFolder(scope, projectId, input)
        ?? Promise.reject(missing("Parent folder not found"));
    },
    async ensureRootFolder(scope, projectId, name, key) {
      return await repository.createFolder(scope, projectId, { name, parentFolderId: null,
        stableId: deterministicUuid(`workflow-folder\0project\0${projectId}\0${key}`) })
        ?? Promise.reject(missing("Project not found"));
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
      if (!await repository.deleteFolder(scope, projectId, folderId)) {
        throw missing("Folder not found");
      }
    },
    async moveDocument(scope, projectId, documentId, folderId) {
      const document = await documents.metadata(scope, documentId);
      if (!document || document.project_id !== projectId) throw missing("Document not found");
      const moved = await documents.relocate(scope, documentId, {
        expectedProjectId: projectId,
        expectedFolderId: document.folder_id,
        projectId, folderId, owner: false,
      });
      if (moved.status === "conflict") throw new ApplicationError(
        409, "Document moved concurrently");
      return moved.status === "moved"
        ? moved.document : Promise.reject(missing("Document not found"));
    },
  };
}
