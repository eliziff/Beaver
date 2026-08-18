import { cloudData, cloudScope, type CloudScope } from "./access";
import type { DocumentStore } from "./documentStore";
import type { LibraryDocument, LibraryFolder, LibraryScope, LibraryStore } from "./libraryStore";
import { normalizeDocumentMetadata, normalizeDocumentNotes } from "./normalize";

const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation: string) =>
  cloudData<T>(operation, query);
const documentResponse = (row: Record<string, unknown>): LibraryDocument => ({
  ...row, id: row.id as string,
  folder_id: (row.library_folder_id as string | null | undefined) ?? null,
  metadata: normalizeDocumentMetadata(row.metadata), notes: normalizeDocumentNotes(row.notes),
});

async function readDocument(scope: CloudScope, kind: LibraryScope["kind"], documentId: string) {
  const document = await run(scope.db.from("documents").select("*")
    .eq("id", documentId).eq("user_id", scope.userId).is("project_id", null)
    .eq("library_kind", kind).maybeSingle(), "Failed to load document");
  if (!document) return null;
  const version = document.current_version_id ? await run(scope.db.from("document_versions")
    .select("*").eq("id", document.current_version_id).eq("document_id", documentId)
    .maybeSingle(), "Failed to load document version") : null;
  return documentResponse({ ...version, ...document });
}

export const createCloudLibraryStore = (documents: DocumentStore): LibraryStore => ({
  async page(identity, options) {
    const scope = cloudScope(identity);
    const data = await run(scope.db.rpc("get_directory_page", {
      p_user_id: scope.userId, p_user_email: null, p_project_id: null,
      p_library_kind: identity.kind, p_parent_id: options.parentFolderId,
      p_q: options.q, p_documents_only: options.documentsOnly ?? false,
      p_after_bucket: options.after?.[0] ?? null, p_after_name: options.after?.[1] ?? null,
      p_after_id: options.after?.[2] ?? null, p_limit: options.limit + 1,
    }), "Failed to load library");
    const rows = (data ?? []) as { kind: "folder" | "document"; id: string;
      bucket: number; sort_name: string; payload: Record<string, unknown> }[];
    const page = rows.slice(0, options.limit), last = page.at(-1);
    return { items: page.map((row) => row.kind === "folder"
      ? { kind: "folder" as const, folder: row.payload as LibraryFolder }
      : { kind: "document" as const, document: documentResponse(row.payload) }),
    nextAfter: rows.length > options.limit && last
      ? [last.bucket, last.sort_name, last.id] : null };
  },

  async folder(identity, folderId) {
    const scope = cloudScope(identity);
    return await run(scope.db.from("library_folders").select("*").eq("id", folderId)
      .eq("user_id", scope.userId).eq("library_kind", identity.kind).maybeSingle(),
    "Failed to load folder") as LibraryFolder | null;
  },

  async createFolder(identity, name, parentFolderId) {
    const scope = cloudScope(identity);
    return await run(scope.db.from("library_folders").insert({ user_id: scope.userId,
      library_kind: identity.kind, name, parent_folder_id: parentFolderId })
      .select("*").single(), "Failed to create folder") as LibraryFolder | null;
  },

  async updateFolder(identity, folderId, update) {
    const scope = cloudScope(identity);
    const values: Record<string, unknown> = { updated_at: new Date().toISOString(),
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.parentFolderId !== undefined
        ? { parent_folder_id: update.parentFolderId } : {}) };
    return await run(scope.db.from("library_folders").update(values).eq("id", folderId)
      .eq("user_id", scope.userId).eq("library_kind", identity.kind)
      .select("*").maybeSingle(), "Failed to update folder") as LibraryFolder | null;
  },

  async deleteFolder(identity, folderId) {
    const scope = cloudScope(identity), { db } = scope;
    const rows = await run(db.rpc("get_library_folder_document_ids", {
      p_user_id: scope.userId, p_kind: identity.kind, p_folder_id: folderId,
    }), "Failed to load folder documents");
    for (const { id } of (rows ?? []) as { id: string }[]) {
      if (!await documents.deleteDocument(identity, id)) {
        throw new Error("Failed to delete folder document");
      }
    }
    const deleted = await run(db.from("library_folders").delete().eq("id", folderId)
      .eq("user_id", scope.userId).eq("library_kind", identity.kind)
      .select("id").maybeSingle(), "Failed to delete folder");
    return !!deleted;
  },

  document(identity, documentId) {
    return readDocument(cloudScope(identity), identity.kind, documentId);
  },

  async moveDocument(identity, documentId, folderId) {
    const scope = cloudScope(identity);
    const data = await run(scope.db.from("documents").update({
      library_folder_id: folderId, updated_at: new Date().toISOString(),
    }).eq("id", documentId).eq("user_id", scope.userId).is("project_id", null)
      .eq("library_kind", identity.kind).select("*").maybeSingle(),
    "Failed to move document");
    return data ? documentResponse(data) : null;
  },

  async updateDocument(identity, documentId, update) {
    const scope = cloudScope(identity), current = await readDocument(
      scope, identity.kind, documentId);
    if (!current?.current_version_id || !await documents.renameVersion(
      identity, documentId, current.current_version_id, update.filename,
    )) return null;
    const values: Record<string, unknown> = { updated_at: new Date().toISOString(),
      ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
      ...(update.notes !== undefined ? { notes: update.notes } : {}) };
    const data = await run(scope.db.from("documents").update(values).eq("id", documentId)
      .eq("user_id", scope.userId).is("project_id", null).eq("library_kind", identity.kind)
      .select("*").maybeSingle(), "Failed to update document");
    if (!data) return null;
    return documentResponse({ ...current, ...data, filename: update.filename });
  },
});
