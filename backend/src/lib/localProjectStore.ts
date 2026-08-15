import {
  listLocalDocumentsById,
  updateLocalDocument,
} from "./localDocumentStore";
import { legalKnowledgeGraphStore, type LocalMatter } from "./legalKnowledgeGraphStore";
import { localTabularStore } from "./localTabularStore";
import {
  deleteAnonymousProjectChats,
} from "./anonymousChatStore";
import { normalizeDocumentFilename } from "./normalize";
import {
  ProjectStoreError,
  type ProjectRecord,
  type ProjectStore,
} from "./projectStore";

const project = (userId: string, matter: LocalMatter): ProjectRecord => ({
  id: matter.id,
  user_id: userId,
  is_owner: true,
  owner_display_name: null,
  owner_email: null,
  name: matter.name,
  cm_number: matter.cm_number,
  practice: matter.practice,
  metadata: matter.metadata,
  notes: matter.notes,
  shared_with: [],
  created_at: matter.created_at,
  updated_at: matter.updated_at,
});
const missing = (detail: string) => new ProjectStoreError(404, detail);
const unsupportedFolders = () => new ProjectStoreError(
  409, "Folders are not available in account-free matters yet.");
const checked = <T>(action: () => T) => {
  try {
    return action();
  } catch (error) {
    if (error instanceof ProjectStoreError) throw error;
    throw new ProjectStoreError(
      400, error instanceof Error ? error.message : "Invalid project");
  }
};
const projectGraph = (userId: string, projectId: string) => {
  const graph = legalKnowledgeGraphStore();
  if (!graph.getMatter(userId, projectId)) throw missing("Project not found");
  return graph;
};

export const localProjects = {
  async page(scope, options) {
    const page = legalKnowledgeGraphStore().pageMatters(scope.userId, options);
    return {
      items: page.items.map((matter) => project(scope.userId, matter)),
      nextAfter: page.nextAfter,
    };
  },

  async create(scope, input) {
    if (input.sharedWith.length) {
      throw new ProjectStoreError(400, "Sharing requires an account");
    }
    return project(scope.userId, checked(() =>
      legalKnowledgeGraphStore().createMatter(
        scope.userId,
        {
          name: input.name,
          cmNumber: input.cmNumber,
          practice: input.practice,
          metadata: input.metadata,
          notes: input.notes,
        },
      ),
    ));
  },

  async directory(scope, projectId, options) {
    if (options.parentFolderId) return { items: [], nextAfter: null };
    const graph = projectGraph(scope.userId, projectId);
    const page = graph.pageMatterDocuments(scope.userId, projectId, options);
    const documents = new Map(
      (await listLocalDocumentsById(scope.userId, page.ids))
        .map((document) => [document.id, document] as const),
    );
    return {
      items: page.ids.flatMap((id) => {
        const document = documents.get(id);
        return document ? [{ kind: "document", document: {
          ...document, project_id: projectId, folder_id: null,
        } }] : [];
      }),
      nextAfter: page.nextAfter,
    };
  },

  async get(scope, projectId) {
    const matter = legalKnowledgeGraphStore().getMatter(scope.userId, projectId);
    return matter ? project(scope.userId, matter) : null;
  },

  async people(scope, projectId) {
    return legalKnowledgeGraphStore().getMatter(scope.userId, projectId)
      ? {
          owner: { user_id: scope.userId, email: null, display_name: null },
          members: [],
        }
      : null;
  },

  async update(scope, projectId, input) {
    if (input.sharedWith?.length) {
      throw new ProjectStoreError(400, "Sharing requires an account");
    }
    return checked(() => {
      const matter = legalKnowledgeGraphStore().updateMatter(
        scope.userId, projectId, input,
      );
      return matter ? project(scope.userId, matter) : null;
    });
  },

  async delete(scope, projectId) {
    return checked(() => {
      if (!legalKnowledgeGraphStore().deleteProject(scope.userId, projectId)) {
        return false;
      }
      localTabularStore().deleteProjectReviews(scope.userId, projectId);
      deleteAnonymousProjectChats(scope.userId, projectId);
      return true;
    });
  },

  async detachDocument(scope, projectId, documentId) {
    const graph = projectGraph(scope.userId, projectId);
    return graph.removeMatterDocument(scope.userId, projectId, documentId);
  },

  async attachDocument(scope, projectId, documentId) {
    const graph = projectGraph(scope.userId, projectId);
    const [document] = await listLocalDocumentsById(scope.userId, [documentId]);
    if (!document) throw missing("Document not found");
    if (!graph.attachMatterDocument(scope.userId, projectId, documentId)) {
      throw missing("Project not found");
    }
    return {
      document: { ...document, project_id: projectId, folder_id: null },
      created: false,
    };
  },

  async renameDocument(scope, projectId, documentId, requested) {
    const graph = projectGraph(scope.userId, projectId);
    if (!graph.hasMatterDocument(scope.userId, projectId, documentId)) {
      throw missing("Document not found");
    }
    const [current] = await listLocalDocumentsById(scope.userId, [documentId]);
    if (!current) throw missing("Document not found");
    const filename = normalizeDocumentFilename(requested, current.filename);
    if (!filename) throw new ProjectStoreError(400, "filename is required");
    const updated = await updateLocalDocument({
      userId: scope.userId,
      kind: current.library_kind,
      documentId,
      filename,
    });
    if (!updated) throw missing("Document not found");
    return { ...updated, project_id: projectId, folder_id: null };
  },

  async createFolder(scope, projectId) {
    projectGraph(scope.userId, projectId);
    throw unsupportedFolders();
  },
  async updateFolder(scope, projectId) {
    projectGraph(scope.userId, projectId);
    throw missing("Folder not found");
  },
  async deleteFolder(scope, projectId) {
    projectGraph(scope.userId, projectId);
    throw missing("Folder not found");
  },
  async moveDocument(scope, projectId, documentId, folderId) {
    if (folderId) throw unsupportedFolders();
    const graph = projectGraph(scope.userId, projectId);
    const [document] = await listLocalDocumentsById(scope.userId, [documentId]);
    if (!document || !graph.hasMatterDocument(scope.userId, projectId, documentId)) {
      throw missing("Document not found");
    }
    return { ...document, project_id: projectId, folder_id: null };
  },
} satisfies ProjectStore;
