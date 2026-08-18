import { cloudData, cloudScope, type CloudScope } from "./access";
import type {
  DocumentAggregate,
  DocumentRepository,
  StoredDocument,
  StoredDocumentVersion,
  UpdateVersionMetadata,
} from "./documentRepository";
import type { StoredAssistantEdit } from "./documentStore";

type Db = CloudScope["db"];
type Row = Record<string, any>;

const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation: string) =>
  cloudData<T>(operation, query);

const storedDocument = (row: Row): StoredDocument => ({
  id: String(row.id),
  userId: String(row.user_id),
  projectId: row.project_id ? String(row.project_id) : null,
  libraryKind: row.library_kind === "template" ? "template" : "file",
  folderId: row.project_id
    ? row.folder_id ? String(row.folder_id) : null
    : row.library_folder_id ? String(row.library_folder_id) : null,
  status: typeof row.status === "string" ? row.status : "ready",
  currentVersionId: String(row.current_version_id),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  metadata: row.metadata ?? {},
  notes: typeof row.notes === "string" ? row.notes : null,
});

const storedVersion = (row: Row): StoredDocumentVersion => ({
  id: String(row.id),
  documentId: String(row.document_id),
  versionNumber: Number(row.version_number),
  source: typeof row.source === "string" ? row.source : "upload",
  createdAt: String(row.created_at),
  filename: typeof row.filename === "string" && row.filename.trim()
    ? row.filename : "Untitled document",
  fileType: typeof row.file_type === "string" ? row.file_type : "",
  sizeBytes: Number(row.size_bytes ?? 0),
  pageCount: typeof row.page_count === "number" ? row.page_count : null,
  sourceSha256: typeof row.source_sha256 === "string" ? row.source_sha256 : "",
  blobKey: String(row.storage_path),
  pdfBlobKey: row.pdf_storage_path ? String(row.pdf_storage_path) : null,
  cleanupKeys: Array.isArray(row.cleanup_paths)
    ? row.cleanup_paths.filter((key: unknown): key is string => typeof key === "string")
    : [],
  provenance: row.provenance ?? undefined,
});

const storedEdit = (row: Row): StoredAssistantEdit & { versionId: string } => ({
  id: String(row.id),
  versionId: String(row.version_id),
  changeId: String(row.change_id),
  delWId: row.del_w_id ? String(row.del_w_id) : undefined,
  insWId: row.ins_w_id ? String(row.ins_w_id) : undefined,
  deletedText: typeof row.deleted_text === "string" ? row.deleted_text : "",
  insertedText: typeof row.inserted_text === "string" ? row.inserted_text : "",
  contextBefore: typeof row.context_before === "string" ? row.context_before : "",
  contextAfter: typeof row.context_after === "string" ? row.context_after : "",
  status: row.status === "accepted" || row.status === "rejected" ? row.status : "pending",
  diff: [],
});

const editRow = (documentId: string, versionId: string, edit: StoredAssistantEdit) => ({
  id: edit.id,
  document_id: documentId,
  version_id: versionId,
  change_id: edit.changeId,
  del_w_id: edit.delWId ?? null,
  ins_w_id: edit.insWId ?? null,
  deleted_text: edit.deletedText,
  inserted_text: edit.insertedText,
  context_before: edit.contextBefore,
  context_after: edit.contextAfter,
  status: edit.status,
  ...(edit.status === "pending" ? {} : { resolved_at: new Date().toISOString() }),
});

const versionRow = (version: StoredDocumentVersion) => ({
  id: version.id,
  document_id: version.documentId,
  storage_path: version.blobKey,
  pdf_storage_path: version.pdfBlobKey,
  source: version.source,
  version_number: version.versionNumber,
  filename: version.filename,
  file_type: version.fileType,
  size_bytes: version.sizeBytes,
  page_count: version.pageCount,
  source_sha256: version.sourceSha256,
  cleanup_paths: version.cleanupKeys,
  provenance: version.provenance ?? null,
  created_at: version.createdAt,
});

function updateRow(update: UpdateVersionMetadata) {
  return {
    ...(update.filename !== undefined ? { filename: update.filename } : {}),
    ...(update.fileType !== undefined ? { file_type: update.fileType } : {}),
    ...(update.sizeBytes !== undefined ? { size_bytes: update.sizeBytes } : {}),
    ...(update.pageCount !== undefined ? { page_count: update.pageCount } : {}),
    ...(update.sourceSha256 !== undefined ? { source_sha256: update.sourceSha256 } : {}),
    ...(update.blobKey !== undefined ? { storage_path: update.blobKey } : {}),
    ...(update.pdfBlobKey !== undefined ? { pdf_storage_path: update.pdfBlobKey } : {}),
    ...(update.cleanupKeys !== undefined ? { cleanup_paths: update.cleanupKeys } : {}),
    ...(update.provenance !== undefined ? { provenance: update.provenance } : {}),
    ...(update.createdAt !== undefined ? { created_at: update.createdAt } : {}),
  };
}

async function aggregate(scope: CloudScope, documentId: string, owner = false) {
  const access = await scope.document(documentId, owner);
  if (!access || !access.row.current_version_id) return null;
  const [versions, edits] = await Promise.all([
    run(scope.db.from("document_versions").select("*")
      .eq("document_id", documentId).is("deleted_at", null)
      .order("version_number", { ascending: true }), "Failed to load document versions"),
    run(scope.db.from("document_edits").select("*")
      .eq("document_id", documentId), "Failed to load document edits"),
  ]);
  return {
    document: storedDocument(access.row),
    versions: (versions ?? []).map(storedVersion),
    edits: (edits ?? []).map(storedEdit),
    isOwner: access.isOwner,
  } satisfies DocumentAggregate;
}

async function rollbackEdits(db: Db, inserted: string[], resolved?: {
  id: string;
  previous: string;
}) {
  if (inserted.length) await db.from("document_edits").delete().in("id", inserted);
  if (resolved) await db.from("document_edits").update({ status: resolved.previous })
    .eq("id", resolved.id);
}

export const cloudDocumentRepository: DocumentRepository = {
  async authorizeCreate(identity, input) {
    const scope = cloudScope(identity);
    if (input.projectId) {
      if (!await scope.project(input.projectId)) return "project-missing";
      if (input.folderId && !await run(scope.db.from("project_subfolders")
        .select("id").eq("id", input.folderId).eq("project_id", input.projectId)
        .maybeSingle(), "Failed to load project folder")) return "folder-missing";
      return "ok";
    }
    if (input.folderId && !await run(scope.db.from("library_folders")
      .select("id").eq("id", input.folderId).eq("user_id", scope.userId)
      .eq("library_kind", input.libraryKind).maybeSingle(),
    "Failed to load Library folder")) return "folder-missing";
    return "ok";
  },

  async create(identity, input) {
    const scope = cloudScope(identity), { document, version } = input;
    await run(scope.db.from("documents").insert({
      id: document.id,
      project_id: document.projectId,
      user_id: document.userId,
      status: document.status,
      folder_id: document.projectId ? document.folderId : null,
      library_kind: document.libraryKind,
      library_folder_id: document.projectId ? null : document.folderId,
      metadata: document.metadata ?? {},
      notes: document.notes ?? null,
      created_at: document.createdAt,
      updated_at: document.updatedAt,
    }), "Failed to create document");
    try {
      await run(scope.db.from("document_versions").insert(versionRow(version)),
        "Failed to create document version");
      await run(scope.db.from("documents").update({ current_version_id: version.id })
        .eq("id", document.id).eq("user_id", scope.userId),
      "Failed to activate document version");
    } catch (error) {
      await scope.db.from("document_versions").delete().eq("id", version.id);
      await scope.db.from("documents").delete().eq("id", document.id);
      throw error;
    }
  },

  get: (identity, documentId, owner = false) =>
    aggregate(cloudScope(identity), documentId, owner),

  async getMany(identity, documentIds) {
    const values = await Promise.all([...new Set(documentIds)].map((id) =>
      aggregate(cloudScope(identity), id)));
    return values.flatMap((value) => value ? [value] : []);
  },

  async insertVersion(identity, documentId, input) {
    const scope = cloudScope(identity), current = await aggregate(scope, documentId);
    if (!current) return "missing";
    if (current.document.currentVersionId !== input.expectedCurrentVersionId) return "conflict";
    await run(scope.db.from("document_versions").insert(versionRow(input.version)),
      "Failed to record document version");
    try {
      if (input.edits?.length) await run(scope.db.from("document_edits")
        .insert(input.edits.map((edit) => editRow(documentId, input.version.id, edit))),
      "Failed to record document edits");
      const updated = await run(scope.db.from("documents").update({
        current_version_id: input.version.id,
        updated_at: input.version.createdAt,
      }).eq("id", documentId).eq("current_version_id", input.expectedCurrentVersionId)
        .select("id").maybeSingle(), "Failed to activate document version");
      if (!updated) throw new Error("Document version conflict");
      return "created";
    } catch (error) {
      await scope.db.from("document_edits").delete().eq("version_id", input.version.id);
      await scope.db.from("document_versions").delete().eq("id", input.version.id);
      if (error instanceof Error && error.message === "Document version conflict") {
        return "conflict";
      }
      throw error;
    }
  },

  async updateVersion(identity, documentId, input) {
    const scope = cloudScope(identity), current = await aggregate(scope, documentId);
    if (!current) return "missing";
    const version = current.versions.find(({ id }) => id === input.versionId);
    if (!version) return "missing";
    if (version.blobKey !== input.expectedBlobKey) return "conflict";
    const inserted = input.edits?.map(({ id }) => id) ?? [];
    const existingEdit = input.resolveEdit
      ? current.edits.find(({ id }) => id === input.resolveEdit!.id)
      : undefined;
    try {
      if (input.edits?.length) await run(scope.db.from("document_edits")
        .insert(input.edits.map((edit) => editRow(documentId, input.versionId, edit))),
      "Failed to record document edits");
      if (input.resolveEdit) await run(scope.db.from("document_edits").update({
        status: input.resolveEdit.status,
        resolved_at: new Date().toISOString(),
      }).eq("id", input.resolveEdit.id).eq("document_id", documentId)
        .eq("version_id", input.versionId), "Failed to resolve document edit");
      const updated = await run(scope.db.from("document_versions")
        .update(updateRow(input.update)).eq("id", input.versionId)
        .eq("document_id", documentId).eq("storage_path", input.expectedBlobKey)
        .is("deleted_at", null).select("id").maybeSingle(),
      "Failed to update document version");
      if (!updated) {
        await rollbackEdits(scope.db, inserted, existingEdit && input.resolveEdit
          ? { id: input.resolveEdit.id, previous: existingEdit.status }
          : undefined);
        return "conflict";
      }
      return "updated";
    } catch (error) {
      await rollbackEdits(scope.db, inserted, existingEdit && input.resolveEdit
        ? { id: input.resolveEdit.id, previous: existingEdit.status }
        : undefined);
      throw error;
    }
  },

  async renameVersion(identity, documentId, versionId, filename) {
    const scope = cloudScope(identity);
    if (!await scope.document(documentId)) return false;
    return !!await run(scope.db.from("document_versions").update({ filename })
      .eq("id", versionId).eq("document_id", documentId).is("deleted_at", null)
      .select("id").maybeSingle(), "Failed to rename document version");
  },

  async deleteVersion(identity, documentId, versionId, currentVersionId) {
    const scope = cloudScope(identity);
    if (!await scope.document(documentId, true)) return false;
    await run(scope.db.from("documents").update({
      current_version_id: currentVersionId,
      updated_at: new Date().toISOString(),
    }).eq("id", documentId), "Failed to activate remaining document version");
    return !!await run(scope.db.from("document_versions").delete()
      .eq("id", versionId).eq("document_id", documentId)
      .select("id").maybeSingle(), "Failed to delete document version");
  },

  async deleteDocument(identity, documentId) {
    const scope = cloudScope(identity);
    if (!await scope.document(documentId, true)) return false;
    return !!await run(scope.db.from("documents").delete().eq("id", documentId)
      .select("id").maybeSingle(),
    "Failed to delete document");
  },

  async clearCleanup(identity, documentId, versionId, keys) {
    const scope = cloudScope(identity);
    const row = await run(scope.db.from("document_versions").select("cleanup_paths")
      .eq("id", versionId).eq("document_id", documentId).maybeSingle(),
    "Failed to load document cleanup state");
    if (!row) return;
    const removed = new Set(keys);
    const pending = (Array.isArray(row.cleanup_paths) ? row.cleanup_paths : [])
      .filter((key: unknown): key is string => typeof key === "string" && !removed.has(key));
    await run(scope.db.from("document_versions").update({ cleanup_paths: pending })
      .eq("id", versionId).eq("document_id", documentId),
    "Failed to clear document cleanup state");
  },

  async recordOrphan(identity, key) {
    const scope = cloudScope(identity);
    await run(scope.db.from("object_cleanup").upsert({
      storage_path: key, user_id: scope.userId,
    }), "Failed to record object cleanup");
  },

  async clearOrphan(key) {
    const db = cloudScope({ userId: "storage-cleanup" }).db;
    await run(db.from("object_cleanup").delete().eq("storage_path", key),
    "Failed to clear object cleanup");
  },

  async pendingOrphans(limit = 100) {
    const db = cloudScope({ userId: "storage-cleanup" }).db;
    const rows = await run(db.from("object_cleanup").select("storage_path")
      .order("created_at").limit(Math.max(1, Math.min(limit, 500))),
    "Failed to load object cleanup");
    return (rows ?? []).map((row: Row) => String(row.storage_path));
  },

  async pendingCleanup(limit = 100) {
    const db = cloudScope({ userId: "storage-cleanup" }).db;
    const rows = await run(db.from("document_versions")
      .select("id,document_id,cleanup_paths").not("cleanup_paths", "eq", "[]")
      .limit(Math.max(1, Math.min(limit, 500))), "Failed to load document cleanup state");
    const documentIds = [...new Set((rows ?? []).map((row: Row) => String(row.document_id)))];
    const documents = documentIds.length ? await run(db.from("documents")
      .select("id,user_id").in("id", documentIds), "Failed to load cleanup owners") : [];
    const owners = new Map((documents ?? []).map((row: Row) => [String(row.id), String(row.user_id)]));
    return (rows ?? []).flatMap((row: Row) => {
      const userId = owners.get(String(row.document_id));
      const keys = Array.isArray(row.cleanup_paths)
        ? row.cleanup_paths.filter((key: unknown): key is string => typeof key === "string")
        : [];
      return userId && keys.length ? [{
        scope: { userId },
        documentId: String(row.document_id),
        versionId: String(row.id),
        keys,
      }] : [];
    });
  },
};
