import { randomUUID } from "node:crypto";
import type { ApplicationScope } from "./applicationError";
import {
  patchChatEditEvents,
  type ChatCommitResult,
  type ChatMessageRecord,
  type ChatMutation,
  type ChatRecord,
  type CreateChatRepository,
} from "./chatStore";
import type {
  DocumentAggregate,
  DocumentRepository,
  StoredDocument,
  StoredDocumentVersion,
} from "./documentRepository";
import type { DocumentParseState, StoredAssistantEdit } from "./documentStore";
import type { LibraryFolder, LibraryRepository, LibraryScope } from "./libraryStore";
import { normalizeDocumentMetadata, normalizeDocumentNotes } from "./normalize";
import type { ProjectFolder, ProjectRecord, ProjectRepository } from "./projectStore";
import {
  relationalDatabase,
  sql,
  type RelationalDatabase,
  type SqlStatement,
} from "./relationalDatabase";
import type {
  TabularCell,
  TabularColumn,
  TabularRepository,
  TabularReview,
  WriteResult,
} from "./tabularStore";
import type {
  CreateWorkflowRepository,
  WorkflowAccess,
  WorkflowCollaboration,
  WorkflowRecord,
} from "./workflowRepository";
import { enqueuePdfPreparation } from "./pdfJobs";

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const email = (scope: ApplicationScope) => scope.userEmail?.trim().toLowerCase() || "";
const encode = (value: unknown) => JSON.stringify(value ?? null);
const decode = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return value === null || value === undefined
    ? fallback : value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const pdfParseState = (row: Row): DocumentParseState | null => {
  const status = row.pdf_job_status;
  if (typeof status !== "string") return null;
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
  if (result.status === "ready" || result.status === "degraded") {
    return { status: result.status, ...detail };
  }
  if (result.status === "ocr_required") return { status: "degraded", ...detail };
  return result.status === "failed"
    ? { status: "failed", ...detail, error: "PDF processing failed" }
    : null;
};
const rows = async <T extends Row>(statement: SqlStatement, db?: RelationalDatabase) =>
  (await (db ?? await relationalDatabase()).query<T>(statement)).rows;
const one = async <T extends Row>(statement: SqlStatement, db?: RelationalDatabase) =>
  (await rows<T>(statement, db))[0] ?? null;
const changes = async (statement: SqlStatement, db?: RelationalDatabase) =>
  (await (db ?? await relationalDatabase()).query(statement)).changes;

const projectAccess = (scope: ApplicationScope, owner = false) => owner || !email(scope)
  ? sql`p.user_id=${scope.userId}`
  : sql`(p.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM project_members pm
      WHERE pm.project_id=p.id AND pm.email=${email(scope)}))`;
const reviewAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`r.user_id=${scope.userId}`
  : sql`(r.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM tabular_review_members rm
      WHERE rm.review_id=r.id AND rm.email=${email(scope)}) OR EXISTS(
      SELECT 1 FROM projects p WHERE p.id=r.project_id AND ${projectAccess(scope)}))`;
const documentAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`d.user_id=${scope.userId}`
  : sql`(d.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM projects p
      WHERE p.id=d.project_id AND ${projectAccess(scope)}))`;
const chatAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`c.user_id=${scope.userId}`
  : sql`(c.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM projects p
      WHERE p.id=c.project_id AND ${projectAccess(scope)}) OR EXISTS(
      SELECT 1 FROM tabular_reviews r WHERE r.id=c.tabular_review_id
        AND ${reviewAccess(scope)}))`;

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
const storedVersion = (row: Row): StoredDocumentVersion => ({
  id: String(row.id), documentId: String(row.document_id),
  versionNumber: Number(row.version_number), source: String(row.source),
  createdAt: String(row.created_at), filename: String(row.filename),
  fileType: String(row.file_type), sizeBytes: Number(row.size_bytes),
  pageCount: row.page_count === null ? null : Number(row.page_count),
  sourceSha256: String(row.source_sha256), blobKey: String(row.storage_path),
  pdfBlobKey: typeof row.pdf_storage_path === "string" ? row.pdf_storage_path : null,
  cleanupKeys: decode<string[]>(row.cleanup_paths, []),
  provenance: decode(row.provenance, undefined),
});
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
  const document = await one(sql`SELECT d.*,j.status pdf_job_status,
      j.progress pdf_job_progress,j.result pdf_job_result,
      CASE WHEN d.user_id=${scope.userId} THEN 1 ELSE 0 END is_owner
    FROM documents d LEFT JOIN application_jobs j ON j.id=(SELECT q.id
      FROM application_jobs q WHERE q.document_id=d.id
        AND q.document_version_id=d.current_version_id
        AND q.kind IN('pdf.prepare','pdf.pages','pdf.reprocess')
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
    pdf_storage_path,cleanup_paths,provenance) VALUES(${version.id},${version.documentId},
    ${version.versionNumber},${version.source},${version.createdAt},${version.filename},
    ${version.fileType},${version.sizeBytes},${version.pageCount},${version.sourceSha256},
    ${version.blobKey},${version.pdfBlobKey},${encode(version.cleanupKeys)},
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
  },
  async get(scope, id, owner = false) {
    return aggregate(await relationalDatabase(), scope, id, owner);
  },
  async getMany(scope, ids) {
    const db = await relationalDatabase();
    const values = await Promise.all([...new Set(ids)].map((id) => aggregate(db, scope, id)));
    return values.flatMap((value) => value ? [value] : []);
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
    return db.transaction(async (tx) => {
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
  },
  async updateVersion(scope, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await aggregate(tx, scope, id);
      if (!current) return "missing";
      const version = current.versions.find(({ id: versionId }) => versionId === input.versionId);
      if (!version) return "missing";
      if (version.blobKey !== input.expectedBlobKey || input.resolveEdit &&
        !current.edits.some((edit) => edit.id === input.resolveEdit!.id &&
          edit.versionId === input.versionId)) return "conflict";
      const update = { ...version, ...Object.fromEntries(Object.entries(input.update)
        .filter(([, value]) => value !== undefined)) };
      const changed = await changes(sql`UPDATE document_versions SET
        created_at=${update.createdAt},filename=${update.filename},file_type=${update.fileType},
        size_bytes=${update.sizeBytes},page_count=${update.pageCount},
        source_sha256=${update.sourceSha256},storage_path=${update.blobKey},
        pdf_storage_path=${update.pdfBlobKey},cleanup_paths=${encode(update.cleanupKeys)},
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
      if (update.fileType === "pdf") await enqueuePdfPreparation({
        userId: scope.userId,
        documentId: id,
        versionId: update.id,
        sourceSha256: update.sourceSha256,
      }, tx);
      return "updated";
    });
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

const libraryFolder = (row: Row): LibraryFolder => ({ ...row,
  id: String(row.id), name: String(row.name), parent_folder_id: row.parent_folder_id ?? null });
async function findLibraryFolder(scope: LibraryScope, id: string, db?: RelationalDatabase) {
  const row = await one(sql`SELECT * FROM library_folders WHERE id=${id}
    AND user_id=${scope.userId} AND library_kind=${scope.kind}`, db);
  return row ? libraryFolder(row) : null;
}
export const libraryRepository: LibraryRepository = {
  async page(scope, options) {
    const after = options.after;
    const seek = after ? sql`AND (bucket>${after[0]} OR (bucket=${after[0]} AND
      (sort_name>${after[1]} OR (sort_name=${after[1]} AND id>${after[2]}))))` : sql.raw("");
    const filter = options.q || options.documentsOnly
      ? sql`SELECT 'document' kind,id,1 bucket,lower(filename) sort_name,NULL name,
          NULL parent_folder_id,NULL created_at,NULL updated_at FROM documents
        WHERE user_id=${scope.userId} AND project_id IS NULL AND library_kind=${scope.kind}
          ${options.q ? sql`AND lower(filename) LIKE ${`%${options.q}%`}` : sql.raw("")}`
      : sql`SELECT * FROM (SELECT 'folder' kind,id,0 bucket,lower(name) sort_name,name,
          parent_folder_id,created_at,updated_at FROM library_folders
        WHERE user_id=${scope.userId} AND library_kind=${scope.kind}
          AND COALESCE(parent_folder_id,'')=${options.parentFolderId ?? ""}
        UNION ALL SELECT 'document',id,1,lower(filename),NULL,NULL,NULL,NULL FROM documents
        WHERE user_id=${scope.userId} AND project_id IS NULL AND library_kind=${scope.kind}
          AND COALESCE(library_folder_id,'')=${options.parentFolderId ?? ""}) directory
        WHERE 1=1 ${seek}`;
    const result = await rows(sql`${filter} ORDER BY bucket,sort_name,id LIMIT ${options.limit + 1}`);
    const page = result.slice(0, options.limit), last = page.at(-1);
    return { items: page.map((row) => row.kind === "folder"
      ? { kind: "folder" as const, folder: libraryFolder(row) }
      : { kind: "document" as const, id: String(row.id) }),
    nextAfter: result.length > options.limit && last
      ? [Number(last.bucket), String(last.sort_name), String(last.id)] : null };
  },
  folder: findLibraryFolder,
  async createFolder(scope, name, parentId) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (parentId && !await findLibraryFolder(scope, parentId, tx)) return null;
      const id = randomUUID(), created = now();
      await changes(sql`INSERT INTO library_folders(id,user_id,library_kind,name,
        parent_folder_id,created_at,updated_at) VALUES(${id},${scope.userId},${scope.kind},
        ${name},${parentId},${created},${created})`, tx);
      return findLibraryFolder(scope, id, tx);
    });
  },
  async updateFolder(scope, id, update) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await findLibraryFolder(scope, id, tx);
      if (!current) return null;
      const parent = update.parentFolderId === undefined
        ? current.parent_folder_id : update.parentFolderId;
      if (parent && !await findLibraryFolder(scope, parent, tx)) return null;
      await changes(sql`UPDATE library_folders SET name=${update.name ?? current.name},
        parent_folder_id=${parent},updated_at=${now()} WHERE id=${id}
        AND user_id=${scope.userId} AND library_kind=${scope.kind}`, tx);
      return findLibraryFolder(scope, id, tx);
    });
  },
  async folderDocumentIds(scope, id) {
    if (!await findLibraryFolder(scope, id)) return null;
    return (await rows<{ id: string }>(sql`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM library_folders WHERE id=${id} AND user_id=${scope.userId}
        AND library_kind=${scope.kind} UNION ALL SELECT f.id FROM library_folders f
      JOIN descendants d ON f.parent_folder_id=d.id WHERE f.user_id=${scope.userId}
        AND f.library_kind=${scope.kind}) SELECT id FROM documents
      WHERE user_id=${scope.userId} AND project_id IS NULL AND library_kind=${scope.kind}
        AND library_folder_id IN(SELECT id FROM descendants)`)).map(({ id: value }) => value);
  },
  async deleteFolder(scope, id) {
    return await changes(sql`DELETE FROM library_folders WHERE id=${id}
      AND user_id=${scope.userId} AND library_kind=${scope.kind}`) > 0;
  },
};

const projectRecord = (scope: ApplicationScope, row: Row): ProjectRecord => ({
  id: String(row.id), user_id: String(row.user_id), name: String(row.name),
  cm_number: row.cm_number ?? null, practice: row.practice ?? null,
  metadata: decode(row.metadata, {}), notes: row.notes ?? null,
  shared_with: decode<string[]>(row.shared_with, []),
  created_at: String(row.created_at), updated_at: String(row.updated_at),
  is_owner: row.user_id === scope.userId,
  owner_email: row.owner_email ?? null, owner_display_name: row.owner_display_name ?? null,
});
async function findProject(scope: ApplicationScope, id: string, owner = false,
  db?: RelationalDatabase) {
  const row = await one(sql`SELECT p.* FROM projects p WHERE p.id=${id}
    AND ${projectAccess(scope, owner)}`, db);
  return row ? projectRecord(scope, row) : null;
}
const projectFolder = (row: Row): ProjectFolder => ({ ...row, id: String(row.id),
  name: String(row.name), parent_folder_id: row.parent_folder_id ?? null });
async function findProjectFolder(scope: ApplicationScope, projectId: string, id: string,
  db?: RelationalDatabase) {
  const row = await one(sql`SELECT f.* FROM project_subfolders f JOIN projects p
    ON p.id=f.project_id WHERE f.id=${id} AND f.project_id=${projectId}
      AND ${projectAccess(scope)}`, db);
  return row ? projectFolder(row) : null;
}
async function missingProfileEmail(db: RelationalDatabase, emails: string[]) {
  if (db.engine === "sqlite") return emails[0] ?? null;
  const normalized = [...new Set(emails.map((value) => value.trim().toLowerCase()))];
  if (!normalized.length) return null;
  const found = new Set((await rows<{ email: string }>(sql`SELECT lower(email) email
    FROM user_profiles WHERE lower(email) IN(${sql.join(normalized)})`, db))
    .map(({ email: value }) => value));
  return normalized.find((value) => !found.has(value)) ?? null;
}
async function replaceMembers(db: RelationalDatabase, table: "project_members" |
  "tabular_review_members", id: string, emails: string[]) {
  if (db.engine === "postgres") return;
  const foreignKey = table === "project_members" ? "project_id" : "review_id";
  await changes(sql`DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(foreignKey)}=${id}`, db);
  for (const value of [...new Set(emails.map((item) => item.trim().toLowerCase()))]) {
    await changes(sql`INSERT INTO ${sql.raw(table)}(${sql.raw(foreignKey)},email)
      VALUES(${id},${value})`, db);
  }
}

export const projectRepository: ProjectRepository = {
  async page(scope, options) {
    const access = options.scope === "mine" ? sql`p.user_id=${scope.userId}`
      : options.scope === "shared-with-me" ? sql`p.user_id<>${scope.userId} AND EXISTS(
        SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.email=${email(scope)})`
        : projectAccess(scope);
    const result = await rows(sql`SELECT p.* FROM projects p WHERE ${access}
      ${options.q ? sql`AND lower(p.name||' '||COALESCE(p.cm_number,'')||' '||
        COALESCE(p.practice,'')) LIKE ${`%${options.q.toLowerCase()}%`}` : sql.raw("")}
      ${options.after ? sql`AND (p.created_at<${options.after[0]} OR
        (p.created_at=${options.after[0]} AND p.id<${options.after[1]}))` : sql.raw("")}
      ORDER BY p.created_at DESC,p.id DESC LIMIT ${options.limit + 1}`);
    const items = result.slice(0, options.limit).map((row) => projectRecord(scope, row));
    const last = items.at(-1);
    return { items, nextAfter: result.length > options.limit && last
      ? [String(last.created_at), last.id] : null };
  },
  async missingRecipient(_scope, emails) {
    return missingProfileEmail(await relationalDatabase(), emails);
  },
  async create(scope, input) {
    const db = await relationalDatabase(), id = randomUUID(), created = now();
    return db.transaction(async (tx) => {
      await changes(sql`INSERT INTO projects(id,user_id,name,cm_number,practice,shared_with,
        metadata,notes,created_at,updated_at) VALUES(${id},${scope.userId},${input.name},
        ${input.cmNumber},${input.practice},${encode(input.sharedWith)},
        ${encode(input.metadata ?? {})},${input.notes ?? null},${created},${created})`, tx);
      await replaceMembers(tx, "project_members", id, input.sharedWith);
      return (await findProject(scope, id, true, tx))!;
    });
  },
  async directory(scope, projectId, options) {
    if (!await findProject(scope, projectId)) return { items: [], nextAfter: null };
    const after = options.after;
    const seek = after ? sql`AND (bucket>${after[0]} OR (bucket=${after[0]} AND
      (sort_name>${after[1]} OR (sort_name=${after[1]} AND id>${after[2]}))))` : sql.raw("");
    const directory = options.q ? sql`SELECT 'document' kind,id,1 bucket,
        lower(filename) sort_name,NULL name,NULL parent_folder_id,NULL created_at,NULL updated_at
      FROM documents WHERE project_id=${projectId}
        AND lower(filename) LIKE ${`%${options.q.toLowerCase()}%`}`
      : sql`SELECT * FROM (SELECT 'folder' kind,id,0 bucket,lower(name) sort_name,
          name,parent_folder_id,created_at,updated_at FROM project_subfolders
        WHERE project_id=${projectId} AND COALESCE(parent_folder_id,'')=${options.parentFolderId ?? ""}
        UNION ALL SELECT 'document',id,1,lower(filename),NULL,NULL,NULL,NULL FROM documents
        WHERE project_id=${projectId} AND COALESCE(folder_id,'')=${options.parentFolderId ?? ""}) d
        WHERE 1=1 ${seek}`;
    const result = await rows(sql`${directory} ORDER BY bucket,sort_name,id
      LIMIT ${options.limit + 1}`), page = result.slice(0, options.limit), last = page.at(-1);
    return { items: page.map((row) => row.kind === "folder"
      ? { kind: "folder" as const, folder: projectFolder({ ...row, project_id: projectId }) }
      : { kind: "document" as const, id: String(row.id) }),
    nextAfter: result.length > options.limit && last
      ? [Number(last.bucket), String(last.sort_name), String(last.id)] : null };
  },
  project: findProject,
  async people(scope, id) {
    const project = await findProject(scope, id);
    if (!project) return null;
    const db = await relationalDatabase(), shared = project.shared_with as string[];
    if (db.engine === "sqlite") return { owner: { user_id: String(project.user_id),
      email: null, display_name: null }, members: shared.map((value) => ({
        email: value, display_name: null })) };
    const profiles = await rows<{ user_id: string; email: string | null;
      display_name: string | null }>(sql`SELECT user_id,email,display_name FROM user_profiles
      WHERE user_id=${String(project.user_id)} OR lower(email) IN(${shared.length
        ? sql.join(shared) : sql.raw("NULL")})`, db);
    const owner = profiles.find(({ user_id }) => user_id === project.user_id);
    const byEmail = new Map(profiles.flatMap((profile) => profile.email
      ? [[profile.email.toLowerCase(), profile.display_name] as const] : []));
    return { owner: { user_id: String(project.user_id), email: owner?.email ?? null,
      display_name: owner?.display_name ?? null }, members: shared.map((value) => ({
        email: value, display_name: byEmail.get(value) ?? null })) };
  },
  async update(scope, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await findProject(scope, id, true, tx);
      if (!current) return null;
      const shared = input.sharedWith ?? current.shared_with as string[];
      await changes(sql`UPDATE projects SET name=${input.name ?? String(current.name)},
        cm_number=${input.cmNumber === undefined ? current.cm_number as string | null : input.cmNumber},
        practice=${input.practice === undefined ? current.practice as string | null : input.practice},
        shared_with=${encode(shared)},metadata=${encode(input.metadata ?? current.metadata ?? {})},
        notes=${input.notes === undefined ? current.notes as string | null : input.notes},
        updated_at=${now()} WHERE id=${id} AND user_id=${scope.userId}`, tx);
      if (input.sharedWith) await replaceMembers(tx, "project_members", id, shared);
      return findProject(scope, id, true, tx);
    });
  },
  async remove(scope, id) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (!await findProject(scope, id, true, tx)) return null;
      const ids = (await rows<{ id: string }>(sql`SELECT id FROM chats WHERE project_id=${id}`, tx))
        .map(({ id: chatId }) => chatId);
      return await changes(sql`DELETE FROM projects WHERE id=${id} AND user_id=${scope.userId}`, tx)
        ? ids : null;
    });
  },
  folder: findProjectFolder,
  async createFolder(scope, projectId, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (!await findProject(scope, projectId, false, tx) || input.parentFolderId &&
        !await findProjectFolder(scope, projectId, input.parentFolderId, tx)) return null;
      const id = randomUUID(), created = now();
      await changes(sql`INSERT INTO project_subfolders(id,user_id,project_id,name,
        parent_folder_id,created_at,updated_at) VALUES(${id},${scope.userId},${projectId},
        ${input.name},${input.parentFolderId},${created},${created})`, tx);
      return findProjectFolder(scope, projectId, id, tx);
    });
  },
  async updateFolder(scope, projectId, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await findProjectFolder(scope, projectId, id, tx);
      if (!current) return null;
      const parent = input.parentFolderId === undefined
        ? current.parent_folder_id : input.parentFolderId;
      if (parent && !await findProjectFolder(scope, projectId, parent, tx)) return null;
      await changes(sql`UPDATE project_subfolders SET name=${input.name ?? current.name},
        parent_folder_id=${parent},updated_at=${now()} WHERE id=${id} AND project_id=${projectId}`, tx);
      return findProjectFolder(scope, projectId, id, tx);
    });
  },
  async folderDocumentIds(scope, projectId, id) {
    if (!await findProjectFolder(scope, projectId, id)) return null;
    return (await rows<{ id: string }>(sql`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM project_subfolders WHERE id=${id} AND project_id=${projectId}
      UNION ALL SELECT f.id FROM project_subfolders f JOIN descendants d
        ON f.parent_folder_id=d.id WHERE f.project_id=${projectId})
      SELECT id FROM documents WHERE project_id=${projectId}
        AND folder_id IN(SELECT id FROM descendants)`)).map(({ id: value }) => value);
  },
  async deleteFolder(scope, projectId, id) {
    if (!await findProject(scope, projectId)) return false;
    return await changes(sql`DELETE FROM project_subfolders WHERE id=${id}
      AND project_id=${projectId}`) > 0;
  },
};

const tabularReview = (scope: ApplicationScope, row: Row): TabularReview => {
  const documents = decode<string[]>(row.document_ids, []);
  return { ...row, id: String(row.id), user_id: String(row.user_id),
    project_id: typeof row.project_id === "string" ? row.project_id : null,
    title: typeof row.title === "string" ? row.title : null,
    columns_config: decode<TabularColumn[]>(row.columns_config, []), document_ids: documents,
    workflow_id: typeof row.workflow_id === "string" ? row.workflow_id : null,
    shared_with: decode<string[]>(row.shared_with, []), is_owner: row.user_id === scope.userId,
    updated_at: String(row.updated_at), document_count: documents.length };
};
const tabularCell = (row: Row): TabularCell => ({ ...row, id: String(row.id),
  review_id: String(row.review_id), document_id: String(row.document_id),
  column_index: Number(row.column_index), content: decode(row.content, null),
  status: ["generating", "done", "error"].includes(row.status) ? row.status : "pending",
} as TabularCell);
async function findReview(scope: ApplicationScope, id: string, owner = false,
  db?: RelationalDatabase) {
  const row = await one(sql`SELECT r.* FROM tabular_reviews r WHERE r.id=${id}
    AND ${reviewAccess(scope, owner)}`, db);
  return row ? tabularReview(scope, row) : null;
}
async function findCell(scope: ApplicationScope, reviewId: string, documentId: string,
  columnIndex: number, db?: RelationalDatabase) {
  const row = await one(sql`SELECT c.* FROM tabular_cells c JOIN tabular_reviews r
    ON r.id=c.review_id WHERE c.review_id=${reviewId} AND c.document_id=${documentId}
      AND c.column_index=${columnIndex} AND ${reviewAccess(scope)}`, db);
  return row ? tabularCell(row) : null;
}
async function syncCells(db: RelationalDatabase, reviewId: string,
  documentIds: string[], columns: TabularColumn[]) {
  const wanted = new Set(documentIds.flatMap((id) => columns.map(({ index }) => `${id}:${index}`)));
  const existing = await rows<{ id: string; document_id: string; column_index: number }>(
    sql`SELECT id,document_id,column_index FROM tabular_cells WHERE review_id=${reviewId}`, db);
  for (const row of existing) if (!wanted.has(`${row.document_id}:${row.column_index}`))
    await changes(sql`DELETE FROM tabular_cells WHERE id=${row.id}`, db);
  const present = new Set(existing.map((row) => `${row.document_id}:${row.column_index}`));
  const created = now();
  for (const documentId of documentIds) for (const column of columns) {
    if (!present.has(`${documentId}:${column.index}`)) await changes(sql`INSERT INTO tabular_cells
      (id,review_id,document_id,column_index,content,status,created_at,updated_at)
      VALUES(${randomUUID()},${reviewId},${documentId},${column.index},${null},'pending',
      ${created},${created})`, db);
  }
}
const nextVersion = (expected: string) => new Date(Math.max(
  Date.now(), (Date.parse(expected) || 0) + 1,
)).toISOString();

export const tabularRepository: TabularRepository = {
  async page(scope, options) {
    const project = options.projectId ? sql`AND r.project_id=${options.projectId}`
      : options.scope === "in-project" ? sql`AND r.project_id IS NOT NULL`
        : options.scope === "standalone" ? sql`AND r.project_id IS NULL` : sql.raw("");
    const result = await rows(sql`SELECT r.* FROM tabular_reviews r
      WHERE ${reviewAccess(scope)} ${project}
      ${options.q ? sql`AND lower(COALESCE(r.title,'')) LIKE ${`%${options.q.toLowerCase()}%`}`
        : sql.raw("")}
      ${options.after ? sql`AND (r.created_at<${options.after[0]} OR
        (r.created_at=${options.after[0]} AND r.id<${options.after[1]}))` : sql.raw("")}
      ORDER BY r.created_at DESC,r.id DESC LIMIT ${options.limit + 1}`);
    const page = result.slice(0, options.limit).map((row) => tabularReview(scope, row));
    const last = page.at(-1);
    return { items: page.map((item) => ({ ...item,
      column_count: item.columns_config.length })),
    nextAfter: result.length > options.limit && last
      ? [String(last.created_at), last.id] : null };
  },
  async create(scope, input) {
    const db = await relationalDatabase(), id = randomUUID(), created = now();
    return db.transaction(async (tx) => {
      if (input.projectId && !await findProject(scope, input.projectId, false, tx))
        return { status: "missing" } as const;
      const shared = input.sharedWith ?? [];
      await changes(sql`INSERT INTO tabular_reviews(id,user_id,project_id,title,columns_config,
        document_ids,workflow_id,shared_with,created_at,updated_at) VALUES(${id},${scope.userId},
        ${input.projectId},${input.title ?? null},${encode(input.columns)},
        ${encode(input.documentIds)},${input.workflowId ?? null},${encode(shared)},
        ${created},${created})`, tx);
      await replaceMembers(tx, "tabular_review_members", id, shared);
      await syncCells(tx, id, input.documentIds, input.columns);
      return { status: "committed", value: (await findReview(scope, id, true, tx))! } as const;
    });
  },
  async detail(scope, id) {
    const review = await findReview(scope, id);
    if (!review) return null;
    const cells = (await rows(sql`SELECT * FROM tabular_cells WHERE review_id=${id}
      ORDER BY document_id,column_index,id`)).map(tabularCell);
    return { review, cells };
  },
  async people(scope, id) {
    const review = await findReview(scope, id);
    if (!review) return null;
    const db = await relationalDatabase(), shared = review.shared_with;
    if (db.engine === "sqlite") return { owner: { user_id: review.user_id,
      email: null, display_name: null }, members: shared.map((value) => ({
        email: value, display_name: null })) };
    const profiles = await rows<{ user_id: string; email: string | null;
      display_name: string | null }>(sql`SELECT user_id,email,display_name FROM user_profiles
      WHERE user_id=${review.user_id} OR lower(email) IN(${shared.length
        ? sql.join(shared) : sql.raw("NULL")})`, db);
    const owner = profiles.find(({ user_id }) => user_id === review.user_id);
    const byEmail = new Map(profiles.flatMap((profile) => profile.email
      ? [[profile.email.toLowerCase(), profile.display_name] as const] : []));
    return { owner: { user_id: review.user_id, email: owner?.email ?? null,
      display_name: owner?.display_name ?? null }, members: shared.map((value) => ({
        email: value, display_name: byEmail.get(value) ?? null })) };
  },
  async missingRecipient(_scope, emails) {
    return missingProfileEmail(await relationalDatabase(), emails);
  },
  async update(scope, id, expected, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx): Promise<WriteResult<TabularReview>> => {
      const current = await findReview(scope, id, false, tx);
      if (!current) return { status: "missing" };
      if (current.updated_at !== expected) return { status: "conflict", value: current };
      const title = input.title === undefined ? current.title : input.title;
      const projectId = input.projectId === undefined ? current.project_id : input.projectId;
      const columns = input.columns ?? current.columns_config;
      const documentIds = input.documentIds ?? current.document_ids;
      const shared = input.sharedWith ?? current.shared_with;
      const updated = nextVersion(expected);
      if (!await changes(sql`UPDATE tabular_reviews SET title=${title},project_id=${projectId},
        columns_config=${encode(columns)},document_ids=${encode(documentIds)},
        shared_with=${encode(shared)},updated_at=${updated}
        WHERE id=${id} AND updated_at=${expected}`, tx)) {
        const latest = await findReview(scope, id, false, tx);
        return latest ? { status: "conflict", value: latest } : { status: "missing" };
      }
      if (input.sharedWith) await replaceMembers(tx, "tabular_review_members", id, shared);
      if (input.columns || input.documentIds) await syncCells(tx, id, documentIds, columns);
      return { status: "committed", value: (await findReview(scope, id, false, tx))! };
    });
  },
  async delete(scope, id, expected): Promise<WriteResult<null>> {
    const db = await relationalDatabase();
    if (!await findReview(scope, id, true, db)) return { status: "missing" };
    if (await changes(sql`DELETE FROM tabular_reviews WHERE id=${id}
      AND user_id=${scope.userId} AND updated_at=${expected}`, db))
      return { status: "committed", value: null };
    return await findReview(scope, id, true, db)
      ? { status: "conflict", value: null } : { status: "missing" };
  },
  async deleteAll(scope) {
    return changes(sql`DELETE FROM tabular_reviews WHERE user_id=${scope.userId}`);
  },
  async setCell(scope, input) {
    const db = await relationalDatabase();
    if (!await findReview(scope, input.reviewId, false, db)) return { status: "missing" };
    const expected = input.expected.content === null
      ? sql`content IS NULL` : sql`content=${encode(input.expected.content)}`;
    const changed = await changes(sql`UPDATE tabular_cells SET content=${input.content
      ? encode(input.content) : null},status=${input.status},updated_at=${now()}
      WHERE review_id=${input.reviewId} AND document_id=${input.documentId}
        AND column_index=${input.columnIndex} AND status=${input.expected.status} AND ${expected}`, db);
    const value = await findCell(scope, input.reviewId, input.documentId, input.columnIndex, db);
    return changed && value ? { status: "committed", value }
      : value ? { status: "conflict", value } : { status: "missing" };
  },
  async recordGeneration(scope, input) {
    const db = await relationalDatabase();
    if (db.engine === "sqlite") return;
    const [{ recordAudit }, { createServerSupabase }] = await Promise.all([
      import("./audit"), import("./supabase"),
    ]);
    await recordAudit(createServerSupabase(), { userId: scope.userId,
      userEmail: scope.userEmail, action: "tabular.generated",
      ...(input.failed ? { status: "failed" as const } : {}), title: input.title,
      surface: "tabular", projectId: input.projectId, reviewId: input.reviewId,
      model: input.model });
  },
};

const chatRecord = (row: Row): ChatRecord => ({ ...row, id: String(row.id),
  user_id: String(row.user_id), project_id: typeof row.project_id === "string" ? row.project_id : null,
  tabular_review_id: typeof row.tabular_review_id === "string" ? row.tabular_review_id : null,
  title: typeof row.title === "string" ? row.title : null,
  transcript_version: Number(row.transcript_version ?? 0) });
const chatMessage = (row: Row): ChatMessageRecord => ({ ...row, id: String(row.id),
  chat_id: String(row.chat_id), ...(row.turn_id ? { turn_id: String(row.turn_id) } : {}),
  role: row.role === "user" ? "user" : "assistant", content: decode(row.content, null),
  ...(row.files !== null ? { files: decode(row.files, null) } : {}),
  ...(row.workflow !== null ? { workflow: decode(row.workflow, null) } : {}),
  ...(row.citations !== null ? { citations: decode(row.citations, null) } : {}) });
async function findChat(scope: ApplicationScope, id: string, deleted = false,
  owner = false, db?: RelationalDatabase) {
  const row = await one(sql`SELECT c.* FROM chats c WHERE c.id=${id}
    AND c.deleted_at IS ${deleted ? sql.raw("NOT NULL") : sql.raw("NULL")}
    AND ${chatAccess(scope, owner)}`, db);
  return row ? chatRecord(row) : null;
}
async function decorateMessages(scope: ApplicationScope, messages: ChatMessageRecord[]) {
  const editIds = new Set<string>(), versionIds = new Set<string>();
  for (const message of messages) for (const raw of Array.isArray(message.content)
    ? message.content as Record<string, unknown>[] : []) {
    if (raw.type !== "document_artifact" || raw.action !== "edited") continue;
    if (typeof raw.version_id === "string") versionIds.add(raw.version_id);
    for (const annotation of Array.isArray(raw.annotations)
      ? raw.annotations as Record<string, unknown>[] : []) {
      if (typeof annotation.edit_id === "string") editIds.add(annotation.edit_id);
      if (typeof annotation.version_id === "string") versionIds.add(annotation.version_id);
    }
  }
  const [edits, versions] = await Promise.all([
    editIds.size ? rows<{ id: string; status: "pending" | "accepted" | "rejected" }>(
      sql`SELECT e.id,e.status FROM document_edits e JOIN documents d ON d.id=e.document_id
        WHERE e.id IN(${sql.join([...editIds])}) AND ${documentAccess(scope)}`) : [],
    versionIds.size ? rows<{ id: string; version_number: number }>(
      sql`SELECT v.id,v.version_number FROM document_versions v JOIN documents d
        ON d.id=v.document_id WHERE v.id IN(${sql.join([...versionIds])})
          AND ${documentAccess(scope)}`) : [],
  ]);
  return patchChatEditEvents(messages, edits.map(({ id, status }) => [id, status] as const),
    versions.map(({ id, version_number }) => [id, Number(version_number)] as const));
}
async function commitChat(scope: ApplicationScope, id: string, mutation: ChatMutation) {
  const db = await relationalDatabase();
  return db.transaction(async (tx): Promise<ChatCommitResult> => {
    const current = await findChat(scope, id, false, false, tx);
    if (!current) return { status: "missing" };
    const expected = mutation.kind === "turn" ? mutation.turn.expectedVersion
      : current.transcript_version;
    if (expected !== current.transcript_version)
      return { status: "conflict", currentVersion: current.transcript_version };
    let prior: Row | null = null;
    if (mutation.kind === "append") {
      prior = await one(sql`SELECT content FROM chat_messages WHERE id=${mutation.messageId}
        AND chat_id=${id} AND role='assistant'`, tx);
      if (!prior) return { status: "missing" };
    }
    const version = current.transcript_version + 1, created = now();
    if (!await changes(sql`UPDATE chats SET updated_at=${created},transcript_version=${version}
      WHERE id=${id} AND transcript_version=${current.transcript_version}`, tx))
      return { status: "conflict", currentVersion: current.transcript_version };
    if (mutation.kind === "append") {
      const content = decode<unknown[]>(prior!.content, []);
      await changes(sql`UPDATE chat_messages SET content=${encode([...content, mutation.event])}
        WHERE id=${mutation.messageId} AND chat_id=${id}`, tx);
    } else {
      const { userMessage, assistantMessage } = mutation.turn;
      if (userMessage) await changes(sql`INSERT INTO chat_messages(id,chat_id,turn_id,role,
        content,files,workflow,citations,created_at) VALUES(${userMessage.id},${id},
        ${userMessage.turnId ?? null},'user',${encode(userMessage.content)},
        ${userMessage.files === undefined ? null : encode(userMessage.files)},
        ${userMessage.workflow === undefined ? null : encode(userMessage.workflow)},${null},${created})`, tx);
      if (assistantMessage) await changes(sql`INSERT INTO chat_messages(id,chat_id,turn_id,role,
        content,files,workflow,citations,created_at) VALUES(${assistantMessage.id},${id},
        ${assistantMessage.turnId ?? null},'assistant',${encode(assistantMessage.content)},${null},${null},
        ${assistantMessage.citations === undefined ? null : encode(assistantMessage.citations)},${created})
        ON CONFLICT(id) DO UPDATE SET turn_id=COALESCE(excluded.turn_id,chat_messages.turn_id),
          content=excluded.content,citations=excluded.citations`, tx);
    }
    return { status: "committed", currentVersion: version };
  });
}

export const chatRepository: CreateChatRepository = (scope) => ({
  async list(options) {
    const context = options.projectId ? sql`c.project_id=${options.projectId}`
      : options.tabularReviewId ? sql`c.tabular_review_id=${options.tabularReviewId}`
        : sql`c.project_id IS NULL AND c.tabular_review_id IS NULL AND c.user_id=${scope.userId}`;
    return (await rows(sql`SELECT c.* FROM chats c WHERE ${context} AND ${chatAccess(scope)}
      AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM chat_messages m WHERE m.chat_id=c.id)
      ORDER BY c.updated_at DESC,c.created_at DESC,c.id
      ${options.limit ? sql`LIMIT ${options.limit}` : sql.raw("")}`)).map(chatRecord);
  },
  async deleted() {
    return (await rows(sql`SELECT c.* FROM chats c WHERE c.user_id=${scope.userId}
      AND c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC,c.id`)).map(chatRecord);
  },
  async purge(cutoff) {
    return (await rows<{ id: string }>(sql`DELETE FROM chats WHERE user_id=${scope.userId}
      AND deleted_at IS NOT NULL AND deleted_at<=${cutoff} RETURNING id`)).map(({ id }) => id);
  },
  async create(input) {
    const id = randomUUID(), created = now();
    await changes(sql`INSERT INTO chats(id,user_id,project_id,tabular_review_id,title,
      created_at,updated_at,deleted_at,transcript_version) VALUES(${id},${scope.userId},
      ${input.projectId},${input.tabularReviewId},${null},${created},${created},${null},0)`);
    return (await findChat(scope, id, false, true))!;
  },
  async read(id, messages = false, deleted = false) {
    const chat = await findChat(scope, id, deleted);
    if (!chat) return null;
    const values = messages ? (await rows(sql`SELECT * FROM chat_messages WHERE chat_id=${id}
      ORDER BY created_at,id`)).map(chatMessage) : [];
    return { chat, messages: values };
  },
  async owns(id) { return !!await findChat(scope, id, false, true); },
  commit(id, mutation) { return commitChat(scope, id, mutation); },
  async update(id, input) {
    const current = await findChat(scope, id, false, true);
    if (!current) return null;
    await changes(sql`UPDATE chats SET title=${input.title ?? current.title},
      project_id=${input.projectId === undefined ? current.project_id : input.projectId},
      updated_at=${now()} WHERE id=${id} AND user_id=${scope.userId} AND deleted_at IS NULL`);
    return findChat(scope, id, false, true);
  },
  async trash(id, at) {
    return await changes(sql`UPDATE chats SET deleted_at=${at},updated_at=${at}
      WHERE id=${id} AND user_id=${scope.userId} AND deleted_at IS NULL`) > 0;
  },
  async restore(id, cutoff, at) {
    return await changes(sql`UPDATE chats SET deleted_at=${null},updated_at=${at}
      WHERE id=${id} AND user_id=${scope.userId} AND deleted_at>${cutoff}`) > 0;
  },
  async remove(id) {
    return await changes(sql`DELETE FROM chats WHERE id=${id} AND user_id=${scope.userId}
      AND deleted_at IS NOT NULL`) > 0;
  },
  async removeAll() {
    return (await rows<{ id: string }>(sql`DELETE FROM chats WHERE user_id=${scope.userId}
      RETURNING id`)).map(({ id }) => id);
  },
  decorate(messages) { return decorateMessages(scope, messages); },
});

const workflowRecord = (row: Row): WorkflowRecord => ({ ...row, id: String(row.id),
  user_id: typeof row.user_id === "string" ? row.user_id : null,
  title: String(row.title), type: row.type === "tabular" ? "tabular" : "assistant",
  prompt_md: typeof row.prompt_md === "string" ? row.prompt_md : null,
  columns_config: decode(row.columns_config, null),
  language: typeof row.language === "string" ? row.language : null,
  version: typeof row.version === "string" ? row.version : null,
  practice: typeof row.practice === "string" ? row.practice : null,
  jurisdictions: decode(row.jurisdictions, null), contributors: decode(row.contributors, null),
  created_at: String(row.created_at) });
async function workflowAccess(scope: ApplicationScope, id: string,
  db?: RelationalDatabase): Promise<WorkflowAccess | null> {
  const row = await one(sql`SELECT w.*,
      CASE WHEN w.user_id=${scope.userId} THEN 1 ELSE 0 END is_owner,
      COALESCE((SELECT allow_edit FROM workflow_shares s WHERE s.workflow_id=w.id
        AND s.shared_with_email=${email(scope)}),0) allow_edit
    FROM workflows w WHERE w.id=${id} AND (w.user_id=${scope.userId} OR EXISTS(
      SELECT 1 FROM workflow_shares s WHERE s.workflow_id=w.id
        AND s.shared_with_email=${email(scope)}))`, db);
  if (!row) return null;
  const isOwner = Boolean(row.is_owner);
  return { workflow: workflowRecord(row), isOwner,
    allowEdit: isOwner || Boolean(row.allow_edit) };
}

export const workflowRepository: CreateWorkflowRepository = (scope) => ({
  async page(options) {
    const result = await rows(sql`SELECT w.* FROM workflows w WHERE
      (w.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM workflow_shares s
        WHERE s.workflow_id=w.id AND s.shared_with_email=${email(scope)}))
      ${options.type ? sql`AND w.type=${options.type}` : sql.raw("")}
      ${options.q ? sql`AND lower(w.title) LIKE ${`%${options.q.toLowerCase()}%`}` : sql.raw("")}
      ${options.after ? sql`AND (w.created_at<${options.after[0]} OR
        (w.created_at=${options.after[0]} AND w.id<${options.after[1]}))` : sql.raw("")}
      ORDER BY w.created_at DESC,w.id DESC LIMIT ${options.limit + 1}`);
    const items = result.slice(0, options.limit).map(workflowRecord), last = items.at(-1);
    return { items, nextAfter: result.length > options.limit && last
      ? [last.created_at, last.id] : null };
  },
  async hidden() {
    return (await rows<{ workflow_id: string }>(sql`SELECT workflow_id FROM hidden_workflows
      WHERE user_id=${scope.userId}`)).map(({ workflow_id }) => workflow_id);
  },
  async hide(id) {
    await changes(sql`INSERT INTO hidden_workflows(user_id,workflow_id,created_at)
      VALUES(${scope.userId},${id},${now()}) ON CONFLICT(user_id,workflow_id) DO NOTHING`);
  },
  async unhide(id) {
    await changes(sql`DELETE FROM hidden_workflows WHERE user_id=${scope.userId}
      AND workflow_id=${id}`);
  },
  async create(input) {
    const id = randomUUID(), created = now();
    await changes(sql`INSERT INTO workflows(id,user_id,title,type,prompt_md,columns_config,
      language,version,practice,jurisdictions,contributors,created_at,updated_at)
      VALUES(${id},${scope.userId},${input.title},${input.type},${input.promptMd},
      ${input.columns === null ? null : encode(input.columns)},${input.language},${null},
      ${input.practice},${input.jurisdictions === null ? null : encode(input.jurisdictions)},
      ${null},${created},${created})`);
    return (await workflowAccess(scope, id))!.workflow;
  },
  get(id) { return workflowAccess(scope, id); },
  async update(id, input) {
    const current = await workflowAccess(scope, id);
    if (!current?.allowEdit) return null;
    const value = current.workflow;
    await changes(sql`UPDATE workflows SET title=${input.title ?? value.title},
      prompt_md=${input.promptMd === undefined ? value.prompt_md : input.promptMd},
      columns_config=${input.columns === undefined
        ? value.columns_config === null ? null : encode(value.columns_config)
        : input.columns === null ? null : encode(input.columns)},
      language=${input.language === undefined ? value.language : input.language},
      practice=${input.practice === undefined ? value.practice : input.practice},
      jurisdictions=${input.jurisdictions === undefined
        ? value.jurisdictions === null ? null : encode(value.jurisdictions)
        : input.jurisdictions === null ? null : encode(input.jurisdictions)},
      updated_at=${now()} WHERE id=${id}`);
    return workflowAccess(scope, id);
  },
  async remove(id) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const removed = await changes(sql`DELETE FROM workflows WHERE id=${id}
        AND user_id=${scope.userId}`, tx) > 0;
      if (removed) await changes(sql`DELETE FROM hidden_workflows WHERE workflow_id=${id}`, tx);
      return removed;
    });
  },
  async assistants() {
    const values = await rows(sql`SELECT w.* FROM workflows w WHERE w.type='assistant'
      AND (w.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM workflow_shares s
        WHERE s.workflow_id=w.id AND s.shared_with_email=${email(scope)}))`);
    return new Map(values.flatMap((row) => {
      const workflow = workflowRecord(row);
      return workflow.prompt_md ? [[workflow.id, { title: workflow.title,
        skill_md: workflow.prompt_md }] as const] : [];
    }));
  },
});

export const workflowCollaboration: WorkflowCollaboration = {
  async shares(scope, workflowId) {
    const owner = await workflowAccess(scope, workflowId);
    if (!owner?.isOwner) return null;
    return (await rows(sql`SELECT id,shared_with_email,allow_edit,created_at FROM workflow_shares
      WHERE workflow_id=${workflowId} ORDER BY created_at`)).map((row) => ({ ...row,
        allow_edit: Boolean(row.allow_edit) })) as never;
  },
  async removeShare(scope, workflowId, shareId) {
    const owner = await workflowAccess(scope, workflowId);
    return !!owner?.isOwner && await changes(sql`DELETE FROM workflow_shares
      WHERE id=${shareId} AND workflow_id=${workflowId}`) > 0;
  },
  async share(scope, workflowId, emails, allowEdit) {
    const db = await relationalDatabase(), owner = await workflowAccess(scope, workflowId, db);
    if (!owner?.isOwner) return "missing";
    const missingEmail = await missingProfileEmail(db, emails);
    if (missingEmail) return { missingEmail };
    for (const value of emails) await changes(sql`INSERT INTO workflow_shares(id,workflow_id,
      shared_by_user_id,shared_with_email,allow_edit,created_at) VALUES(${randomUUID()},
      ${workflowId},${scope.userId},${value.trim().toLowerCase()},
      ${allowEdit ? sql.raw("TRUE") : sql.raw("FALSE")},${now()})
      ON CONFLICT(workflow_id,shared_with_email) DO UPDATE SET allow_edit=excluded.allow_edit`, db);
    return "ok";
  },
  async latestSubmission(scope, workflowId) {
    return await one(sql`SELECT id,status,submitted_at,updated_at,reviewed_at
      FROM workflow_open_source_submissions WHERE workflow_id=${workflowId}
        AND submitted_by_user_id=${scope.userId} ORDER BY submitted_at DESC LIMIT 1`) as never;
  },
  async submit(scope, workflow, input) {
    const db = await relationalDatabase();
    const profile = db.engine === "postgres" ? await one<{ display_name: string | null }>(
      sql`SELECT display_name FROM user_profiles WHERE user_id=${scope.userId}`, db) : null;
    const created = now(), pending = await one<{ id: string }>(sql`SELECT id
      FROM workflow_open_source_submissions WHERE workflow_id=${workflow.id}
        AND submitted_by_user_id=${scope.userId} AND status='pending' LIMIT 1`, db);
    const snapshot = encode({ workflow_id: workflow.id, metadata: input.metadata,
      skill_md: workflow.prompt_md, columns_config: workflow.columns_config,
      contributor_mode: input.contributorMode, created_at: workflow.created_at });
    if (pending) {
      await changes(sql`UPDATE workflow_open_source_submissions SET
        submitter_email=${scope.userEmail ?? null},submitter_name=${input.contributorMode === "named"
          ? profile?.display_name?.trim() || null : null},contributor_mode=${input.contributorMode},
        snapshot=${snapshot},updated_at=${created} WHERE id=${pending.id}`, db);
      const result = await one<Row>(sql`SELECT id,status,submitted_at,updated_at,reviewed_at
        FROM workflow_open_source_submissions WHERE id=${pending.id}`, db);
      return { ...result, mode: "updated" } as never;
    }
    const id = randomUUID();
    await changes(sql`INSERT INTO workflow_open_source_submissions(id,workflow_id,
      submitted_by_user_id,submitter_email,submitter_name,contributor_mode,snapshot,status,
      submitted_at,updated_at,reviewed_at) VALUES(${id},${workflow.id},${scope.userId},
      ${scope.userEmail ?? null},${input.contributorMode === "named"
        ? profile?.display_name?.trim() || null : null},${input.contributorMode},${snapshot},
      'pending',${created},${created},${null})`, db);
    const result = await one<Row>(sql`SELECT id,status,submitted_at,updated_at,reviewed_at
      FROM workflow_open_source_submissions WHERE id=${id}`, db);
    return { ...result, mode: "created" } as never;
  },
};
