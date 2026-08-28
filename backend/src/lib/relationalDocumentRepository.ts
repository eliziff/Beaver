import type { ApplicationScope } from "./applicationError";
import type { DocumentAggregate, DocumentRepository, StoredDocument, StoredDocumentVersion } from "./documentRepository";
import { decodePdfProfileSelection, type DocumentParseState, type StoredAssistantEdit } from "./documentStore";
import { wakeJobWorker } from "./jobQueue";
import { pdfLifecycleMark } from "./pdfLifecycleDiagnostics";
import { normalizeDocumentMetadata, normalizeDocumentNotes } from "./normalize";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { enqueuePdfPreparation } from "./pdfJobs";
import { changes, documentAccess, now, one, projectAccess, rows, type Row } from "./relationalRepositorySupport";

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
    status, ...detail, error: "PDF processing failed",
  };
  if (status !== "succeeded") return null;
  const result = decode<Record<string, unknown>>(row.pdf_job_result, {});
  const completed = { ...detail, ...(Number.isSafeInteger(result.pageCount) &&
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
const storedVersion = (row: Row): StoredDocumentVersion => {
  const profile = decodePdfProfileSelection(decode(row.pdf_profile, null));
  return {
    id: String(row.id), documentId: String(row.document_id),
    versionNumber: Number(row.version_number), source: String(row.source),
    createdAt: String(row.created_at), filename: String(row.filename),
    fileType: String(row.file_type), sizeBytes: Number(row.size_bytes),
    pageCount: row.page_count === null ? null : Number(row.page_count),
    sourceSha256: String(row.source_sha256), blobKey: String(row.storage_path),
    pdfBlobKey: typeof row.pdf_storage_path === "string" ? row.pdf_storage_path : null,
    cleanupKeys: decode<string[]>(row.cleanup_paths, []),
    provenance: decode(row.provenance, undefined),
    ...(profile ? { pdfProfile: profile } : {}),
  };
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

async function aggregate(db: RelationalDatabase, scope: ApplicationScope,
  documentId: string, owner = false): Promise<DocumentAggregate | null> {
  const document = await one(sql`SELECT d.*,v.page_count pdf_page_count,v.pdf_profile,
      j.status pdf_job_status,
      j.progress pdf_job_progress,j.result pdf_job_result,
      CASE WHEN d.user_id=${scope.userId} THEN 1 ELSE 0 END is_owner
    FROM documents d JOIN document_versions v ON v.id=d.current_version_id
      LEFT JOIN application_jobs j ON j.id=(SELECT q.id
      FROM application_jobs q WHERE q.document_id=d.id
        AND q.document_version_id=d.current_version_id
        AND q.kind IN('pdf.prepare','pdf.reprocess')
      ORDER BY q.updated_at DESC,q.id DESC LIMIT 1)
    WHERE d.id=${documentId} AND ${documentAccess(scope, owner)}`, db);
  if (!document?.current_version_id) return null;
  const [versions, edits] = await Promise.all([
    rows(sql`SELECT * FROM document_versions WHERE document_id=${documentId}
      ORDER BY version_number`, db),
    rows(sql`SELECT * FROM document_edits WHERE document_id=${documentId}`, db),
  ]);
  return { document: storedDocument(document), versions: versions.map(storedVersion),
    edits: edits.map(storedEdit), isOwner: Boolean(document.is_owner) };
}

async function addVersion(
  db: RelationalDatabase,
  version: StoredDocumentVersion,
  userId: string,
) {
  await changes(sql`INSERT INTO document_versions(id,document_id,version_number,source,
    created_at,filename,file_type,size_bytes,page_count,source_sha256,storage_path,
    pdf_storage_path,pdf_profile,cleanup_paths,provenance) VALUES(${version.id},${version.documentId},
    ${version.versionNumber},${version.source},${version.createdAt},${version.filename},
    ${version.fileType},${version.sizeBytes},${version.pageCount},${version.sourceSha256},
    ${version.blobKey},${version.pdfBlobKey},${version.pdfProfile ? encode(version.pdfProfile) : null},
    ${encode(version.cleanupKeys)},
    ${version.provenance ? encode(version.provenance) : null})`, db);
  if (version.fileType === "pdf") await enqueuePdfPreparation({
    userId,
    documentId: version.documentId,
    versionId: version.id,
    sourceSha256: version.sourceSha256,
  }, db);
}
async function addEdits(db: RelationalDatabase, documentId: string, versionId: string,
  edits: StoredAssistantEdit[] = []) {
  for (const edit of edits) await changes(sql`INSERT INTO document_edits(id,document_id,
    version_id,change_id,del_w_id,ins_w_id,deleted_text,inserted_text,context_before,
    context_after,reason,diff,status,resolved_at) VALUES(${edit.id},${documentId},${versionId},
    ${edit.changeId},${edit.delWId ?? null},${edit.insWId ?? null},${edit.deletedText},
    ${edit.insertedText},${edit.contextBefore},${edit.contextAfter},${edit.reason ?? null},
    ${encode(edit.diff)},${edit.status},${edit.status === "pending" ? null : now()})`, db);
}

export const documentRepository: DocumentRepository = {
  async authorizeCreate(scope, input) {
    if (input.projectId) {
      if (!await one(sql`SELECT 1 ok FROM projects p WHERE p.id=${input.projectId}
        AND ${projectAccess(scope)}`)) return "project-missing";
      if (input.folderId && !await one(sql`SELECT 1 ok FROM project_subfolders f
        JOIN projects p ON p.id=f.project_id WHERE f.id=${input.folderId}
        AND f.project_id=${input.projectId} AND ${projectAccess(scope)}`)) return "folder-missing";
    } else if (input.folderId && !await one(sql`SELECT 1 ok FROM library_folders
      WHERE id=${input.folderId} AND user_id=${scope.userId}
        AND library_kind=${input.libraryKind}`)) return "folder-missing";
    return "ok";
  },
  async version(scope, documentId, versionId) {
    const row = await one(sql`SELECT v.* FROM documents d JOIN document_versions v
      ON v.document_id=d.id AND v.id=COALESCE(${versionId},d.current_version_id)
      WHERE d.id=${documentId} AND ${documentAccess(scope)}`);
    return row ? storedVersion(row) : null;
  },
  async create(scope, input) {
    const db = await relationalDatabase();
    await db.transaction(async (tx) => {
      const { document, version } = input;
      await changes(sql`INSERT INTO documents(id,user_id,project_id,folder_id,
        library_kind,library_folder_id,status,current_version_id,metadata,notes,filename,
        created_at,updated_at) VALUES(${document.id},${scope.userId},${document.projectId},
        ${document.projectId ? document.folderId : null},${document.libraryKind},
        ${document.projectId ? null : document.folderId},${document.status},${version.id},
        ${encode(document.metadata ?? {})},${document.notes ?? null},${version.filename},
        ${document.createdAt},${document.updatedAt})`, tx);
      await addVersion(tx, version, scope.userId);
    });
    if (input.version.fileType === "pdf") {
      pdfLifecycleMark("queue.enqueued", input.document.id);
      wakeJobWorker();
    }
  },
  async get(scope, id, owner = false) {
    return aggregate(await relationalDatabase(), scope, id, owner);
  },
  async getMany(scope, ids) {
    const db = await relationalDatabase();
    const values = await Promise.all([...new Set(ids)].map((id) => aggregate(db, scope, id)));
    return values.flatMap((value) => value ? [value] : []);
  },
  async parseStates(scope, ids) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    return (await rows(sql`SELECT d.id,v.page_count pdf_page_count,v.pdf_profile,
      j.status pdf_job_status,
      j.progress pdf_job_progress,j.result pdf_job_result
      FROM documents d JOIN document_versions v ON v.id=d.current_version_id
        LEFT JOIN application_jobs j ON j.id=(SELECT q.id
        FROM application_jobs q WHERE q.document_id=d.id
          AND q.document_version_id=d.current_version_id
          AND q.kind IN('pdf.prepare','pdf.reprocess')
        ORDER BY q.updated_at DESC,q.id DESC LIMIT 1)
      WHERE d.id IN(${sql.join(unique)}) AND ${documentAccess(scope)}`))
      .map((row) => ({ id: String(row.id), parseState: pdfParseState(row) }));
  },
  async deletionIds(scope, projectIds, includeOwned) {
    if (!includeOwned && !projectIds.length) return [];
    const projects = projectIds.length ? sql.join([...new Set(projectIds)]) : sql.raw("NULL");
    return (await rows<{ id: string }>(sql`SELECT d.id FROM documents d WHERE
      (${includeOwned ? 1 : 0}=1 AND d.user_id=${scope.userId}) OR
      (d.project_id IN(${projects}) AND ${documentAccess(scope)})`)).map(({ id }) => id);
  },
  async insertVersion(scope, id, input) {
    const db = await relationalDatabase();
    const result = await db.transaction(async (tx) => {
      const current = await aggregate(tx, scope, id);
      if (!current) return "missing";
      if (current.document.currentVersionId !== input.expectedCurrentVersionId) return "conflict";
      const changed = await changes(sql`UPDATE documents SET current_version_id=${input.version.id},
        updated_at=${input.version.createdAt},filename=${input.version.filename}
        WHERE id=${id} AND current_version_id=${input.expectedCurrentVersionId}`, tx);
      if (!changed) return "conflict";
      await addVersion(tx, input.version, scope.userId);
      await addEdits(tx, id, input.version.id, input.edits);
      return "created";
    });
    if (result === "created" && input.version.fileType === "pdf") wakeJobWorker();
    return result;
  },
  async updateVersion(scope, id, input) {
    const db = await relationalDatabase();
    let queuedPdf = false;
    const result = await db.transaction(async (tx) => {
      const current = await aggregate(tx, scope, id);
      if (!current) return "missing";
      const version = current.versions.find(({ id: versionId }) => versionId === input.versionId);
      if (!version) return "missing";
      if (version.blobKey !== input.expectedBlobKey || input.resolveEdit &&
        !current.edits.some((edit) => edit.id === input.resolveEdit!.id &&
          edit.versionId === input.versionId)) return "conflict";
      const update = { ...version, ...Object.fromEntries(Object.entries(input.update)
        .filter(([, value]) => value !== undefined)) };
      const pdfProfile = update.fileType === "pdf" &&
        update.sourceSha256 === version.sourceSha256 ? update.pdfProfile : undefined;
      const changed = await changes(sql`UPDATE document_versions SET
        created_at=${update.createdAt},filename=${update.filename},file_type=${update.fileType},
        size_bytes=${update.sizeBytes},page_count=${update.pageCount},
        source_sha256=${update.sourceSha256},storage_path=${update.blobKey},
        pdf_storage_path=${update.pdfBlobKey},pdf_profile=${pdfProfile ? encode(pdfProfile) : null},
        cleanup_paths=${encode(update.cleanupKeys)},
        provenance=${update.provenance ? encode(update.provenance) : null}
        WHERE id=${input.versionId} AND document_id=${id}
          AND storage_path=${input.expectedBlobKey}`, tx);
      if (!changed) return "conflict";
      await addEdits(tx, id, input.versionId, input.edits);
      if (input.resolveEdit) await changes(sql`UPDATE document_edits SET
        status=${input.resolveEdit.status},resolved_at=${now()} WHERE id=${input.resolveEdit.id}
        AND document_id=${id} AND version_id=${input.versionId}`, tx);
      await changes(sql`UPDATE documents SET updated_at=${now()},filename=${update.filename}
        WHERE id=${id}`, tx);
      if (update.fileType === "pdf") {
        await enqueuePdfPreparation({
          userId: scope.userId,
          documentId: id,
          versionId: update.id,
          sourceSha256: update.sourceSha256,
        }, tx);
        queuedPdf = true;
      }
      return "updated";
    });
    if (queuedPdf) wakeJobWorker();
    return result;
  },
  async recordPdfPreparation(scope, id, input) {
    return await changes(sql`UPDATE document_versions SET page_count=${input.pageCount},
      pdf_profile=${encode(input.pdfProfile)} WHERE id=${input.versionId}
        AND document_id=${id} AND source_sha256=${input.sourceSha256} AND file_type='pdf'
        AND EXISTS(SELECT 1 FROM documents d WHERE d.id=document_versions.document_id
          AND ${documentAccess(scope)})`) > 0;
  },
  async renameVersion(scope, id, versionId, filename) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (!await aggregate(tx, scope, id)) return false;
      const changed = await changes(sql`UPDATE document_versions SET filename=${filename}
        WHERE id=${versionId} AND document_id=${id}`, tx);
      if (changed) await changes(sql`UPDATE documents SET filename=${filename},updated_at=${now()}
        WHERE id=${id} AND current_version_id=${versionId}`, tx);
      return changed > 0;
    });
  },
  async deleteVersion(scope, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await aggregate(tx, scope, id);
      const version = current?.versions.find(({ id: versionId }) => versionId === input.versionId);
      if (!current || !version || current.document.currentVersionId !== input.expectedCurrentVersionId ||
          version.blobKey !== input.expectedBlobKey || version.pdfBlobKey !== input.expectedPdfBlobKey ||
          encode(version.cleanupKeys) !== encode(input.expectedCleanupKeys) ||
          input.nextCurrentVersionId === input.versionId ||
          !current.versions.some(({ id: versionId }) => versionId === input.nextCurrentVersionId)) return false;
      if (!await changes(sql`UPDATE documents SET current_version_id=${input.nextCurrentVersionId},
        updated_at=${now()} WHERE id=${id} AND current_version_id=${input.expectedCurrentVersionId}`, tx))
        return false;
      return await changes(sql`DELETE FROM document_versions WHERE id=${input.versionId}
        AND document_id=${id}`, tx) > 0;
    });
  },
  async deleteDocument(scope, id) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const reviews = await rows<{ id: string; document_ids: unknown }>(sql`SELECT id,document_ids
        FROM tabular_reviews WHERE user_id=${scope.userId}`, tx);
      for (const review of reviews) {
        const ids = decode<string[]>(review.document_ids, []);
        if (ids.includes(id)) await changes(sql`UPDATE tabular_reviews
          SET document_ids=${encode(ids.filter((value) => value !== id))},updated_at=${now()}
          WHERE id=${review.id}`, tx);
      }
      await changes(sql`DELETE FROM tabular_cells WHERE document_id=${id}`, tx);
      return await changes(sql`DELETE FROM documents WHERE id=${id}
        AND user_id=${scope.userId}`, tx) > 0;
    });
  },
  async relocate(scope, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await aggregate(tx, scope, id, input.owner);
      if (!current) return "missing";
      if (current.document.projectId !== input.expectedProjectId) return "conflict";
      if (input.projectId && !await one(sql`SELECT 1 ok FROM projects p
        WHERE p.id=${input.projectId} AND ${projectAccess(scope)}`, tx)) return "missing";
      if (input.folderId) {
        const valid = input.projectId
          ? await one(sql`SELECT 1 ok FROM project_subfolders WHERE id=${input.folderId}
              AND project_id=${input.projectId}`, tx)
          : await one(sql`SELECT 1 ok FROM library_folders WHERE id=${input.folderId}
              AND user_id=${scope.userId} AND library_kind=${current.document.libraryKind}`, tx);
        if (!valid) return "missing";
      }
      const changed = await changes(sql`UPDATE documents SET project_id=${input.projectId},
        folder_id=${input.projectId ? input.folderId : null},
        library_folder_id=${input.projectId ? null : input.folderId},updated_at=${now()}
        WHERE id=${id} AND COALESCE(project_id,'')=${input.expectedProjectId ?? ""}`, tx);
      return changed ? "moved" : "conflict";
    });
  },
  async updateMetadata(scope, id, input) {
    const db = await relationalDatabase(), current = await aggregate(db, scope, id, true);
    if (!current) return false;
    return await changes(sql`UPDATE documents SET
      metadata=${encode(input.metadata === undefined ? current.document.metadata ?? {}
        : normalizeDocumentMetadata(input.metadata))},
      notes=${input.notes === undefined ? current.document.notes ?? null
        : normalizeDocumentNotes(input.notes)},updated_at=${now()}
      WHERE id=${id} AND user_id=${scope.userId}`, db) > 0;
  },
  async clearCleanup(scope, id, versionId, keys) {
    const db = await relationalDatabase();
    await db.transaction(async (tx) => {
      const version = (await aggregate(tx, scope, id))?.versions
        .find(({ id: candidate }) => candidate === versionId);
      if (version) await changes(sql`UPDATE document_versions
        SET cleanup_paths=${encode(version.cleanupKeys.filter((key) => !keys.includes(key)))}
        WHERE id=${versionId} AND document_id=${id}`, tx);
    });
  },
  async recordOrphan(scope, key) {
    await changes(sql`INSERT INTO object_cleanup(storage_path,user_id,created_at)
      VALUES(${key},${scope.userId},${now()}) ON CONFLICT(storage_path) DO UPDATE
      SET user_id=excluded.user_id,created_at=excluded.created_at`);
  },
  async clearOrphan(_scope, key) { await changes(sql`DELETE FROM object_cleanup WHERE storage_path=${key}`); },
  async pendingOrphans(_scope, limit = 100) {
    return (await rows<{ storage_path: string }>(sql`SELECT storage_path FROM object_cleanup
      ORDER BY created_at LIMIT ${Math.max(1, Math.min(limit, 500))}`))
      .map(({ storage_path }) => storage_path);
  },
  async pendingCleanup(_scope, limit = 100) {
    const values = await rows(sql`SELECT v.id,v.document_id,v.cleanup_paths,d.user_id
      FROM document_versions v JOIN documents d ON d.id=v.document_id
      WHERE v.cleanup_paths<>${encode([])} LIMIT ${Math.max(1, Math.min(limit, 500))}`);
    return values.flatMap((row) => {
      const keys = decode<string[]>(row.cleanup_paths, []);
      return keys.length ? [{ scope: { userId: String(row.user_id) },
        documentId: String(row.document_id), versionId: String(row.id), keys }] : [];
    });
  },
};
