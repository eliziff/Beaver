import { cloudData, cloudScope, type CloudScope } from "./access";
import { cloudDocuments } from "./cloudDocumentStore";
import { attachActiveVersionPaths } from "./documentVersions";
import { normalizeDocumentFilename } from "./normalize";
import {
  ProjectStoreError, type ProjectRecord, type ProjectStore,
} from "./projectStore";
import { deleteFile } from "./storage";
import { deleteUserProjects } from "./userDataCleanup";
import { findMissingUserEmails, loadProfileUsersByEmail } from "./userLookup";

const missing = (detail: string) => new ProjectStoreError(404, detail);
const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation: string) =>
  cloudData<T>(operation, query);

async function requireProject(scope: CloudScope, projectId: string, owner = false) {
  const access = await scope.project(projectId, owner);
  if (!access) throw missing("Project not found");
  return access;
}

async function validateRecipients(scope: CloudScope, emails: string[]) {
  const [missingEmail] = await findMissingUserEmails(scope.db, emails);
  if (missingEmail) throw new ProjectStoreError(
    400, `${missingEmail} does not belong to a Beaver user.`);
}

async function folder(scope: CloudScope, projectId: string, folderId: string) {
  return await run(scope.db.from("project_subfolders").select("id, parent_folder_id")
    .eq("id", folderId).eq("project_id", projectId).maybeSingle(),
  "Failed to load project folder") as { id: string; parent_folder_id: string | null } | null;
}

async function deleteDocuments(scope: CloudScope, projectId: string, ids: string[]) {
  if (!ids.length) return;
  const versions = await run(scope.db.from("document_versions")
    .select("storage_path, pdf_storage_path").in("document_id", ids),
  "Failed to load project document files");
  const paths = new Set<string>((versions ?? []).flatMap((version) =>
    [version.storage_path, version.pdf_storage_path].filter((path): path is string => !!path)));
  await run(scope.db.from("documents").delete().eq("project_id", projectId).in("id", ids),
    "Failed to delete project documents");
  await Promise.all([...paths].map((path) => deleteFile(path).catch(() => {})));
}

export const cloudProjects = {
  async page(identity, options) {
    const scope = cloudScope(identity);
    const rows = (await run(scope.db.rpc("get_collection_page", {
      p_resource: "projects", p_user_id: scope.userId,
      p_user_email: scope.userEmail || null, p_q: options.q, p_filter: options.scope,
      p_after_created_at: options.after?.[0] ?? null,
      p_after_id: options.after?.[1] ?? null, p_limit: options.limit + 1,
    }), "Failed to load projects") ?? []) as {
      payload: ProjectRecord; id: string; created_at: string;
    }[];
    const items = rows.slice(0, options.limit), last = items.at(-1);
    return { items: items.map(({ payload }) => payload),
      nextAfter: rows.length > options.limit && last
        ? [last.created_at, last.id] as [string, string] : null };
  },

  async create(identity, input) {
    const scope = cloudScope(identity);
    await validateRecipients(scope, input.sharedWith);
    const data = await run(scope.db.from("projects").insert({ user_id: scope.userId,
      name: input.name, cm_number: input.cmNumber, practice: input.practice,
      shared_with: input.sharedWith }).select("*").single(),
    "Failed to create project");
    if (!data) throw new Error("Failed to create project");
    return data as ProjectRecord;
  },

  async directory(identity, projectId, options) {
    const scope = cloudScope(identity);
    await requireProject(scope, projectId);
    const rows = (await run(scope.db.rpc("get_directory_page", {
      p_user_id: scope.userId, p_user_email: scope.userEmail || null,
      p_project_id: projectId, p_library_kind: null,
      p_parent_id: options.parentFolderId, p_q: options.q, p_documents_only: false,
      p_after_bucket: options.after?.[0] ?? null, p_after_name: options.after?.[1] ?? null,
      p_after_id: options.after?.[2] ?? null, p_limit: options.limit + 1,
    }), "Failed to load project directory") ?? []) as {
      kind: "folder" | "document"; id: string; bucket: number;
      sort_name: string; payload: Record<string, unknown>;
    }[];
    const page = rows.slice(0, options.limit), last = page.at(-1);
    return { items: page.map((row) => row.kind === "folder"
      ? { kind: "folder" as const, folder: row.payload }
      : { kind: "document" as const, document: row.payload }),
    nextAfter: rows.length > options.limit && last
      ? [last.bucket, last.sort_name, last.id] : null };
  },

  async get(identity, projectId) {
    const access = await cloudScope(identity).project(projectId);
    return access ? { ...access.row, is_owner: access.isOwner } as ProjectRecord : null;
  },

  async people(identity, projectId) {
    const scope = cloudScope(identity), access = await scope.project(projectId);
    if (!access) return null;
    const shared = (Array.isArray(access.row.shared_with)
      ? access.row.shared_with as string[] : []).map((value) => value.toLowerCase());
    const { userByEmail, userById } = await loadProfileUsersByEmail(scope.db);
    const owner = userById.get(access.row.user_id);
    return { owner: { user_id: access.row.user_id, email: owner?.email ?? null,
      display_name: owner?.display_name ?? null },
    members: shared.map((email) => ({ email,
      display_name: userByEmail.get(email)?.display_name ?? null })) };
  },

  async update(identity, projectId, input) {
    const scope = cloudScope(identity);
    if (!await scope.project(projectId, true)) return null;
    if (input.sharedWith) await validateRecipients(scope, input.sharedWith);
    const values: Record<string, unknown> = { updated_at: new Date().toISOString(),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.cmNumber !== undefined ? { cm_number: input.cmNumber } : {}),
      ...(input.practice !== undefined ? { practice: input.practice } : {}),
      ...(input.sharedWith !== undefined ? { shared_with: input.sharedWith } : {}) };
    return await run(scope.db.from("projects").update(values).eq("id", projectId)
      .eq("user_id", scope.userId).select("*").maybeSingle(),
    "Failed to update project") as ProjectRecord | null;
  },

  async delete(identity, projectId) {
    const scope = cloudScope(identity);
    if (!await scope.project(projectId, true)) return false;
    return (await deleteUserProjects(scope.db, scope.userId, [projectId])) > 0;
  },

  async detachDocument() { throw missing("Not found"); },

  async attachDocument(identity, projectId, documentId) {
    const scope = cloudScope(identity);
    await requireProject(scope, projectId);
    const access = await scope.document(documentId, true);
    if (!access) throw missing("Document not found");
    const source = access.row;
    if (source.project_id === projectId) {
      await attachActiveVersionPaths(scope.db, [source]);
      return { document: source as ProjectRecord, created: false };
    }
    if (source.project_id === null) {
      const data = await run(scope.db.from("documents").update({ project_id: projectId,
        library_folder_id: null, updated_at: new Date().toISOString() })
        .eq("id", documentId).eq("user_id", scope.userId).select("*").single(),
      "Failed to attach document");
      if (!data) throw new Error("Failed to attach document");
      await attachActiveVersionPaths(scope.db, [data]);
      return { document: data as ProjectRecord, created: false };
    }
    if (!source.current_version_id) throw missing("Source document has no active version");
    const copy = await run(scope.db.from("documents").insert({ project_id: projectId,
      user_id: scope.userId, status: source.status }).select("*").single(),
    "Failed to copy document");
    if (!copy) throw new Error("Failed to copy document");
    try {
      const copied = await cloudDocuments.copyVersion(identity, copy.id as string,
        documentId, undefined);
      if (copied.status !== "created") throw new Error("Source document has no active version");
      const document = { ...copy, current_version_id: copied.version.id };
      await attachActiveVersionPaths(scope.db, [document]);
      return { document: document as ProjectRecord, created: true };
    } catch (error) {
      await cloudDocuments.deleteDocument(identity, copy.id as string).catch(() => {});
      throw error;
    }
  },

  async renameDocument(identity, projectId, documentId, requested) {
    const scope = cloudScope(identity);
    await requireProject(scope, projectId);
    const access = await scope.document(documentId);
    if (!access || access.row.project_id !== projectId) throw missing("Document not found");
    const active = access.row.current_version_id
      ? await run(scope.db.from("document_versions").select("filename")
        .eq("id", access.row.current_version_id).eq("document_id", documentId).maybeSingle(),
      "Failed to load document name") : null;
    const filename = normalizeDocumentFilename(requested,
      typeof active?.filename === "string" ? active.filename : "Untitled document");
    if (!filename) throw new ProjectStoreError(400, "filename is required");
    if (access.row.current_version_id && !await cloudDocuments.renameVersion(
      identity, documentId, access.row.current_version_id as string, filename)) {
      throw missing("Document not found");
    }
    const updated = await run(scope.db.from("documents")
      .update({ updated_at: new Date().toISOString() }).eq("id", documentId)
      .eq("project_id", projectId).select("*").maybeSingle(), "Failed to rename document");
    if (!updated) throw missing("Document not found");
    return { ...updated, filename } as ProjectRecord;
  },

  async createFolder(identity, projectId, input) {
    const scope = cloudScope(identity);
    await requireProject(scope, projectId);
    if (input.parentFolderId && !await folder(scope, projectId, input.parentFolderId)) {
      throw missing("Parent folder not found");
    }
    const data = await run(scope.db.from("project_subfolders").insert({
      project_id: projectId, user_id: scope.userId, name: input.name,
      parent_folder_id: input.parentFolderId }).select("*").single(),
    "Failed to create project folder");
    if (!data) throw new Error("Failed to create folder");
    return data as ProjectRecord;
  },

  async updateFolder(identity, projectId, folderId, input) {
    const scope = cloudScope(identity);
    await requireProject(scope, projectId);
    const values: Record<string, unknown> = { updated_at: new Date().toISOString(),
      ...(input.name !== undefined ? { name: input.name } : {}) };
    if (input.parentFolderId !== undefined) {
      let parentId = input.parentFolderId;
      while (parentId) {
        if (parentId === folderId) throw new ProjectStoreError(
          400, "Cannot move a folder into itself or a descendant");
        const parent = await folder(scope, projectId, parentId);
        if (!parent) throw missing("Parent folder not found");
        parentId = parent.parent_folder_id;
      }
      values.parent_folder_id = input.parentFolderId;
    }
    const data = await run(scope.db.from("project_subfolders").update(values)
      .eq("id", folderId).eq("project_id", projectId).select("*").maybeSingle(),
    "Failed to update project folder");
    if (!data) throw missing("Folder not found");
    return data as ProjectRecord;
  },

  async deleteFolder(identity, projectId, folderId) {
    const scope = cloudScope(identity);
    await requireProject(scope, projectId);
    if (!await folder(scope, projectId, folderId)) throw missing("Folder not found");
    const data = await run(scope.db.rpc("get_project_folder_document_ids", {
      p_project_id: projectId, p_folder_id: folderId,
    }), "Failed to load project folder documents");
    await deleteDocuments(scope, projectId, (data ?? []).map((row: { id: string }) => row.id));
    await run(scope.db.from("project_subfolders").delete().eq("id", folderId)
      .eq("project_id", projectId), "Failed to delete project folder");
  },

  async moveDocument(identity, projectId, documentId, folderId) {
    const scope = cloudScope(identity);
    await requireProject(scope, projectId);
    const document = await scope.document(documentId);
    if (!document || document.row.project_id !== projectId) throw missing("Document not found");
    if (folderId && !await folder(scope, projectId, folderId)) throw missing("Folder not found");
    const data = await run(scope.db.from("documents").update({ folder_id: folderId,
      updated_at: new Date().toISOString() }).eq("id", documentId)
      .eq("project_id", projectId).select("*").maybeSingle(), "Failed to move document");
    if (!data) throw missing("Document not found");
    return data as ProjectRecord;
  },
} satisfies ProjectStore;
