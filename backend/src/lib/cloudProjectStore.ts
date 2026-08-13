import { checkProjectAccess } from "./access";
import { cloudDocuments, createCloudDocument } from "./cloudDocumentStore";
import { attachActiveVersionPaths } from "./documentVersions";
import { normalizeDocumentFilename } from "./normalize";
import {
  ProjectStoreError,
  type ProjectRecord,
  type ProjectScope,
  type ProjectStore,
} from "./projectStore";
import { deleteFile } from "./storage";
import { createServerSupabase } from "./supabase";
import { findMissingUserEmails, loadProfileUsersByEmail } from "./userLookup";
import { deleteUserProjects } from "./userDataCleanup";

type Db = ReturnType<typeof createServerSupabase>;
const missing = (detail: string) => new ProjectStoreError(404, detail);
const failed = (error: { message: string } | null, operation?: string) => {
  if (error) throw new Error(operation ? `${operation}: ${error.message}` : error.message);
};
const run = async <T>(operation: PromiseLike<{
  data: T;
  error: { message: string } | null;
}>) => {
  const { data, error } = await operation;
  failed(error);
  return data;
};
async function accessible(db: Db, scope: ProjectScope, projectId: string) {
  const access = await checkProjectAccess(
    projectId, scope.userId, scope.userEmail, db,
  );
  if (!access.ok) throw missing("Project not found");
}

async function displayNames(
  db: Db,
  rows: { user_id?: string | null }[],
) {
  const ids = [...new Set(rows.flatMap(({ user_id }) => user_id ? [user_id] : []))];
  if (!ids.length) return new Map<string, string>();
  const { data, error } = await db.from("user_profiles")
    .select("user_id, display_name").in("user_id", ids);
  if (error) console.warn("[projects] failed to load display names", error);
  return new Map((data ?? []).flatMap((row) =>
    typeof row.display_name === "string" && row.display_name.trim()
      ? [[row.user_id as string, row.display_name.trim()] as const]
      : []));
}

async function validateRecipients(db: Db, emails: string[]) {
  const [missingEmail] = await findMissingUserEmails(db, emails);
  if (missingEmail) {
    throw new ProjectStoreError(
      400, `${missingEmail} does not belong to a Beaver user.`,
    );
  }
}

async function folder(db: Db, projectId: string, folderId: string) {
  return await run(db.from("project_subfolders")
    .select("id, parent_folder_id").eq("id", folderId)
    .eq("project_id", projectId).maybeSingle()) as {
      id: string;
      parent_folder_id: string | null;
    } | null;
}

async function deleteDocuments(db: Db, projectId: string, ids: string[]) {
  if (!ids.length) return;
  const versions = await run(db
    .from("document_versions").select("storage_path, pdf_storage_path")
    .in("document_id", ids));
  const paths = new Set<string>((versions ?? []).flatMap((version) =>
    [version.storage_path, version.pdf_storage_path]
      .filter((path): path is string => !!path)));
  await run(db.from("documents").delete()
    .eq("project_id", projectId).in("id", ids));
  await Promise.all([...paths].map((path) => deleteFile(path).catch(() => {})));
}

export const cloudProjects = {
  async page(scope, options) {
    const rows = (await run(createServerSupabase().rpc("get_collection_page", {
      p_resource: "projects",
      p_user_id: scope.userId,
      p_user_email: scope.userEmail ?? null,
      p_q: options.q,
      p_filter: options.scope,
      p_after_created_at: options.after?.[0] ?? null,
      p_after_id: options.after?.[1] ?? null,
      p_limit: options.limit + 1,
    })) ?? []) as {
      payload: ProjectRecord;
      id: string;
      created_at: string;
    }[];
    const items = rows.slice(0, options.limit);
    const last = items.at(-1);
    return {
      items: items.map(({ payload }) => payload),
      nextAfter: rows.length > options.limit && last
        ? [last.created_at, last.id] as [string, string]
        : null,
    };
  },

  async create(scope, input) {
    const db = createServerSupabase();
    await validateRecipients(db, input.sharedWith);
    const data = await run(db.from("projects").insert({
      user_id: scope.userId,
      name: input.name,
      cm_number: input.cmNumber,
      practice: input.practice,
      shared_with: input.sharedWith,
    }).select("*").single());
    if (!data) throw new Error("Failed to create project");
    return data as ProjectRecord;
  },

  async directory(scope, projectId, options) {
    const rows = (await run(createServerSupabase().rpc("get_directory_page", {
      p_user_id: scope.userId,
      p_user_email: scope.userEmail ?? null,
      p_project_id: projectId,
      p_library_kind: null,
      p_parent_id: options.parentFolderId,
      p_q: options.q,
      p_documents_only: false,
      p_after_bucket: options.after?.[0] ?? null,
      p_after_name: options.after?.[1] ?? null,
      p_after_id: options.after?.[2] ?? null,
      p_limit: options.limit + 1,
    })) ?? []) as {
      kind: "folder" | "document";
      id: string;
      bucket: number;
      sort_name: string;
      payload: Record<string, unknown>;
    }[];
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => row.kind === "folder"
        ? { kind: "folder", folder: row.payload }
        : { kind: "document", document: row.payload }),
      nextAfter: rows.length > options.limit && last
        ? [last.bucket, last.sort_name, last.id]
        : null,
    };
  },

  async get(scope, projectId) {
    const data = await run(createServerSupabase().from("projects").select("*")
      .eq("id", projectId).maybeSingle());
    if (!data) return null;
    const shared = Array.isArray(data.shared_with)
      ? data.shared_with as string[] : [];
    const owner = data.user_id === scope.userId;
    const email = scope.userEmail?.toLowerCase();
    if (!owner && !shared.some((member) => member.toLowerCase() === email)) return null;
    return { ...data, is_owner: owner } as ProjectRecord;
  },

  async people(scope, projectId) {
    const db = createServerSupabase();
    const data = await run(db.from("projects")
      .select("id, user_id, shared_with").eq("id", projectId).maybeSingle());
    if (!data) return null;
    const shared = (Array.isArray(data.shared_with)
      ? data.shared_with as string[] : []).map((email) => email.toLowerCase());
    if (data.user_id !== scope.userId &&
        !shared.includes(scope.userEmail?.toLowerCase() ?? "")) return null;
    const { userByEmail, userById } = await loadProfileUsersByEmail(db);
    const owner = userById.get(data.user_id as string);
    return {
      owner: {
        user_id: data.user_id as string,
        email: owner?.email ?? null,
        display_name: owner?.display_name ?? null,
      },
      members: shared.map((email) => ({
        email,
        display_name: userByEmail.get(email)?.display_name ?? null,
      })),
    };
  },

  async update(scope, projectId, input) {
    const db = createServerSupabase();
    if (input.sharedWith) await validateRecipients(db, input.sharedWith);
    const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) values.name = input.name;
    if (input.cmNumber !== undefined) values.cm_number = input.cmNumber;
    if (input.practice !== undefined) values.practice = input.practice;
    if (input.sharedWith !== undefined) values.shared_with = input.sharedWith;
    const data = await run(db.from("projects").update(values)
      .eq("id", projectId).eq("user_id", scope.userId)
      .select("*").maybeSingle());
    if (!data) return null;
    return data as ProjectRecord;
  },

  async delete(scope, projectId) {
    return (await deleteUserProjects(
      createServerSupabase(), scope.userId, [projectId],
    )) > 0;
  },

  async detachDocument() {
    throw missing("Not found");
  },

  async attachDocument(scope, projectId, documentId) {
    const db = createServerSupabase();
    await accessible(db, scope, projectId);
    const source = await run(db.from("documents").select("*")
      .eq("id", documentId).eq("user_id", scope.userId).maybeSingle());
    if (!source) throw missing("Document not found");
    if (source.project_id === projectId) {
      await attachActiveVersionPaths(db, [source]);
      return { document: source as ProjectRecord, created: false };
    }
    if (source.project_id === null) {
      const data = await run(db.from("documents").update({
        project_id: projectId,
        library_folder_id: null,
        updated_at: new Date().toISOString(),
      }).eq("id", documentId).select("*").single());
      if (!data) throw new Error("Failed to update document");
      await attachActiveVersionPaths(db, [data]);
      return { document: data as ProjectRecord, created: false };
    }
    if (!source.current_version_id) throw missing("Source document has no active version");
    const copy = await run(db.from("documents").insert({
      project_id: projectId,
      user_id: scope.userId,
      status: source.status,
    }).select("*").single());
    if (!copy) throw new Error("Failed to copy document");
    try {
      const copied = await cloudDocuments.copyVersion(
        scope, copy.id as string, documentId, undefined,
      );
      if (copied.status !== "created") throw new Error("Source document has no active version");
      const document = { ...copy, current_version_id: copied.version.id };
      await attachActiveVersionPaths(db, [document]);
      return { document: document as ProjectRecord, created: true };
    } catch (error) {
      await cloudDocuments.deleteDocument(scope, copy.id as string).catch(() => {});
      throw error;
    }
  },

  async renameDocument(scope, projectId, documentId, requested) {
    const db = createServerSupabase();
    await accessible(db, scope, projectId);
    const data = await run(db.from("documents")
      .select("id, current_version_id").eq("id", documentId)
      .eq("project_id", projectId).maybeSingle());
    if (!data) throw missing("Document not found");
    const active = data.current_version_id
      ? await run(db.from("document_versions").select("filename")
          .eq("id", data.current_version_id)
          .eq("document_id", documentId).maybeSingle())
      : null;
    const current = typeof active?.filename === "string"
      ? active.filename : "Untitled document";
    const filename = normalizeDocumentFilename(requested, current);
    if (!filename) throw new ProjectStoreError(400, "filename is required");
    if (data.current_version_id && !await cloudDocuments.renameVersion(
      scope, documentId, data.current_version_id as string, filename,
    )) throw missing("Document not found");
    const updated = await run(db.from("documents")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", documentId).eq("project_id", projectId)
      .select("*").maybeSingle());
    if (!updated) throw missing("Document not found");
    return { ...updated, filename } as ProjectRecord;
  },

  async uploadDocument(scope, projectId, file, fileType) {
    const db = createServerSupabase();
    await accessible(db, scope, projectId);
    return await createCloudDocument(db, {
      userId: scope.userId,
      userEmail: scope.userEmail,
      projectId,
      file,
      fileType,
    }) as ProjectRecord;
  },

  async chats(scope, projectId) {
    const db = createServerSupabase();
    await accessible(db, scope, projectId);
    const data = await run(db.from("chats").select("*")
      .eq("project_id", projectId).is("deleted_at", null)
      .order("created_at", { ascending: false }));
    const chats = (data ?? []) as (ProjectRecord & {
      user_id?: string | null;
      creator_display_name?: string | null;
    })[];
    const names = await displayNames(db, chats);
    chats.forEach((chat) => {
      chat.creator_display_name = chat.user_id
        ? names.get(chat.user_id) ?? null : null;
    });
    return chats;
  },

  async createFolder(scope, projectId, input) {
    const db = createServerSupabase();
    await accessible(db, scope, projectId);
    if (input.parentFolderId && !await folder(db, projectId, input.parentFolderId)) {
      throw missing("Parent folder not found");
    }
    const data = await run(db.from("project_subfolders").insert({
      project_id: projectId,
      user_id: scope.userId,
      name: input.name,
      parent_folder_id: input.parentFolderId,
    }).select("*").single());
    if (!data) throw new Error("Failed to create folder");
    return data as ProjectRecord;
  },

  async updateFolder(scope, projectId, folderId, input) {
    const db = createServerSupabase();
    await accessible(db, scope, projectId);
    const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) values.name = input.name;
    if (input.parentFolderId !== undefined) {
      let parentId = input.parentFolderId;
      while (parentId) {
        if (parentId === folderId) {
          throw new ProjectStoreError(
            400, "Cannot move a folder into itself or a descendant");
        }
        const parent = await folder(db, projectId, parentId);
        if (!parent) throw missing("Parent folder not found");
        parentId = parent.parent_folder_id;
      }
      values.parent_folder_id = input.parentFolderId;
    }
    const data = await run(db.from("project_subfolders").update(values)
      .eq("id", folderId).eq("project_id", projectId)
      .select("*").maybeSingle());
    if (!data) throw missing("Folder not found");
    return data as ProjectRecord;
  },

  async deleteFolder(scope, projectId, folderId) {
    const db = createServerSupabase();
    await accessible(db, scope, projectId);
    if (!await folder(db, projectId, folderId)) throw missing("Folder not found");
    const data = await run(db.rpc("get_project_folder_document_ids", {
      p_project_id: projectId,
      p_folder_id: folderId,
    }));
    await deleteDocuments(db, projectId, (data ?? []).map((row: { id: string }) => row.id));
    await run(db.from("project_subfolders").delete()
      .eq("id", folderId).eq("project_id", projectId));
  },

  async moveDocument(scope, projectId, documentId, folderId) {
    const db = createServerSupabase();
    await accessible(db, scope, projectId);
    if (folderId && !await folder(db, projectId, folderId)) {
      throw missing("Folder not found");
    }
    const data = await run(db.from("documents").update({
      folder_id: folderId,
      updated_at: new Date().toISOString(),
    }).eq("id", documentId).eq("project_id", projectId)
      .select("*").maybeSingle());
    if (!data) throw missing("Document not found");
    return data as ProjectRecord;
  },
} satisfies ProjectStore;
