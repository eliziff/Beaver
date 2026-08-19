import { cloudData, cloudScope } from "./access";
import type { LibraryFolder, LibraryRepository } from "./libraryStore";

const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation: string) =>
  cloudData<T>(operation, query);
export const postgresLibraryRepository: LibraryRepository = {
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
      : { kind: "document" as const, id: row.id }),
    nextAfter: rows.length > options.limit && last
      ? [last.bucket, last.sort_name, last.id] : null };
  },
  async folder(identity, id) {
    const scope = cloudScope(identity);
    return await run(scope.db.from("library_folders").select("*").eq("id", id)
      .eq("user_id", scope.userId).eq("library_kind", identity.kind).maybeSingle(),
    "Failed to load folder") as LibraryFolder | null;
  },
  async createFolder(identity, name, parentId) {
    const scope = cloudScope(identity);
    return await run(scope.db.from("library_folders").insert({ user_id: scope.userId,
      library_kind: identity.kind, name, parent_folder_id: parentId })
      .select("*").single(), "Failed to create folder") as LibraryFolder | null;
  },
  async updateFolder(identity, id, update) {
    const scope = cloudScope(identity);
    const values = { updated_at: new Date().toISOString(),
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.parentFolderId !== undefined
        ? { parent_folder_id: update.parentFolderId } : {}) };
    return await run(scope.db.from("library_folders").update(values).eq("id", id)
      .eq("user_id", scope.userId).eq("library_kind", identity.kind)
      .select("*").maybeSingle(), "Failed to update folder") as LibraryFolder | null;
  },
  async folderDocumentIds(identity, id) {
    const scope = cloudScope(identity);
    if (!await run(scope.db.from("library_folders").select("id").eq("id", id)
      .eq("user_id", scope.userId).eq("library_kind", identity.kind).maybeSingle(),
    "Failed to load folder")) return null;
    const rows = await run(scope.db.rpc("get_library_folder_document_ids", {
      p_user_id: scope.userId, p_kind: identity.kind, p_folder_id: id,
    }), "Failed to load folder documents");
    return ((rows ?? []) as { id: string }[]).map(({ id }) => id);
  },
  async deleteFolder(identity, id) {
    const scope = cloudScope(identity);
    return !!await run(scope.db.from("library_folders").delete().eq("id", id)
      .eq("user_id", scope.userId).eq("library_kind", identity.kind)
      .select("id").maybeSingle(), "Failed to delete folder");
  },
};
