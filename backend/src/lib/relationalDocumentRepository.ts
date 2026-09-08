import { randomUUID } from "node:crypto";
import type { ApplicationScope } from "./applicationError";
import type { DocumentAggregate, DocumentHead, DocumentRepository, StoredDocument,
  StoredDocumentPart, StoredDocumentVersion, StoredPartChanges } from "./documentRepository";
import { decodePdfProfileSelection, type DocumentParseState, type StoredAssistantEdit } from "./documentStore";
import { pdfLifecycleMark } from "./pdfLifecycleDiagnostics";
import { normalizeDocumentMetadata, normalizeDocumentNotes } from "./normalize";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql,
  type RelationalDatabase } from "./relationalDatabase";
import { enqueuePdfPreparation } from "./pdfJobs";
import { documentBlobDigest, documentBlobKey } from "./storage";
import { changes, deleteDocumentRows, documentAccess, now, one, projectAccess,
  queueObjectCleanup, rows, type Row } from "./relationalRepositorySupport";

const CLEANUP_GRACE_MS = 60 * 60 * 1_000;
const CLEANUP_LEASE_MS = 5 * 60 * 1_000;
const scopedBlob = (key: string, userId: unknown, projectId: unknown,
  digest = documentBlobDigest(key)) => !!digest && key === documentBlobKey({
    userId: String(userId), projectId: typeof projectId === "string" ? projectId : null,
  }, digest);
const scopedVersion = (version: StoredDocumentVersion, userId: unknown, projectId: unknown) =>
  scopedBlob(version.blobKey, userId, projectId, version.sourceSha256) &&
  (!version.pdfBlobKey || scopedBlob(version.pdfBlobKey, userId, projectId));
const scopedParts = (parts: StoredDocumentPart[] | undefined, userId: unknown, projectId: unknown) =>
  (parts ?? []).every((part) => scopedBlob(part.blobKey, userId, projectId, part.sha256));

const pdfParseState = (row: Row): DocumentParseState | null => {
  const stored = decodePdfProfileSelection(decode(row.pdf_profile, null));
  const status = row.pdf_job_status;
  if (typeof status !== "string") return stored ? {
    status: stored.status,
    ...(Number.isSafeInteger(row.pdf_page_count) && Number(row.pdf_page_count) > 0
      ? { page_count: Number(row.pdf_page_count) } : {}),
  } : null;
  const progress = decode<Record<string, unknown>>(row.pdf_job_progress, {});
  const phase: DocumentParseState["phase"] =
    progress.phase === "inspecting" || progress.phase === "extracting" ||
    progress.phase === "ocr" ? progress.phase : undefined;
  const pages = Array.isArray(progress.pages) ? progress.pages
    .filter((page): page is number => Number.isInteger(page) && page > 0)
    .slice(0, 32) : undefined;
  const detail = { ...(phase ? { phase } : {}), ...(pages ? { pages } : {}) };
  if (status === "queued") return { status, ...detail };
  if (status === "running") return { status: "parsing", ...detail };
  if (status === "cancelled") return {
    status, ...detail, error: "PDF processing was cancelled",
  };
  if (status === "failed") return {
    status, ...detail, error: row.pdf_job_error === "PdfEncrypted"
      ? "PDF is password-protected. Remove its password, then upload it again."
      : "PDF processing failed",
  };
  if (status !== "succeeded") return null;
  const result = decode<Record<string, unknown>>(row.pdf_job_result, {});
  const routed = Array.isArray(result.ocrRoutedPages) ? result.ocrRoutedPages
    .filter((page): page is number => Number.isInteger(page) && page >= 0)
    .map((page) => page + 1).slice(0, 32) : [];
  const completed = { ...(routed.length ? { phase: "ocr" as const, pages: routed } : {}),
    ...(Number.isSafeInteger(result.pageCount) &&
    Number(result.pageCount) > 0 ? { page_count: Number(result.pageCount) } : {}) };
  if (result.status === "ready" || result.status === "degraded") {
    return { status: result.status, ...completed };
  }
  return null;
};
const storedDocument = (row: Row): StoredDocument => ({
  id: String(row.id), userId: String(row.user_id),
  projectId: typeof row.project_id === "string" ? row.project_id : null,
  libraryKind: row.library_kind === "template" ? "template" : "file",
  folderId: row.project_id ? row.folder_id ?? null : row.library_folder_id ?? null,
  status: String(row.status ?? "ready"), currentVersionId: String(row.current_version_id),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  metadata: normalizeDocumentMetadata(decode(row.metadata, {})),
  notes: normalizeDocumentNotes(row.notes),
  parseState: pdfParseState(row),
});
const storedVersion = (row: Row, prefix = ""): StoredDocumentVersion => {
  const value = (key: string) => row[`${prefix}${key}`];
  const profile = decodePdfProfileSelection(decode(value("pdf_profile"), null));
  const version: StoredDocumentVersion = {
    id: String(value("id")), documentId: String(value("document_id")),
    parentVersionId: typeof value("parent_version_id") === "string"
      ? value("parent_version_id") : null,
    versionNumber: Number(value("version_number")),
    workingRevision: Number(value("working_revision")), source: String(value("source")),
    createdBy: typeof value("created_by") === "string" ? String(value("created_by")) : null,
    ...(typeof value("author_email") === "string"
      ? { authorEmail: String(value("author_email")) } : {}),
    comment: typeof value("comment") === "string" ? String(value("comment")) : null,
    createdAt: String(value("created_at")), filename: String(value("filename")),
    fileType: String(value("file_type")), sizeBytes: Number(value("size_bytes")),
    pageCount: value("page_count") === null ? null : Number(value("page_count")),
    sourceSha256: String(value("source_sha256")), blobKey: String(value("storage_path")),
    pdfBlobKey: typeof value("pdf_storage_path") === "string"
      ? value("pdf_storage_path") : null,
    provenance: decode(value("provenance"), undefined),
    ...(profile ? { pdfProfile: profile } : {}),
  };
  const userId = row.owner_user_id ?? row.user_id;
  const projectId = row.owner_project_id ?? row.project_id;
  if (!scopedVersion(version, userId, projectId))
    throw new Error("Stored document belongs to a different storage scope");
  return version;
};
const storedPart = (row: Row): StoredDocumentPart => {
  const part = { documentId: String(row.document_id), versionId: String(row.version_id),
    name: String(row.name), sizeBytes: Number(row.size_bytes), sha256: String(row.sha256),
    blobKey: String(row.storage_path) };
  if (!scopedBlob(part.blobKey, row.user_id, row.project_id, part.sha256))
    throw new Error("Stored document part failed its integrity check");
  return part;
};
const storedEdit = (row: Row): StoredAssistantEdit & { versionId: string } => ({
  id: String(row.id), versionId: String(row.version_id), changeId: String(row.change_id),
  ...(row.del_w_id ? { delWId: String(row.del_w_id) } : {}),
  ...(row.ins_w_id ? { insWId: String(row.ins_w_id) } : {}),
  deletedText: String(row.deleted_text ?? ""), insertedText: String(row.inserted_text ?? ""),
  contextBefore: String(row.context_before ?? ""), contextAfter: String(row.context_after ?? ""),
  ...(row.reason ? { reason: String(row.reason) } : {}),
  diff: decode(row.diff, []),
  status: row.status === "accepted" || row.status === "rejected" ? row.status : "pending",
});

async function working(db: RelationalDatabase, scope: ApplicationScope,
  documentId: string, owner = false, lock = false): Promise<DocumentAggregate | null> {
  const current = await head(db, scope, documentId, owner, lock);
  if (!current) return null;
  const edits = await rows(sql`SELECT * FROM document_edits WHERE document_id=${documentId}
    AND version_id=${current.document.currentVersionId}`, db);
  return { ...current, edits: edits.map(storedEdit) };
}

async function addVersion(
  db: RelationalDatabase,
  version: StoredDocumentVersion,
  userId: string,
  ocrProvider?: import("./documentStore").LegalPdfOcrProvider | null,
) {
  await changes(sql`INSERT INTO document_versions(id,document_id,parent_version_id,version_number,
    working_revision,source,created_by,author_email,comment,
    created_at,filename,file_type,size_bytes,page_count,source_sha256,storage_path,
    pdf_storage_path,pdf_profile,provenance) VALUES(${version.id},${version.documentId},
    ${version.parentVersionId},
    ${version.versionNumber},${version.workingRevision},${version.source},${version.createdBy},
    ${version.authorEmail ?? null},${version.comment},${version.createdAt},${version.filename},
    ${version.fileType},${version.sizeBytes},${version.pageCount},${version.sourceSha256},
    ${version.blobKey},${version.pdfBlobKey},${version.pdfProfile ? encode(version.pdfProfile) : null},
    ${version.provenance ? encode(version.provenance) : null})`, db);
  if (version.fileType === "pdf" && !version.pdfProfile) await enqueuePdfPreparation({
    userId,
    documentId: version.documentId,
    versionId: version.id,
    sourceSha256: version.sourceSha256,
    ...(ocrProvider !== undefined ? { ocrProvider } : {}),
  }, db);
}
const versionKeys = (version: StoredDocumentVersion) =>
  [...new Set([version.blobKey, version.pdfBlobKey].filter((key): key is string => !!key))];
const partKeys = (parts: StoredDocumentPart[] = []) => parts.map(({ blobKey }) => blobKey);
async function publishBlobs(db: RelationalDatabase, values: string[]) {
  values = [...new Set(values)];
  if (!values.length) return true;
  const references = async (keys: string[]) => {
    const versions = await rows<{ storage_path: string; pdf_storage_path: string | null }>(sql`
      SELECT v.storage_path,v.pdf_storage_path FROM document_versions v
      WHERE v.storage_path IN(${sql.join(keys)}) OR v.pdf_storage_path IN(${sql.join(keys)})
      ${db.engine === "postgres" ? sql.raw("FOR SHARE OF v") : sql.raw("")}`, db);
    const parts = await rows<{ storage_path: string }>(sql`SELECT p.storage_path
      FROM document_version_parts p WHERE p.storage_path IN(${sql.join(keys)})
      ${db.engine === "postgres" ? sql.raw("FOR SHARE OF p") : sql.raw("")}`, db);
    return new Set([...versions.flatMap(({ storage_path, pdf_storage_path }) =>
      [storage_path, pdf_storage_path].filter((key): key is string => !!key)),
    ...parts.map(({ storage_path }) => storage_path)]);
  };
  for (let start = 0; start < values.length; start += 200) {
    const batch = values.slice(start, start + 200), referenced = await references(batch);
    const queued = await rows<{ storage_path: string; claim_id: string | null }>(sql`
      SELECT c.storage_path,c.claim_id FROM object_cleanup c
      WHERE c.storage_path IN(${sql.join(batch)})
      ${db.engine === "postgres" ? sql.raw("FOR UPDATE OF c") : sql.raw("")}`, db);
    const available = new Set(queued.map(({ storage_path }) => storage_path));
    const missing = batch.filter((key) => !referenced.has(key) && !available.has(key));
    const refreshed = missing.length ? await references(missing) : referenced;
    if (queued.some(({ claim_id }) => claim_id !== null) ||
        missing.some((key) => !refreshed.has(key))) return false;
    if (queued.length && await changes(sql`DELETE FROM object_cleanup
      WHERE storage_path IN(${sql.join(batch)}) AND claim_id IS NULL`, db) !== queued.length)
      return false;
  }
  return true;
}
async function writeParts(db: RelationalDatabase, documentId: string, versionId: string,
  update?: StoredPartChanges, cloneFrom?: string) {
  if (cloneFrom) await changes(sql`INSERT INTO document_version_parts(
    document_id,version_id,name,size_bytes,sha256,storage_path)
    SELECT document_id,${versionId},name,size_bytes,sha256,storage_path
    FROM document_version_parts WHERE document_id=${documentId} AND version_id=${cloneFrom}`, db);
  if (!update) return;
  for (let start = 0; start < update.remove.length; start += 200) await changes(sql`
    DELETE FROM document_version_parts WHERE document_id=${documentId} AND version_id=${versionId}
      AND name IN(${sql.join(update.remove.slice(start, start + 200))})`, db);
  for (let start = 0; start < update.put.length; start += 100) {
    const batch = update.put.slice(start, start + 100);
    await changes(sql`INSERT INTO document_version_parts(document_id,version_id,name,
      size_bytes,sha256,storage_path) VALUES ${sql.join(batch.map((part) => sql`(
        ${documentId},${versionId},${part.name},${part.sizeBytes},${part.sha256},${part.blobKey})`))}
      ON CONFLICT(version_id,name) DO UPDATE SET size_bytes=excluded.size_bytes,
        sha256=excluded.sha256,storage_path=excluded.storage_path`, db);
  }
}
async function addEdits(db: RelationalDatabase, documentId: string, versionId: string,
  edits: StoredAssistantEdit[] = []) {
  if (!edits.length) return;
  const resolvedAt = now();
  await changes(sql`INSERT INTO document_edits(id,document_id,version_id,change_id,del_w_id,
    ins_w_id,deleted_text,inserted_text,context_before,context_after,reason,diff,status,resolved_at)
    VALUES ${sql.join(edits.map((edit) => sql`(${edit.id},${documentId},${versionId},
      ${edit.changeId},${edit.delWId ?? null},${edit.insWId ?? null},${edit.deletedText},
      ${edit.insertedText},${edit.contextBefore},${edit.contextAfter},${edit.reason ?? null},
      ${encode(edit.diff)},${edit.status},${edit.status === "pending" ? null : resolvedAt})`))}`, db);
}

async function authorizeCreate(db: RelationalDatabase, scope: ApplicationScope, input: {
  projectId: string | null; libraryKind: "file" | "template"; folderId: string | null;
}, lock = false): Promise<Awaited<ReturnType<DocumentRepository["authorizeCreate"]>>> {
  const share = (alias: string) => lock && db.engine === "postgres"
    ? sql.raw(`FOR SHARE OF ${alias}`) : sql.raw("");
  if (input.projectId) {
    if (!await one(sql`SELECT 1 ok FROM projects p WHERE p.id=${input.projectId}
      AND ${projectAccess(scope)} ${share("p")}`, db)) return "project-missing";
    if (input.folderId && !await one(sql`SELECT 1 ok FROM project_subfolders f
      WHERE f.id=${input.folderId} AND f.project_id=${input.projectId} ${share("f")}`, db))
      return "folder-missing";
  } else if (input.folderId && !await one(sql`SELECT 1 ok FROM library_folders f
    WHERE f.id=${input.folderId} AND f.user_id=${scope.userId}
      AND f.library_kind=${input.libraryKind} ${share("f")}`, db)) return "folder-missing";
  return "ok";
}

async function lockRelocationRoots(db: RelationalDatabase, scope: ApplicationScope,
  sourceProjectId: string | null, targetProjectId: string | null) {
  if (db.engine !== "postgres") return true;
  if ((!sourceProjectId || !targetProjectId) && !await one(sql`SELECT id FROM auth.users
    WHERE id=${scope.userId} FOR SHARE`, db)) return false;
  const ids = [...new Set([sourceProjectId, targetProjectId]
    .filter((id): id is string => !!id))].sort();
  if (!ids.length) return true;
  return (await rows(sql`SELECT p.id FROM projects p WHERE p.id IN(${sql.join(ids)})
    AND ${projectAccess(scope)} ORDER BY p.id FOR SHARE OF p`, db)).length === ids.length;
}

async function lockDocuments(db: RelationalDatabase, scope: ApplicationScope,
  ids: string[], owner = false) {
  // Lock first, then read joined versions in a fresh READ COMMITTED snapshot.
  if (db.engine === "postgres") await rows(sql`SELECT d.id FROM documents d
    WHERE d.id IN(${sql.join(ids)}) AND ${documentAccess(scope, owner)}
    ORDER BY d.id FOR UPDATE OF d`, db);
}

async function heads(db: RelationalDatabase, scope: ApplicationScope, documentIds: string[],
  owner = false, lock = false): Promise<DocumentHead[]> {
  if (!documentIds.length) return [];
  if (lock) await lockDocuments(db, scope, documentIds, owner);
  const found = await rows(sql`SELECT d.*,v.page_count pdf_page_count,v.pdf_profile,
    v.id head_id,v.document_id head_document_id,v.parent_version_id head_parent_version_id,
    v.version_number head_version_number,v.working_revision head_working_revision,
    v.source head_source,v.created_by head_created_by,v.author_email head_author_email,
    v.comment head_comment,
    v.created_at head_created_at,v.filename head_filename,
    v.file_type head_file_type,v.size_bytes head_size_bytes,v.page_count head_page_count,
    v.source_sha256 head_source_sha256,v.storage_path head_storage_path,
    v.pdf_storage_path head_pdf_storage_path,v.pdf_profile head_pdf_profile,
    v.provenance head_provenance,j.status pdf_job_status,j.progress pdf_job_progress,
    j.result pdf_job_result,j.last_error pdf_job_error
    FROM documents d JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id
    LEFT JOIN application_jobs j ON j.id=(SELECT q.id FROM application_jobs q
      WHERE q.document_id=d.id AND q.document_version_id=d.current_version_id
        AND q.kind IN('pdf.prepare','pdf.reprocess')
      ORDER BY q.updated_at DESC,q.id DESC LIMIT 1)
    WHERE d.id IN(${sql.join(documentIds)}) AND ${documentAccess(scope, owner)}`, db);
  return found.map((row) => ({ document: storedDocument(row), versions: [storedVersion(row, "head_")] }));
}
const head = async (db: RelationalDatabase, scope: ApplicationScope, documentId: string,
  owner = false, lock = false) => (await heads(db, scope, [documentId], owner, lock))[0] ?? null;

export const documentRepository: DocumentRepository = {
  async authorizeCreate(scope, input) {
    return authorizeCreate(await relationalDatabase(), scope, input);
  },
  async version(scope, documentId, versionId) {
    const row = await one(sql`SELECT v.*,d.user_id,d.project_id FROM documents d JOIN document_versions v
      ON v.document_id=d.id AND v.id=COALESCE(${versionId},d.current_version_id)
      WHERE d.id=${documentId} AND ${documentAccess(scope)}`);
    return row ? storedVersion(row) : null;
  },
  async currentVersions(scope, documentIds) {
    const ids = [...new Set(documentIds)];
    if (!ids.length) return [];
    return (await rows(sql`SELECT v.*,d.user_id,d.project_id FROM documents d
      JOIN document_versions v ON v.document_id=d.id AND v.id=d.current_version_id
      WHERE d.id IN(${sql.join(ids)}) AND ${documentAccess(scope)}`)).map((row) => storedVersion(row));
  },
  async parts(scope, documentId, versionId, names) {
    const selected = [...new Set(names)];
    if (!selected.length) return [];
    const found = await rows(sql`SELECT d.user_id,d.project_id,p.* FROM documents d
      JOIN document_versions v ON v.document_id=d.id
        AND v.id=COALESCE(${versionId},d.current_version_id)
      LEFT JOIN document_version_parts p ON p.document_id=d.id AND p.version_id=v.id
        AND p.name IN(${sql.join(selected)})
      WHERE d.id=${documentId} AND ${documentAccess(scope)}`);
    return found.length ? found.filter(({ name }) => name !== null).map(storedPart) : null;
  },
  async hasPendingEdits(scope, documentId, versionIds) {
    const ids = [...new Set(versionIds)];
    return !!ids.length && !!await one(sql`SELECT 1 FROM documents d JOIN document_edits e
      ON e.document_id=d.id WHERE d.id=${documentId} AND e.version_id IN(${sql.join(ids)})
      AND e.status='pending' AND ${documentAccess(scope)} LIMIT 1`);
  },
  async head(scope, documentId, owner = false) {
    return head(await relationalDatabase(), scope, documentId, owner);
  },
  async heads(scope, documentIds, owner = false) {
    return heads(await relationalDatabase(), scope, documentIds, owner);
  },
  async history(scope, documentId, includeParts = false) {
    const db = await relationalDatabase();
    const history = await rows(sql`SELECT v.*,d.user_id,d.project_id,d.current_version_id FROM documents d
      JOIN document_versions v ON v.document_id=d.id WHERE d.id=${documentId}
        AND ${documentAccess(scope)} ORDER BY v.version_number DESC`, db);
    const parts = includeParts && history.length ? (await rows(sql`SELECT d.user_id,d.project_id,p.*
      FROM documents d JOIN document_version_parts p ON p.document_id=d.id
      WHERE d.id=${documentId} AND ${documentAccess(scope)}`, db)).map(storedPart) : undefined;
    return history.length ? { currentVersionId: String(history[0].current_version_id),
      versions: history.map((row) => storedVersion(row)), ...(parts ? { parts } : {}) } : null;
  },
  async create(scope, input) {
    if (input.document.userId !== scope.userId ||
        input.version.documentId !== input.document.id ||
        input.document.currentVersionId !== input.version.id)
      throw new Error("Document version belongs to a different document");
    if (input.version.parentVersionId !== null) throw new Error("Initial version cannot have a parent");
    if (input.parts?.some((part) => part.documentId !== input.document.id ||
        part.versionId !== input.version.id)) throw new Error("Document part belongs to a different version");
    const db = await relationalDatabase();
    const created = await db.transaction(async (tx) => {
      const { document, version } = input;
      if (await authorizeCreate(tx, scope, { projectId: document.projectId,
        libraryKind: document.libraryKind, folderId: document.folderId }, true) !== "ok") return false;
      if (!scopedVersion(version, document.userId, document.projectId) ||
          !scopedParts(input.parts, document.userId, document.projectId)) return false;
      if (!await publishBlobs(tx, [...versionKeys(version), ...partKeys(input.parts)])) return false;
      await changes(sql`INSERT INTO documents(id,user_id,project_id,folder_id,
        library_kind,library_folder_id,status,current_version_id,metadata,notes,filename,
        created_at,updated_at) VALUES(${document.id},${scope.userId},${document.projectId},
        ${document.projectId ? document.folderId : null},${document.libraryKind},
        ${document.projectId ? null : document.folderId},${document.status},${version.id},
        ${encode(document.metadata ?? {})},${document.notes ?? null},${version.filename},
        ${document.createdAt},${document.updatedAt})`, tx);
      await addVersion(tx, version, scope.userId, input.pdfOcrProvider);
      await writeParts(tx, document.id, version.id,
        input.parts ? { put: input.parts, remove: [] } : undefined);
      return true;
    });
    if (created && input.version.fileType === "pdf" && !input.version.pdfProfile)
      pdfLifecycleMark("queue.enqueued", input.document.id);
    return created;
  },
  async get(scope, id, owner = false) {
    return working(await relationalDatabase(), scope, id, owner);
  },
  async parseStates(scope, ids) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    return (await rows(sql`SELECT d.id,v.page_count pdf_page_count,v.pdf_profile,
      j.status pdf_job_status,
      j.progress pdf_job_progress,j.result pdf_job_result,j.last_error pdf_job_error
      FROM documents d JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id
        LEFT JOIN application_jobs j ON j.id=(SELECT q.id
        FROM application_jobs q WHERE q.document_id=d.id
          AND q.document_version_id=d.current_version_id
          AND q.kind IN('pdf.prepare','pdf.reprocess')
        ORDER BY q.updated_at DESC,q.id DESC LIMIT 1)
      WHERE d.id IN(${sql.join(unique)}) AND ${documentAccess(scope)}`))
      .map((row) => ({ id: String(row.id), parseState: pdfParseState(row) }));
  },
  async deleteDocuments(scope, projectIds, includeOwned) {
    if (!includeOwned && !projectIds.length) return 0;
    const db = await relationalDatabase(), selectedProjects = [...new Set(projectIds)],
      projects = selectedProjects.length ? sql.join(selectedProjects) : sql.raw("NULL");
    return db.transaction(async (tx) => {
      if (selectedProjects.length) await rows(sql`SELECT p.id FROM projects p
        WHERE p.id IN(${projects}) AND ${projectAccess(scope)}
        ${tx.engine === "postgres" ? sql.raw("FOR UPDATE OF p") : sql.raw("")}`, tx);
      const ids = (await rows<{ id: string }>(sql`SELECT d.id FROM documents d WHERE
        (${includeOwned ? 1 : 0}=1 AND d.user_id=${scope.userId}) OR
        (d.project_id IN(${projects}) AND ${documentAccess(scope)})
        ${tx.engine === "postgres" ? sql.raw("FOR UPDATE OF d") : sql.raw("")}`, tx))
        .map(({ id }) => id);
      return deleteDocumentRows(tx, ids);
    });
  },
  async insertVersion(scope, id, input) {
    if (input.version.documentId !== id)
      throw new Error("Document version belongs to a different document");
    if (input.parts?.put.some((part) => part.documentId !== id ||
        part.versionId !== input.version.id)) throw new Error("Document part belongs to a different version");
    const db = await relationalDatabase();
    const result = await db.transaction(async (tx) => {
      await lockDocuments(tx, scope, [id]);
      const document = await one(sql`SELECT d.current_version_id,d.user_id,d.project_id,
          CASE WHEN d.project_id IS NULL THEN d.library_folder_id ELSE d.folder_id END current_folder_id,
          v.working_revision current_working_revision,
          v.version_number current_version_number FROM documents d
        JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id
        WHERE d.id=${id} AND ${documentAccess(scope)}`, tx);
      if (!document) return "missing";
      if (document.current_version_id !== input.expectedCurrentVersionId ||
          Number(document.current_working_revision) !== input.expectedCurrentWorkingRevision ||
          input.expectedProjectId !== undefined &&
          (typeof document.project_id === "string" ? document.project_id : null) !==
            input.expectedProjectId ||
          input.expectedFolderId !== undefined &&
          (typeof document.current_folder_id === "string" ? document.current_folder_id : null) !==
            input.expectedFolderId ||
          input.version.versionNumber !== Number(document.current_version_number) + 1 ||
          input.version.parentVersionId !== input.expectedCurrentVersionId) return "conflict";
      if (input.clonePartsFromVersionId && !await one(sql`SELECT 1 ok FROM document_versions
        WHERE document_id=${id} AND id=${input.clonePartsFromVersionId}`, tx)) return "conflict";
      const keys = [...versionKeys(input.version), ...partKeys(input.parts?.put)];
      if (!scopedVersion(input.version, document.user_id, document.project_id) ||
          !scopedParts(input.parts?.put, document.user_id, document.project_id) ||
          !await publishBlobs(tx, keys)) return "conflict";
      const changed = await changes(sql`UPDATE documents SET current_version_id=${input.version.id},
        updated_at=${input.version.createdAt},filename=${input.version.filename}
        WHERE id=${id} AND current_version_id=${input.expectedCurrentVersionId}`, tx);
      if (!changed) return "conflict";
      await addVersion(tx, input.version, String(document.user_id));
      await writeParts(tx, id, input.version.id, input.parts, input.clonePartsFromVersionId);
      await addEdits(tx, id, input.version.id, input.edits);
      return "created";
    });
    return result;
  },
  async updateVersion(scope, id, input) {
    if (input.bumpWorkingRevision !== false && !input.expectedCurrentVersionId)
      throw new Error("Working-version updates require the expected document head");
    if (input.bumpWorkingRevision === false && input.expectedPdfBlobKey === undefined)
      throw new Error("Derived-version updates require the expected PDF blob");
    if (input.parts?.put.some((part) => part.documentId !== id ||
        part.versionId !== input.versionId)) throw new Error("Document part belongs to a different version");
    const db = await relationalDatabase();
    const result = await db.transaction(async (tx) => {
      await lockDocuments(tx, scope, [id]);
      const row = await one(sql`SELECT v.*,d.current_version_id,d.user_id owner_user_id,
          d.project_id owner_project_id
        FROM documents d JOIN document_versions v ON v.document_id=d.id
        WHERE d.id=${id} AND v.id=${input.versionId} AND ${documentAccess(scope)}
        ${tx.engine === "postgres" ? sql.raw("FOR UPDATE OF d,v") : sql.raw("")}`, tx);
      if (!row) return "missing";
      const version = storedVersion(row);
      if (version.blobKey !== input.expectedBlobKey ||
          input.expectedPdfBlobKey !== undefined &&
          version.pdfBlobKey !== input.expectedPdfBlobKey ||
          version.workingRevision !== input.expectedWorkingRevision ||
          input.expectedCurrentVersionId &&
          row.current_version_id !== input.expectedCurrentVersionId) return "conflict";
      if (input.resolveEdits) {
        const ids = [...new Set(input.resolveEdits.ids)];
        if (!ids.length) return "conflict";
        const found = await rows(sql`SELECT id FROM document_edits WHERE document_id=${id}
          AND version_id=${input.versionId} AND id IN(${sql.join(ids)})`, tx);
        if (found.length !== ids.length) return "conflict";
      }
      const update = { ...version, ...Object.fromEntries(Object.entries(input.update)
        .filter(([, value]) => value !== undefined)) };
      if (!scopedVersion(update, row.owner_user_id, row.owner_project_id) ||
          !scopedParts(input.parts?.put, row.owner_user_id, row.owner_project_id)) return "conflict";
      const previous = new Set(versionKeys(version));
      if (!await publishBlobs(tx, [...versionKeys(update).filter((key) => !previous.has(key)),
        ...partKeys(input.parts?.put)]))
        return "conflict";
      const partNames = [...new Set([...(input.parts?.remove ?? []),
        ...(input.parts?.put.map(({ name }) => name) ?? [])])];
      const oldPartKeys: string[] = [];
      for (let start = 0; start < partNames.length; start += 200)
        oldPartKeys.push(...(await rows<{ storage_path: string }>(sql`SELECT storage_path
          FROM document_version_parts WHERE document_id=${id} AND version_id=${input.versionId}
            AND name IN(${sql.join(partNames.slice(start, start + 200))})`, tx))
          .map(({ storage_path }) => storage_path));
      const pdfProfile = update.fileType === "pdf" &&
        update.sourceSha256 === version.sourceSha256 ? update.pdfProfile : undefined;
      const changed = await changes(sql`UPDATE document_versions SET
        created_at=${update.createdAt},filename=${update.filename},file_type=${update.fileType},
        size_bytes=${update.sizeBytes},page_count=${update.pageCount},
        source_sha256=${update.sourceSha256},storage_path=${update.blobKey},
        pdf_storage_path=${update.pdfBlobKey},pdf_profile=${pdfProfile ? encode(pdfProfile) : null},
        provenance=${update.provenance ? encode(update.provenance) : null},
        working_revision=working_revision+${input.bumpWorkingRevision === false ? 0 : 1}
        WHERE id=${input.versionId} AND document_id=${id}
          AND storage_path=${input.expectedBlobKey}
          AND (${input.expectedPdfBlobKey === undefined ? 1 : 0}=1 OR
            COALESCE(pdf_storage_path,'')=${input.expectedPdfBlobKey ?? ""})
          AND working_revision=${input.expectedWorkingRevision}
          AND (${input.expectedCurrentVersionId ? 0 : 1}=1 OR EXISTS(
            SELECT 1 FROM documents d WHERE d.id=${id}
              AND d.current_version_id=${input.expectedCurrentVersionId ?? ""}))`, tx);
      if (!changed) return "conflict";
      await writeParts(tx, id, input.versionId, input.parts);
      await addEdits(tx, id, input.versionId, input.edits);
      if (input.resolveEdits) await changes(sql`UPDATE document_edits SET
        status=${input.resolveEdits.status},resolved_at=${now()} WHERE id IN(${sql.join(input.resolveEdits.ids)})
        AND document_id=${id} AND version_id=${input.versionId}`, tx);
      if (input.bumpWorkingRevision !== false) await changes(sql`UPDATE documents
        SET updated_at=${now()},filename=${update.filename}
        WHERE id=${id} AND current_version_id=${input.versionId}`, tx);
      const retained = new Set(versionKeys(update));
      await queueObjectCleanup(tx, [...versionKeys(version).filter((key) => !retained.has(key)),
        ...oldPartKeys.filter((key) => !input.parts?.put.some((part) => part.blobKey === key))]);
      if (update.fileType === "pdf" && !pdfProfile) {
        await enqueuePdfPreparation({
          userId: String(row.owner_user_id),
          documentId: id,
          versionId: update.id,
          sourceSha256: update.sourceSha256,
        }, tx);
      }
      return "updated";
    });
    return result;
  },
  async recordPdfPreparation(scope, id, input) {
    return await changes(sql`UPDATE document_versions SET page_count=${input.pageCount},
      pdf_profile=${encode(input.pdfProfile)}
      WHERE id=${input.versionId}
        AND document_id=${id} AND source_sha256=${input.sourceSha256} AND file_type='pdf'
        AND EXISTS(SELECT 1 FROM documents d WHERE d.id=document_versions.document_id
          AND d.current_version_id=document_versions.id AND ${documentAccess(scope)})`) > 0;
  },
  async deleteVersion(scope, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await head(tx, scope, id, false, true);
      const version = current?.versions.find(({ id: versionId }) => versionId === input.versionId);
      if (!current || !version || current.document.currentVersionId !== input.expectedCurrentVersionId ||
          version.blobKey !== input.expectedBlobKey || version.pdfBlobKey !== input.expectedPdfBlobKey ||
          version.workingRevision !== input.expectedWorkingRevision ||
          current.document.projectId !== input.expectedProjectId ||
          current.document.folderId !== input.expectedFolderId ||
          input.versionId !== input.expectedCurrentVersionId ||
          input.nextCurrentVersionId === input.versionId ||
          version.parentVersionId !== input.nextCurrentVersionId) return false;
      if (!await changes(sql`UPDATE documents SET current_version_id=${input.nextCurrentVersionId},
        filename=(SELECT filename FROM document_versions
          WHERE id=${input.nextCurrentVersionId} AND document_id=${id}),updated_at=${now()}
        WHERE id=${id} AND current_version_id=${input.expectedCurrentVersionId}
          AND COALESCE(project_id,'')=${input.expectedProjectId ?? ""}
          AND COALESCE(CASE WHEN project_id IS NULL THEN library_folder_id ELSE folder_id END,'')=
            ${input.expectedFolderId ?? ""}`, tx))
        return false;
      const partObjects = await rows<{ storage_path: string }>(sql`SELECT storage_path
        FROM document_version_parts WHERE document_id=${id} AND version_id=${input.versionId}`, tx);
      const deleted = await changes(sql`DELETE FROM document_versions WHERE id=${input.versionId}
        AND document_id=${id}`, tx) > 0;
      if (deleted) await queueObjectCleanup(tx,
        [...versionKeys(version), ...partObjects.map(({ storage_path }) => storage_path)]);
      return deleted;
    });
  },
  async deleteDocument(scope, id, owner = true, expected) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await head(tx, scope, id, owner, true);
      if (!current) return false;
      const version = current.versions[0];
      if (expected && (version.id !== expected.versionId ||
          version.workingRevision !== expected.workingRevision ||
          current.document.projectId !== expected.projectId ||
          current.document.folderId !== expected.folderId)) return false;
      return await deleteDocumentRows(tx, [id]) > 0;
    });
  },
  async relocate(scope, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (!await lockRelocationRoots(
        tx, scope, input.expectedProjectId, input.projectId)) return "missing";
      const current = await head(tx, scope, id, input.owner, true);
      if (!current) return "missing";
      if (current.document.projectId !== input.expectedProjectId ||
          current.document.folderId !== input.expectedFolderId) return "conflict";
      if (await authorizeCreate(tx, scope, { projectId: input.projectId,
        libraryKind: current.document.libraryKind, folderId: input.folderId }, true) !== "ok")
        return "missing";
      const rewrites = new Map(input.versions.map((version) => [version.versionId, version]));
      const partRewrites = new Map(input.parts.map((part) =>
        [`${part.versionId}\0${part.name}`, part]));
      if (rewrites.size !== input.versions.length || partRewrites.size !== input.parts.length)
        return "conflict";
      const changingScope = current.document.projectId !== input.projectId;
      if (changingScope) {
        const stored = await rows<{ id: string; source_sha256: string; storage_path: string;
          pdf_storage_path: string | null }>(sql`SELECT id,source_sha256,storage_path,pdf_storage_path
          FROM document_versions WHERE document_id=${id}
          ${tx.engine === "postgres" ? sql.raw("FOR UPDATE") : sql.raw("")}`, tx);
        const storedParts = await rows<{ version_id: string; name: string; sha256: string;
          storage_path: string }>(sql`
          SELECT version_id,name,sha256,storage_path FROM document_version_parts WHERE document_id=${id}
          ${tx.engine === "postgres" ? sql.raw("FOR UPDATE") : sql.raw("")}`, tx);
        if (stored.length !== rewrites.size || stored.some((version) => {
          const rewrite = rewrites.get(version.id), pdfDigest = version.pdf_storage_path &&
            documentBlobDigest(version.pdf_storage_path);
          return !rewrite || rewrite.expectedBlobKey !== version.storage_path ||
            rewrite.expectedPdfBlobKey !== version.pdf_storage_path ||
            !scopedBlob(rewrite.blobKey, current.document.userId,
              input.projectId, version.source_sha256) || (version.pdf_storage_path
                ? !rewrite.pdfBlobKey || !pdfDigest || !scopedBlob(rewrite.pdfBlobKey,
                  current.document.userId, input.projectId, pdfDigest)
                : rewrite.pdfBlobKey !== null);
        }) || storedParts.length !== partRewrites.size || storedParts.some((part) => {
          const rewrite = partRewrites.get(`${part.version_id}\0${part.name}`);
          return !rewrite || rewrite.expectedBlobKey !== part.storage_path ||
            !scopedBlob(rewrite.blobKey, current.document.userId, input.projectId, part.sha256);
        }))
          return "conflict";
      } else if (rewrites.size || partRewrites.size) return "conflict";
      const nextKeys = [...new Set(input.versions.flatMap((version) =>
        [version.blobKey, version.pdfBlobKey].filter((key): key is string => !!key))
        .concat(input.parts.map(({ blobKey }) => blobKey)))];
      if (!await publishBlobs(tx, nextKeys)) return "conflict";
      const updatedAt = now();
      const changed = await changes(sql`UPDATE documents SET project_id=${input.projectId},
        folder_id=${input.projectId ? input.folderId : null},
        library_folder_id=${input.projectId ? null : input.folderId},updated_at=${updatedAt}
        WHERE id=${id} AND COALESCE(project_id,'')=${input.expectedProjectId ?? ""}
          AND COALESCE(CASE WHEN project_id IS NULL THEN library_folder_id ELSE folder_id END,'')=
            ${input.expectedFolderId ?? ""}`, tx);
      if (!changed) return "conflict";
      for (let index = 0; index < input.versions.length; index += 250) {
        const batch = input.versions.slice(index, index + 250);
        if (await changes(sql`WITH rewrites(id,storage_path,pdf_storage_path) AS (VALUES
          ${sql.join(batch.map((version) => sql`(${version.versionId},${version.blobKey},
            ${version.pdfBlobKey})`))}) UPDATE document_versions AS v
          SET storage_path=r.storage_path,pdf_storage_path=r.pdf_storage_path
          FROM rewrites r WHERE v.id=r.id AND v.document_id=${id}`, tx) !== batch.length)
          throw new Error("Document versions changed during relocation");
      }
      for (let index = 0; index < input.parts.length; index += 100) {
        const batch = input.parts.slice(index, index + 100);
        if (await changes(sql`WITH rewrites(version_id,name,storage_path) AS (VALUES
          ${sql.join(batch.map((part) => sql`(${part.versionId},${part.name},${part.blobKey})`))})
          UPDATE document_version_parts AS p SET storage_path=r.storage_path
          FROM rewrites r WHERE p.document_id=${id} AND p.version_id=r.version_id
            AND p.name=r.name`, tx) !== batch.length)
          throw new Error("Document parts changed during relocation");
      }
      await queueObjectCleanup(tx, input.versions.flatMap((version) =>
        [version.expectedBlobKey, version.expectedPdfBlobKey]
          .filter((key): key is string => !!key))
        .concat(input.parts.map(({ expectedBlobKey }) => expectedBlobKey)));
      const headRewrite = rewrites.get(current.versions[0].id);
      return { ...current, document: { ...current.document,
        projectId: input.projectId, folderId: input.folderId, updatedAt },
        versions: headRewrite ? [{ ...current.versions[0], blobKey: headRewrite.blobKey,
          pdfBlobKey: headRewrite.pdfBlobKey }] : current.versions };
    });
  },
  async updateMetadata(scope, id, input) {
    const set = [input.metadata === undefined ? null
      : sql`metadata=${encode(normalizeDocumentMetadata(input.metadata))}`,
    input.notes === undefined ? null : sql`notes=${normalizeDocumentNotes(input.notes)}`]
      .filter((value) => value !== null);
    return !!set.length && await changes(sql`UPDATE documents
      SET ${sql.join(set)},updated_at=${now()} WHERE id=${id} AND user_id=${scope.userId}`) > 0;
  },
  async recordOrphans(keys) {
    const expired = new Date(Date.now() - CLEANUP_LEASE_MS).toISOString();
    const busy = new Error("busy"), db = await relationalDatabase(), unique = [...new Set(keys)];
    try {
      return await db.transaction(async (tx) => {
        for (let index = 0; index < unique.length; index += 250) {
          const batch = unique.slice(index, index + 250);
          if (await changes(sql`INSERT INTO object_cleanup(storage_path,created_at) VALUES
            ${sql.join(batch.map((key) => sql`(${key},${now()})`))}
            ON CONFLICT(storage_path) DO UPDATE SET created_at=excluded.created_at,
              claim_id=NULL,claimed_at=NULL WHERE object_cleanup.claim_id IS NULL
              OR object_cleanup.claimed_at<=${expired}`, tx) !== batch.length) throw busy;
        }
        return "staged" as const;
      });
    } catch (error) {
      if (error === busy) return "busy";
      throw error;
    }
  },
  async removeOrphan(key, claimId, remove) {
    const db = await relationalDatabase();
    let failure: unknown, failed = false;
    const removed = await db.transaction(async (tx) => {
      if (!await one(sql`SELECT 1 ok FROM object_cleanup c
        WHERE c.storage_path=${key} AND c.claim_id=${claimId}
        ${tx.engine === "postgres" ? sql.raw("FOR UPDATE OF c") : sql.raw("")}`, tx))
        return false;
      const referenced = await one(sql`SELECT 1 ok FROM document_versions v
        WHERE v.storage_path=${key} OR v.pdf_storage_path=${key} LIMIT 1
        ${tx.engine === "postgres" ? sql.raw("FOR SHARE OF v") : sql.raw("")}`, tx) ||
        await one(sql`SELECT 1 ok FROM document_version_parts p
          WHERE p.storage_path=${key} LIMIT 1
          ${tx.engine === "postgres" ? sql.raw("FOR SHARE OF p") : sql.raw("")}`, tx);
      if (referenced) {
        await changes(sql`DELETE FROM object_cleanup WHERE storage_path=${key}
          AND claim_id=${claimId}`, tx);
        return false;
      }
      try { await remove(); }
      catch (error) {
        failed = true; failure = error;
        await changes(sql`UPDATE object_cleanup SET claim_id=NULL,claimed_at=NULL,created_at=${now()}
          WHERE storage_path=${key} AND claim_id=${claimId}`, tx);
        return false;
      }
      return await changes(sql`DELETE FROM object_cleanup
        WHERE storage_path=${key} AND claim_id=${claimId}`, tx) > 0;
    });
    if (failed) throw failure;
    return removed;
  },
  async pendingOrphans(limit = 100) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const before = new Date(Date.now() - CLEANUP_GRACE_MS).toISOString();
      const expired = new Date(Date.now() - CLEANUP_LEASE_MS).toISOString();
      const candidates = await rows<{ storage_path: string }>(sql`SELECT storage_path
        FROM object_cleanup c WHERE c.created_at<=${before}
          AND (c.claim_id IS NULL OR c.claimed_at<=${expired})
          AND NOT EXISTS(SELECT 1 FROM document_versions v
            WHERE v.storage_path=c.storage_path OR v.pdf_storage_path=c.storage_path)
          AND NOT EXISTS(SELECT 1 FROM document_version_parts p
            WHERE p.storage_path=c.storage_path)
        ORDER BY c.created_at LIMIT ${Math.max(1, Math.min(limit, 500))}`, tx);
      if (!candidates.length) {
        await changes(sql`DELETE FROM object_cleanup WHERE claim_id IS NULL AND EXISTS(
          SELECT 1 FROM document_versions v WHERE v.storage_path=object_cleanup.storage_path
            OR v.pdf_storage_path=object_cleanup.storage_path)
          OR claim_id IS NULL AND EXISTS(SELECT 1 FROM document_version_parts p
            WHERE p.storage_path=object_cleanup.storage_path)`, tx);
        return [];
      }
      const claimId = randomUUID(), claimedAt = now();
      const keys = candidates.map(({ storage_path }) => storage_path);
      await changes(sql`UPDATE object_cleanup SET claim_id=${claimId},claimed_at=${claimedAt}
        WHERE storage_path IN(${sql.join(keys)}) AND created_at<=${before}
          AND (claim_id IS NULL OR claimed_at<=${expired})
          AND NOT EXISTS(SELECT 1 FROM document_versions v
            WHERE v.storage_path=object_cleanup.storage_path
              OR v.pdf_storage_path=object_cleanup.storage_path)
          AND NOT EXISTS(SELECT 1 FROM document_version_parts p
            WHERE p.storage_path=object_cleanup.storage_path)`, tx);
      return (await rows<{ storage_path: string }>(sql`SELECT storage_path FROM object_cleanup
        WHERE claim_id=${claimId} ORDER BY created_at`, tx))
        .map(({ storage_path: key }) => ({ key, claimId }));
    });
  },
};
