import type {
  LibraryDocument,
  LibraryFolder,
  LibraryScope,
  LibraryStore,
} from "./libraryStore";
import {
  normalizeDocumentMetadata,
  normalizeDocumentNotes,
} from "./normalize";
import { deleteFile } from "./storage";
import { createServerSupabase } from "./supabase";

const documentResponse = (row: Record<string, unknown>): LibraryDocument => ({
  ...row,
  id: row.id as string,
  folder_id: (row.library_folder_id as string | null | undefined) ?? null,
  metadata: normalizeDocumentMetadata(row.metadata),
  notes: normalizeDocumentNotes(row.notes),
});

const failed = (error: { message: string } | null, operation: string) => {
  if (error) throw new Error(`${operation}: ${error.message}`);
};

async function readDocument(
  scope: LibraryScope,
  documentId: string,
  db = createServerSupabase(),
) {
  const { data: document, error } = await db.from("documents").select("*")
    .eq("id", documentId).eq("user_id", scope.userId)
    .is("project_id", null).eq("library_kind", scope.kind).maybeSingle();
  failed(error, "Failed to load document");
  if (!document) return null;
  const { data: version, error: versionError } = document.current_version_id
    ? await db.from("document_versions").select("*")
        .eq("id", document.current_version_id)
        .eq("document_id", documentId).maybeSingle()
    : { data: null, error: null };
  failed(versionError, "Failed to load document version");
  return documentResponse({ ...version, ...document });
}

export const cloudLibraryStore = {
  async page(scope, options) {
    const db = createServerSupabase();
    const { data, error } = await db.rpc("get_directory_page", {
      p_user_id: scope.userId,
      p_user_email: null,
      p_project_id: null,
      p_library_kind: scope.kind,
      p_parent_id: options.parentFolderId,
      p_q: options.q,
      p_documents_only: options.documentsOnly ?? false,
      p_after_bucket: options.after?.[0] ?? null,
      p_after_name: options.after?.[1] ?? null,
      p_after_id: options.after?.[2] ?? null,
      p_limit: options.limit + 1,
    });
    failed(error, "Failed to load library");
    const rows = (data ?? []) as {
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
        ? { kind: "folder" as const, folder: row.payload as LibraryFolder }
        : { kind: "document" as const, document: documentResponse(row.payload) }),
      nextAfter: rows.length > options.limit && last
        ? [last.bucket, last.sort_name, last.id]
        : null,
    };
  },

  async folder(scope, folderId) {
    const { data, error } = await createServerSupabase()
      .from("library_folders")
      .select("*")
      .eq("id", folderId)
      .eq("user_id", scope.userId)
      .eq("library_kind", scope.kind)
      .maybeSingle();
    failed(error, "Failed to load folder");
    return data as LibraryFolder | null;
  },

  async createFolder(scope, name, parentFolderId) {
    const { data, error } = await createServerSupabase()
      .from("library_folders")
      .insert({
        user_id: scope.userId,
        library_kind: scope.kind,
        name,
        parent_folder_id: parentFolderId,
      })
      .select("*")
      .single();
    failed(error, "Failed to create folder");
    return data as LibraryFolder | null;
  },

  async updateFolder(scope, folderId, update) {
    const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (update.name !== undefined) values.name = update.name;
    if (update.parentFolderId !== undefined) {
      values.parent_folder_id = update.parentFolderId;
    }
    const { data, error } = await createServerSupabase()
      .from("library_folders")
      .update(values)
      .eq("id", folderId)
      .eq("user_id", scope.userId)
      .eq("library_kind", scope.kind)
      .select("*")
      .maybeSingle();
    failed(error, "Failed to update folder");
    return data as LibraryFolder | null;
  },

  async deleteFolder(scope, folderId) {
    const db = createServerSupabase();
    const { data: rows, error: documentsError } = await db.rpc(
      "get_library_folder_document_ids",
      { p_user_id: scope.userId, p_kind: scope.kind, p_folder_id: folderId },
    );
    failed(documentsError, "Failed to load folder documents");
    const documentIds = (rows ?? []).map((row: { id: string }) => row.id);
    const paths = new Set<string>();
    if (documentIds.length) {
      const { data: versions, error: versionsError } = await db
        .from("document_versions")
        .select("storage_path, pdf_storage_path")
        .in("document_id", documentIds);
      failed(versionsError, "Failed to load document versions");
      for (const version of versions ?? []) {
        if (version.storage_path) paths.add(version.storage_path);
        if (version.pdf_storage_path) paths.add(version.pdf_storage_path);
      }
      const { error: deleteDocumentsError } = await db
        .from("documents")
        .delete()
        .eq("user_id", scope.userId)
        .is("project_id", null)
        .eq("library_kind", scope.kind)
        .in("id", documentIds);
      failed(deleteDocumentsError, "Failed to delete folder documents");
    }
    const { data, error } = await db
      .from("library_folders")
      .delete()
      .eq("id", folderId)
      .eq("user_id", scope.userId)
      .eq("library_kind", scope.kind)
      .select("id")
      .maybeSingle();
    failed(error, "Failed to delete folder");
    if (!data) return false;
    await Promise.all([...paths].map((path) => deleteFile(path).catch(() => {})));
    return true;
  },

  document: readDocument,

  async moveDocument(scope, documentId, folderId) {
    const { data, error } = await createServerSupabase()
      .from("documents")
      .update({
        library_folder_id: folderId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId)
      .eq("user_id", scope.userId)
      .is("project_id", null)
      .eq("library_kind", scope.kind)
      .select("*")
      .maybeSingle();
    failed(error, "Failed to move document");
    return data ? documentResponse(data) : null;
  },

  async updateDocument(scope, documentId, update) {
    const db = createServerSupabase();
    const current = await readDocument(scope, documentId, db);
    if (!current) return null;
    const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (update.metadata !== undefined) values.metadata = update.metadata;
    if (update.notes !== undefined) values.notes = update.notes;
    const { data, error } = await db.from("documents").update(values)
      .eq("id", documentId).eq("user_id", scope.userId)
      .is("project_id", null).eq("library_kind", scope.kind)
      .select("*").maybeSingle();
    failed(error, "Failed to update document");
    if (!data) return null;
    if (data.current_version_id) {
      const { error: versionError } = await db.from("document_versions")
        .update({ filename: update.filename })
        .eq("id", data.current_version_id).eq("document_id", documentId);
      failed(versionError, "Failed to rename document");
    }
    return documentResponse({ ...current, ...data, filename: update.filename });
  },
} satisfies LibraryStore;
