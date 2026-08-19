import { cloudData, cloudScope, type CloudScope } from "./access";
import type { DocumentAggregate, DocumentRepository, StoredDocument,
  StoredDocumentVersion } from "./documentRepository";
import type { StoredAssistantEdit } from "./documentStore";

type Row = Record<string, any>;

const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation: string) =>
  cloudData<T>(operation, query);

const storedDocument = (row: Row): StoredDocument => ({
  id: String(row.id), userId: String(row.user_id),
  projectId: row.project_id ? String(row.project_id) : null,
  libraryKind: row.library_kind === "template" ? "template" : "file",
  folderId: row.project_id
    ? row.folder_id ? String(row.folder_id) : null
    : row.library_folder_id ? String(row.library_folder_id) : null,
  status: String(row.status ?? "ready"), currentVersionId: String(row.current_version_id),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  metadata: row.metadata ?? {}, notes: typeof row.notes === "string" ? row.notes : null,
});

const storedVersion = (row: Row): StoredDocumentVersion => ({
  id: String(row.id), documentId: String(row.document_id),
  versionNumber: Number(row.version_number), source: String(row.source ?? "upload"),
  createdAt: String(row.created_at),
  filename: typeof row.filename === "string" && row.filename.trim()
    ? row.filename : "Untitled document",
  fileType: String(row.file_type ?? ""), sizeBytes: Number(row.size_bytes ?? 0),
  pageCount: typeof row.page_count === "number" ? row.page_count : null,
  sourceSha256: String(row.source_sha256 ?? ""), blobKey: String(row.storage_path),
  pdfBlobKey: row.pdf_storage_path ? String(row.pdf_storage_path) : null,
  cleanupKeys: Array.isArray(row.cleanup_paths)
    ? row.cleanup_paths.filter((key: unknown): key is string => typeof key === "string")
    : [],
  provenance: row.provenance ?? undefined,
});

const storedEdit = (row: Row): StoredAssistantEdit & { versionId: string } => ({
  id: String(row.id), versionId: String(row.version_id), changeId: String(row.change_id),
  delWId: row.del_w_id ? String(row.del_w_id) : undefined,
  insWId: row.ins_w_id ? String(row.ins_w_id) : undefined,
  deletedText: String(row.deleted_text ?? ""), insertedText: String(row.inserted_text ?? ""),
  contextBefore: String(row.context_before ?? ""), contextAfter: String(row.context_after ?? ""),
  status: row.status === "accepted" || row.status === "rejected" ? row.status : "pending",
  diff: [],
});

const editRow = (documentId: string, versionId: string, edit: StoredAssistantEdit) => ({
  id: edit.id, document_id: documentId, version_id: versionId, change_id: edit.changeId,
  del_w_id: edit.delWId ?? null, ins_w_id: edit.insWId ?? null,
  deleted_text: edit.deletedText, inserted_text: edit.insertedText,
  context_before: edit.contextBefore, context_after: edit.contextAfter, status: edit.status,
  ...(edit.status === "pending" ? {} : { resolved_at: new Date().toISOString() }),
});

const versionRow = (version: StoredDocumentVersion) => ({
  id: version.id, document_id: version.documentId, storage_path: version.blobKey,
  pdf_storage_path: version.pdfBlobKey, source: version.source,
  version_number: version.versionNumber, filename: version.filename,
  file_type: version.fileType, size_bytes: version.sizeBytes, page_count: version.pageCount,
  source_sha256: version.sourceSha256, cleanup_paths: version.cleanupKeys,
  provenance: version.provenance ?? null, created_at: version.createdAt,
});

const mutate = async (scope: CloudScope, action: string, documentId: string,
  expected: string | null, payload: Record<string, unknown>) => {
  const result = await run(scope.db.rpc("write_document", {
    p_actor_user_id: scope.userId, p_actor_user_email: scope.userEmail || null,
    p_action: action, p_document_id: documentId, p_expected: expected, p_payload: payload,
  }), `Failed to ${action.replaceAll("_", " ")}`) as Row | null;
  return typeof result?.status === "string" ? result.status : "missing";
};

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

export const postgresDocumentRepository: DocumentRepository = {
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
    const status = await mutate(scope, "create", document.id, null, { document: {
      id: document.id, project_id: document.projectId, user_id: document.userId,
      status: document.status, folder_id: document.projectId ? document.folderId : null,
      library_kind: document.libraryKind,
      library_folder_id: document.projectId ? null : document.folderId,
      metadata: document.metadata ?? {}, notes: document.notes ?? null,
      created_at: document.createdAt, updated_at: document.updatedAt,
    }, version: versionRow(version) });
    if (status !== "created") throw new Error("Failed to create document");
  },

  get: (identity, documentId, owner = false) =>
    aggregate(cloudScope(identity), documentId, owner),

  async getMany(identity, documentIds) {
    const values = await Promise.all([...new Set(documentIds)].map((id) =>
      aggregate(cloudScope(identity), id)));
    return values.flatMap((value) => value ? [value] : []);
  },

  async deletionIds(identity, projectIds, includeOwned) {
    const scope = cloudScope(identity), ids = new Set<string>();
    if (includeOwned) for (const row of await run(scope.db.from("documents")
      .select("id").eq("user_id", scope.userId), "Failed to load owned documents") ?? [])
      ids.add(String((row as Row).id));
    const projects = (await Promise.all([...new Set(projectIds)].map((id) =>
      scope.project(id, true)))).flatMap((access) => access ? [access.row.id] : []);
    if (projects.length) for (const row of await run(scope.db.from("documents")
      .select("id").in("project_id", projects), "Failed to load project documents") ?? [])
      ids.add(String((row as Row).id));
    return [...ids];
  },

  async insertVersion(identity, documentId, input) {
    return await mutate(cloudScope(identity), "insert_version", documentId,
      input.expectedCurrentVersionId, { version: versionRow(input.version),
        edits: input.edits?.map((edit) => editRow(documentId, input.version.id, edit)) ?? []
      }) as "created" | "missing" | "conflict";
  },

  async updateVersion(identity, documentId, input) {
    const scope = cloudScope(identity), current = await aggregate(scope, documentId);
    if (!current) return "missing";
    const version = current.versions.find(({ id }) => id === input.versionId);
    if (!version) return "missing";
    if (version.blobKey !== input.expectedBlobKey) return "conflict";
    const next = { ...version,
      ...Object.fromEntries(Object.entries(input.update).filter(([, value]) => value !== undefined)) };
    return await mutate(scope, "update_version", documentId, input.expectedBlobKey, {
      version: versionRow(next),
      edits: input.edits?.map((edit) => editRow(documentId, input.versionId, edit)) ?? [],
      ...(input.resolveEdit ? { resolve: input.resolveEdit } : {}),
    }) as "updated" | "missing" | "conflict";
  },

  async renameVersion(identity, documentId, versionId, filename) {
    return await mutate(cloudScope(identity), "rename_version", documentId, null,
      { version_id: versionId, filename }) === "updated";
  },

  async deleteVersion(identity, documentId, input) {
    return await mutate(cloudScope(identity), "delete_version", documentId,
      input.expectedCurrentVersionId, { version_id: input.versionId,
        current_version_id: input.nextCurrentVersionId,
        expected_blob_key: input.expectedBlobKey,
        expected_pdf_blob_key: input.expectedPdfBlobKey,
        expected_cleanup_paths: input.expectedCleanupKeys }) === "updated";
  },

  async deleteDocument(identity, documentId) {
    const scope = cloudScope(identity);
    return !!await run(scope.db.from("documents").delete().eq("id", documentId)
      .eq("user_id", scope.userId).select("id").maybeSingle(),
    "Failed to delete document");
  },

  async relocate(identity, documentId, input) {
    const scope = cloudScope(identity);
    return await mutate(scope, "relocate", documentId, null, {
      expected_project_id: input.expectedProjectId, project_id: input.projectId,
      folder_id: input.folderId, owner: input.owner,
    }) as "moved" | "missing" | "conflict";
  },

  async updateMetadata(identity, documentId, input) {
    const scope = cloudScope(identity);
    return !!await run(scope.db.from("documents").update({
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updated_at: new Date().toISOString(),
    }).eq("id", documentId).eq("user_id", scope.userId)
      .select("id").maybeSingle(), "Failed to update document metadata");
  },

  async clearCleanup(identity, documentId, versionId, keys) {
    await mutate(cloudScope(identity), "clear_cleanup", documentId, null,
      { version_id: versionId, keys });
  },

  async recordOrphan(identity, key) {
    const scope = cloudScope(identity);
    await run(scope.db.from("object_cleanup").upsert({
      storage_path: key, user_id: scope.userId,
    }), "Failed to record object cleanup");
  },

  async clearOrphan(scope, key) {
    const db = cloudScope({ userId: scope }).db;
    await run(db.from("object_cleanup").delete().eq("storage_path", key),
    "Failed to clear object cleanup");
  },

  async pendingOrphans(scope, limit = 100) {
    const db = cloudScope({ userId: scope }).db;
    const rows = await run(db.from("object_cleanup").select("storage_path")
      .order("created_at").limit(Math.max(1, Math.min(limit, 500))),
    "Failed to load object cleanup");
    return (rows ?? []).map((row: Row) => String(row.storage_path));
  },

  async pendingCleanup(scope, limit = 100) {
    const db = cloudScope({ userId: scope }).db;
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
