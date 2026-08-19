import { cloudData, cloudScope, type CloudScope } from "./access";
import type {
  ProjectFolder,
  ProjectRecord,
  ProjectRepository,
} from "./projectStore";
import { findMissingUserEmails, loadProfileUsersByEmail } from "./userLookup";

const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation: string) =>
  cloudData<T>(operation, query);

async function folder(scope: CloudScope, projectId: string, folderId: string) {
  if (!await scope.project(projectId)) return null;
  return await run(scope.db.from("project_subfolders").select("*")
    .eq("id", folderId).eq("project_id", projectId).maybeSingle(),
  "Failed to load project folder") as ProjectFolder | null;
}

export const postgresProjectRepository: ProjectRepository = {
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

  async missingRecipient(identity, emails) {
    return (await findMissingUserEmails(cloudScope(identity).db, emails))[0] ?? null;
  },

  async create(identity, input) {
    const scope = cloudScope(identity);
    const data = await run(scope.db.from("projects").insert({
      user_id: scope.userId,
      name: input.name,
      cm_number: input.cmNumber,
      practice: input.practice,
      shared_with: input.sharedWith,
      metadata: input.metadata ?? {},
      notes: input.notes ?? null,
    }).select("*").single(), "Failed to create project");
    if (!data) throw new Error("Failed to create project");
    return data as ProjectRecord;
  },

  async directory(identity, projectId, options) {
    const scope = cloudScope(identity);
    if (!await scope.project(projectId)) return { items: [], nextAfter: null };
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
      ? { kind: "folder" as const, folder: row.payload as ProjectFolder }
      : { kind: "document" as const, id: row.id }),
    nextAfter: rows.length > options.limit && last
      ? [last.bucket, last.sort_name, last.id] : null };
  },

  async project(identity, projectId, owner) {
    const access = await cloudScope(identity).project(projectId, owner);
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
    const values: Record<string, unknown> = { updated_at: new Date().toISOString(),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.cmNumber !== undefined ? { cm_number: input.cmNumber } : {}),
      ...(input.practice !== undefined ? { practice: input.practice } : {}),
      ...(input.sharedWith !== undefined ? { shared_with: input.sharedWith } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}) };
    return await run(scope.db.from("projects").update(values).eq("id", projectId)
      .eq("user_id", scope.userId).select("*").maybeSingle(),
    "Failed to update project") as ProjectRecord | null;
  },

  async remove(identity, projectId) {
    const scope = cloudScope(identity);
    if (!await scope.project(projectId, true)) return null;
    const chats = await run(scope.db.from("chats").select("id").eq("project_id", projectId),
      "Failed to load project chats") ?? [];
    const removed = await run(scope.db.from("projects").delete().eq("id", projectId)
      .eq("user_id", scope.userId).select("id").maybeSingle(),
    "Failed to delete project");
    return removed ? chats.map(({ id }: { id: string }) => id) : null;
  },

  folder: (identity, projectId, folderId) =>
    folder(cloudScope(identity), projectId, folderId),

  async createFolder(identity, projectId, input) {
    const scope = cloudScope(identity);
    if (!await scope.project(projectId)) return null;
    return await run(scope.db.from("project_subfolders").insert({
      project_id: projectId, user_id: scope.userId, name: input.name,
      parent_folder_id: input.parentFolderId,
    }).select("*").single(), "Failed to create project folder") as ProjectFolder | null;
  },

  async updateFolder(identity, projectId, folderId, input) {
    const scope = cloudScope(identity);
    if (!await scope.project(projectId)) return null;
    const values = { updated_at: new Date().toISOString(),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parentFolderId !== undefined
        ? { parent_folder_id: input.parentFolderId } : {}) };
    return await run(scope.db.from("project_subfolders").update(values)
      .eq("id", folderId).eq("project_id", projectId).select("*").maybeSingle(),
    "Failed to update project folder") as ProjectFolder | null;
  },

  async folderDocumentIds(identity, projectId, folderId) {
    const scope = cloudScope(identity);
    if (!await scope.project(projectId) || !await folder(scope, projectId, folderId)) return null;
    const rows = await run(scope.db.rpc("get_project_folder_document_ids", {
      p_project_id: projectId, p_folder_id: folderId,
    }), "Failed to load project folder documents");
    return (rows ?? []).map(({ id }: { id: string }) => id);
  },

  async deleteFolder(identity, projectId, folderId) {
    const scope = cloudScope(identity);
    if (!await scope.project(projectId)) return false;
    return !!await run(scope.db.from("project_subfolders").delete()
      .eq("id", folderId).eq("project_id", projectId).select("id").maybeSingle(),
    "Failed to delete project folder");
  },

};
