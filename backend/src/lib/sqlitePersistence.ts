import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./hash";
import { sqliteDatabase, sqliteTransaction } from "./sqliteDatabase";
import type { DocumentAggregate, DocumentRepository, StoredDocument,
  StoredDocumentVersion } from "./documentRepository";
import type { StoredAssistantEdit } from "./documentStore";
import type { LibraryFolder, LibraryRepository } from "./libraryStore";
import { normalizeDocumentMetadata, normalizeDocumentNotes,
  type LibraryKind } from "./normalize";

type Row = Record<string, any>;
type FolderRow = Row & { id: string; user_id: string; kind: LibraryKind;
  name: string; parent_folder_id: string | null; created_at: string; updated_at: string };
type DirectoryRow = FolderRow & { item_kind: "folder" | "document";
  bucket: number; sort_name: string };

const db = () => sqliteDatabase();
const json = <T>(raw: unknown, fallback: T): T => {
  try { return typeof raw === "string" ? JSON.parse(raw) as T : fallback; }
  catch { return fallback; }
};
const storedDocument = (row: Row): StoredDocument => ({
  id: String(row.id), userId: String(row.user_id),
  projectId: typeof row.project_id === "string" ? row.project_id : null,
  libraryKind: row.kind === "template" ? "template" : "file",
  folderId: row.project_id ? row.folder_id ?? null : row.library_folder_id ?? null,
  status: String(row.status ?? "ready"), currentVersionId: String(row.current_version_id),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  metadata: normalizeDocumentMetadata(json(row.metadata_json, {})),
  notes: normalizeDocumentNotes(row.notes),
});
const storedVersion = (row: Row): StoredDocumentVersion => ({
  id: String(row.id), documentId: String(row.document_id),
  versionNumber: Number(row.version_number), source: String(row.source),
  createdAt: String(row.created_at), filename: String(row.filename),
  fileType: String(row.file_type), sizeBytes: Number(row.size_bytes),
  pageCount: typeof row.page_count === "number" ? row.page_count : null,
  sourceSha256: String(row.source_sha256), blobKey: String(row.storage_path),
  pdfBlobKey: typeof row.pdf_storage_path === "string" ? row.pdf_storage_path : null,
  cleanupKeys: json<string[]>(row.cleanup_paths_json, []),
  provenance: json(row.provenance_json, undefined),
});
const storedEdit = (row: Row): StoredAssistantEdit & { versionId: string } => ({
  id: String(row.id), versionId: String(row.version_id), changeId: String(row.change_id),
  ...(row.del_w_id ? { delWId: String(row.del_w_id) } : {}),
  ...(row.ins_w_id ? { insWId: String(row.ins_w_id) } : {}),
  deletedText: String(row.deleted_text ?? ""), insertedText: String(row.inserted_text ?? ""),
  contextBefore: String(row.context_before ?? ""), contextAfter: String(row.context_after ?? ""),
  ...(row.reason ? { reason: String(row.reason) } : {}),
  diff: json(row.diff_json, []),
  status: row.status === "accepted" || row.status === "rejected" ? row.status : "pending",
});
const versionValues = (version: StoredDocumentVersion) => [
  version.id, version.documentId, version.versionNumber, version.source, version.createdAt,
  version.filename, version.fileType, version.sizeBytes, version.pageCount,
  version.sourceSha256, version.blobKey, version.pdfBlobKey,
  JSON.stringify(version.cleanupKeys), version.provenance ? JSON.stringify(version.provenance) : null,
];
const insertVersion = (database: DatabaseSync, version: StoredDocumentVersion) =>
  database.prepare(`INSERT INTO document_versions
    (id,document_id,version_number,source,created_at,filename,file_type,size_bytes,page_count,
     source_sha256,storage_path,pdf_storage_path,cleanup_paths_json,provenance_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...versionValues(version));
const insertEdits = (database: DatabaseSync, documentId: string, versionId: string,
  edits: StoredAssistantEdit[] = []) => {
  const insert = database.prepare(`INSERT INTO document_edits
    (id,document_id,version_id,change_id,del_w_id,ins_w_id,deleted_text,inserted_text,
     context_before,context_after,reason,diff_json,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const edit of edits) insert.run(edit.id, documentId, versionId, edit.changeId,
    edit.delWId ?? null, edit.insWId ?? null, edit.deletedText, edit.insertedText,
    edit.contextBefore, edit.contextAfter, edit.reason ?? null, JSON.stringify(edit.diff), edit.status);
};
const aggregate = (database: DatabaseSync, userId: string, documentId: string) => {
  const row = database.prepare(`SELECT * FROM documents
    WHERE id=? AND user_id=?`).get(documentId, userId) as Row | undefined;
  if (!row?.current_version_id) return null;
  return {
    document: storedDocument(row),
    versions: (database.prepare(`SELECT * FROM document_versions
      WHERE document_id=? ORDER BY version_number`).all(documentId) as Row[]).map(storedVersion),
    edits: (database.prepare(`SELECT * FROM document_edits
      WHERE document_id=?`).all(documentId) as Row[]).map(storedEdit),
    isOwner: true,
  } satisfies DocumentAggregate;
};
export async function localTrackedEditStatuses(userId: string, documentIds: Iterable<string>) {
  const ids = [...new Set(documentIds)];
  if (!ids.length) return [];
  return (db().prepare(`SELECT e.document_id,e.version_id,v.version_number,e.id,e.status
    FROM document_edits e JOIN document_versions v ON v.id=e.version_id
    JOIN documents d ON d.id=e.document_id
    WHERE d.user_id=? AND e.document_id IN(SELECT value FROM json_each(?))`)
    .all(userId, JSON.stringify(ids)) as Row[]).map((row) => ({
      documentId: String(row.document_id), versionId: String(row.version_id),
      versionNumber: Number(row.version_number), editId: String(row.id), status: row.status,
    }));
}

const folder = (scope: { userId: string; kind: LibraryKind }, id: string) =>
  (db().prepare(`SELECT * FROM library_folders WHERE id=? AND user_id=? AND kind=?`)
    .get(id, scope.userId, scope.kind) as FolderRow | undefined) ?? null;
const folderResponse = (row: FolderRow): LibraryFolder => ({ ...row,
  library_kind: row.kind, parent_folder_id: row.parent_folder_id });

export const sqliteLibraryRepository: LibraryRepository = {
  async page(scope, options) {
    const params: (string | number | null)[] = [scope.userId, scope.kind];
    let rows: DirectoryRow[];
    if (options.q || options.documentsOnly) {
      const filters = ["user_id=?", "kind=?", "project_id IS NULL"];
      if (options.q) { filters.push("instr(lower(filename),?)>0"); params.push(options.q); }
      if (options.after) { filters.push("(lower(filename)>? OR (lower(filename)=? AND id>?))");
        params.push(options.after[1], options.after[1], options.after[2]); }
      params.push(options.limit + 1);
      rows = db().prepare(`SELECT 'document' item_kind,id,1 bucket,lower(filename) sort_name,
        user_id,kind,NULL name,NULL parent_folder_id,NULL created_at,NULL updated_at
        FROM documents WHERE ${filters.join(" AND ")}
        ORDER BY sort_name,id LIMIT ?`).all(...params) as DirectoryRow[];
    } else {
      params.push(options.parentFolderId, scope.userId, scope.kind, options.parentFolderId);
      const after = options.after
        ? `WHERE (bucket>? OR (bucket=? AND (sort_name>? OR (sort_name=? AND id>?))))` : "";
      if (options.after) params.push(options.after[0], options.after[0], options.after[1],
        options.after[1], options.after[2]);
      params.push(options.limit + 1);
      rows = db().prepare(`SELECT * FROM (
        SELECT 'folder' item_kind,id,0 bucket,lower(name) sort_name,user_id,kind,name,
          parent_folder_id,created_at,updated_at FROM library_folders
          WHERE user_id=? AND kind=? AND parent_folder_id IS ?
        UNION ALL SELECT 'document',id,1,lower(filename),user_id,kind,NULL,NULL,NULL,NULL
          FROM documents WHERE user_id=? AND kind=? AND project_id IS NULL
          AND library_folder_id IS ?) ${after} ORDER BY bucket,sort_name,id LIMIT ?`)
        .all(...params) as DirectoryRow[];
    }
    const page = rows.slice(0, options.limit), last = page.at(-1);
    return { items: page.map((row) => row.item_kind === "folder"
      ? { kind: "folder" as const, folder: folderResponse(row) }
      : { kind: "document" as const, id: row.id }),
    nextAfter: rows.length > options.limit && last
      ? [last.bucket, last.sort_name, last.id] : null };
  },
  async folder(scope, id) { const row = folder(scope, id); return row ? folderResponse(row) : null; },
  async createFolder(scope, name, parentId) {
    return sqliteTransaction((database) => {
      if (parentId && !folder(scope, parentId)) return null;
      const id = randomUUID(), now = new Date().toISOString();
      database.prepare(`INSERT INTO library_folders
        (id,user_id,kind,name,parent_folder_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(id, scope.userId, scope.kind, name, parentId, now, now);
      return folderResponse(folder(scope, id)!);
    });
  },
  async updateFolder(scope, id, update) {
    return sqliteTransaction((database) => {
      const current = folder(scope, id); if (!current) return null;
      const parent = update.parentFolderId === undefined
        ? current.parent_folder_id : update.parentFolderId;
      if (parent && !folder(scope, parent)) return null;
      database.prepare(`UPDATE library_folders SET name=?,parent_folder_id=?,updated_at=?
        WHERE id=? AND user_id=? AND kind=?`).run(update.name ?? current.name, parent,
        new Date().toISOString(), id, scope.userId, scope.kind);
      return folderResponse(folder(scope, id)!);
    });
  },
  async folderDocumentIds(scope, id) {
    if (!folder(scope, id)) return null;
    return (db().prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM library_folders WHERE id=? AND user_id=? AND kind=?
      UNION ALL SELECT f.id FROM library_folders f JOIN descendants d
        ON f.parent_folder_id=d.id WHERE f.user_id=? AND f.kind=?
      ) SELECT id FROM documents WHERE user_id=? AND project_id IS NULL
        AND kind=? AND library_folder_id IN(SELECT id FROM descendants)`)
      .all(id, scope.userId, scope.kind, scope.userId, scope.kind,
        scope.userId, scope.kind) as { id: string }[]).map(({ id }) => id);
  },
  async deleteFolder(scope, id) {
    return db().prepare(`DELETE FROM library_folders WHERE id=? AND user_id=? AND kind=?`)
      .run(id, scope.userId, scope.kind).changes > 0;
  },
};
export type SqliteLegalSourcePdfRendition = { provider: "a2aj"; identity: string;
  url: string; canonicalUrl: string; title?: string | null; version?: string | null;
  requestReference: string };
export type SqliteLegalSourcePointer = { id: string; userId: string;
  provider: "a2aj" | "journal"; docType: "cases" | "laws" | "articles";
  citation: string; language: "en" | "fr"; dataset: string | null;
  sourceId?: string | null; pdfRendition?: SqliteLegalSourcePdfRendition };
const legalSourceResponse = (source: SqliteLegalSourcePointer) => ({
  id: source.id, provider: source.provider, doc_type: source.docType,
  citation: source.citation, language: source.language, dataset: source.dataset,
  source_id: source.sourceId ?? null, ...(source.pdfRendition ? { pdf_rendition: {
    provider: source.pdfRendition.provider, identity: source.pdfRendition.identity,
    reference_id: source.pdfRendition.requestReference,
    status_url: `/api/sources/${encodeURIComponent(source.id)}/pdf-status`,
  } } : {}) });
const legalSourceId = (source: Omit<SqliteLegalSourcePointer, "id" | "userId" | "pdfRendition">) =>
  sha256(JSON.stringify([source.provider, source.docType, source.language,
    source.dataset?.trim().toLowerCase() ?? "", source.sourceId?.trim().toLowerCase() ?? "",
    source.citation.trim().toLowerCase()])).slice(0, 32);
export async function listSqliteLegalSources(userId: string) {
  return (db().prepare(`SELECT pointer_json FROM library_legal_sources
    WHERE user_id=? ORDER BY id`).all(userId) as { pointer_json: string }[])
    .map(({ pointer_json }) => legalSourceResponse(json(pointer_json, {} as SqliteLegalSourcePointer)));
}
export async function getSqliteLegalSource(userId: string, id: string) {
  const row = db().prepare(`SELECT pointer_json FROM library_legal_sources
    WHERE user_id=? AND id=?`).get(userId, id) as { pointer_json: string } | undefined;
  return row ? json(row.pointer_json, null as SqliteLegalSourcePointer | null) : null;
}
export async function saveSqliteLegalSource(input: Omit<SqliteLegalSourcePointer, "id">) {
  return sqliteTransaction((database) => {
    const source: SqliteLegalSourcePointer = { ...input, citation: input.citation.trim(),
      dataset: input.dataset?.trim() || null, id: legalSourceId(input) };
    const row = database.prepare(`SELECT pointer_json FROM library_legal_sources
      WHERE user_id=? AND id=?`).get(input.userId, source.id) as { pointer_json: string } | undefined;
    const current = row ? json(row.pointer_json, null as SqliteLegalSourcePointer | null) : null;
    if (current) {
      if (source.pdfRendition) current.pdfRendition = source.pdfRendition;
      database.prepare(`UPDATE library_legal_sources SET pointer_json=?
        WHERE user_id=? AND id=?`).run(JSON.stringify(current), input.userId, source.id);
      return legalSourceResponse(current);
    }
    database.prepare(`INSERT INTO library_legal_sources(user_id,id,pointer_json)
      VALUES(?,?,?)`).run(input.userId, source.id, JSON.stringify(source));
    return legalSourceResponse(source);
  });
}
export async function deleteSqliteLegalSource(userId: string, id: string) {
  return db().prepare(`DELETE FROM library_legal_sources WHERE user_id=? AND id=?`)
    .run(userId, id).changes > 0;
}

export const sqliteDocumentRepository: DocumentRepository = {
  async authorizeCreate(scope, input) {
    if (input.projectId) {
      if (!db().prepare(`SELECT 1 FROM projects WHERE user_id=? AND id=?`)
        .get(scope.userId, input.projectId)) return "project-missing";
      if (input.folderId && !db().prepare(`SELECT 1 FROM project_subfolders
        WHERE id=? AND user_id=? AND project_id=?`).get(
          input.folderId, scope.userId, input.projectId)) return "folder-missing";
    } else if (input.folderId && !db().prepare(`SELECT 1 FROM library_folders
      WHERE id=? AND user_id=? AND kind=?`).get(
        input.folderId, scope.userId, input.libraryKind)) return "folder-missing";
    return "ok";
  },
  async create(scope, input) {
    sqliteTransaction((database) => {
      const document = input.document;
      database.prepare(`INSERT INTO documents
        (id,user_id,kind,project_id,folder_id,library_folder_id,status,current_version_id,
         metadata_json,notes,created_at,updated_at,filename) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(document.id, scope.userId, document.libraryKind, document.projectId,
          document.projectId ? document.folderId : null,
          document.projectId ? null : document.folderId, document.status, input.version.id,
          JSON.stringify(document.metadata ?? {}), document.notes ?? null,
          document.createdAt, document.updatedAt, input.version.filename);
      insertVersion(database, input.version);
    });
  },
  async get(scope, id) { return aggregate(db(), scope.userId, id); },
  async getMany(scope, ids) {
    return [...new Set(ids)].flatMap((id) => aggregate(db(), scope.userId, id) ?? []);
  },
  async deletionIds(scope, projectIds, includeOwned) {
    const projects = [...new Set(projectIds)];
    if (!includeOwned && !projects.length) return [];
    const projectClause = projects.length
      ? `project_id IN (${projects.map(() => "?").join(",")})` : "0";
    return db().prepare(`SELECT id FROM documents
      WHERE user_id=? AND (${includeOwned ? "1" : "0"} OR ${projectClause})`)
      .all(scope.userId, ...projects).map((row) => String((row as { id: string }).id));
  },
  async insertVersion(scope, id, input) {
    return sqliteTransaction((database) => {
      const current = aggregate(database, scope.userId, id);
      if (!current) return "missing";
      if (current.document.currentVersionId !== input.expectedCurrentVersionId) return "conflict";
      insertVersion(database, input.version);
      insertEdits(database, id, input.version.id, input.edits);
      const changed = database.prepare(`UPDATE documents
        SET current_version_id=?,updated_at=?,filename=?
        WHERE id=? AND user_id=? AND current_version_id=?`).run(input.version.id,
          input.version.createdAt, input.version.filename, id, scope.userId,
          input.expectedCurrentVersionId).changes;
      return changed ? "created" : "conflict";
    });
  },
  async updateVersion(scope, id, input) {
    return sqliteTransaction((database) => {
      const current = aggregate(database, scope.userId, id);
      if (!current) return "missing";
      const version = current.versions.find(({ id }) => id === input.versionId);
      if (!version) return "missing";
      if (version.blobKey !== input.expectedBlobKey) return "conflict";
      if (input.resolveEdit && !current.edits.some(({ id: editId, versionId }) =>
        editId === input.resolveEdit!.id && versionId === input.versionId)) return "conflict";
      insertEdits(database, id, input.versionId, input.edits);
      if (input.resolveEdit) database.prepare(`UPDATE document_edits SET status=?
        WHERE id=? AND document_id=? AND version_id=?`).run(input.resolveEdit.status,
          input.resolveEdit.id, id, input.versionId);
      const update: StoredDocumentVersion = { ...version,
        ...Object.fromEntries(Object.entries(input.update).filter(([, value]) => value !== undefined)) };
      const changed = database.prepare(`UPDATE document_versions SET
        version_number=?,source=?,created_at=?,filename=?,file_type=?,size_bytes=?,page_count=?,
        source_sha256=?,storage_path=?,pdf_storage_path=?,cleanup_paths_json=?,provenance_json=?
        WHERE id=? AND document_id=? AND storage_path=?`).run(update.versionNumber,
          update.source, update.createdAt, update.filename, update.fileType, update.sizeBytes,
          update.pageCount, update.sourceSha256, update.blobKey, update.pdfBlobKey,
          JSON.stringify(update.cleanupKeys), update.provenance ? JSON.stringify(update.provenance) : null,
          input.versionId, id, input.expectedBlobKey).changes;
      if (changed) database.prepare(`UPDATE documents SET updated_at=?,filename=?
        WHERE id=? AND user_id=?`).run(new Date().toISOString(), update.filename, id, scope.userId);
      return changed ? "updated" : "conflict";
    });
  },
  async renameVersion(scope, id, versionId, filename) {
    return sqliteTransaction((database) => {
      const changed = database.prepare(`UPDATE document_versions SET filename=?
        WHERE id=? AND document_id=? AND EXISTS(SELECT 1 FROM documents
          WHERE id=? AND user_id=?)`).run(filename, versionId, id, id, scope.userId).changes;
      if (changed) database.prepare(`UPDATE documents SET filename=?,updated_at=?
        WHERE id=? AND user_id=? AND current_version_id=?`).run(filename,
          new Date().toISOString(), id, scope.userId, versionId);
      return changed > 0;
    });
  },
  async deleteVersion(scope, id, input) {
    return sqliteTransaction((database) => {
      const current = aggregate(database, scope.userId, id);
      const version = current?.versions.find(({ id }) => id === input.versionId);
      if (!current || !version || current.document.currentVersionId !== input.expectedCurrentVersionId ||
          version.blobKey !== input.expectedBlobKey ||
          version.pdfBlobKey !== input.expectedPdfBlobKey ||
          JSON.stringify(version.cleanupKeys) !== JSON.stringify(input.expectedCleanupKeys) ||
          input.nextCurrentVersionId === input.versionId ||
          !current.versions.some(({ id }) => id === input.nextCurrentVersionId)) return false;
      database.prepare(`UPDATE documents SET current_version_id=?,updated_at=?
        WHERE id=? AND user_id=? AND current_version_id=?`).run(input.nextCurrentVersionId,
          new Date().toISOString(), id, scope.userId, input.expectedCurrentVersionId);
      return database.prepare(`DELETE FROM document_versions WHERE id=? AND document_id=?`)
        .run(input.versionId, id).changes > 0;
    });
  },
  async deleteDocument(scope, id) {
    return db().prepare(`DELETE FROM documents WHERE id=? AND user_id=?`)
      .run(id, scope.userId).changes > 0;
  },
  async relocate(scope, id, input) {
    return sqliteTransaction((database) => {
      const current = aggregate(database, scope.userId, id);
      if (!current) return "missing";
      if (current.document.projectId !== input.expectedProjectId) return "conflict";
      if (input.projectId && !database.prepare(`SELECT 1 FROM projects WHERE user_id=? AND id=?`)
        .get(scope.userId, input.projectId)) return "missing";
      if (input.folderId) {
        const valid = input.projectId
          ? database.prepare(`SELECT 1 FROM project_subfolders
              WHERE id=? AND user_id=? AND project_id=?`).get(
                input.folderId, scope.userId, input.projectId)
          : database.prepare(`SELECT 1 FROM library_folders
              WHERE id=? AND user_id=? AND kind=?`).get(
                input.folderId, scope.userId, current.document.libraryKind);
        if (!valid) return "missing";
      }
      const changed = database.prepare(`UPDATE documents SET project_id=?,
        folder_id=?,library_folder_id=?,updated_at=? WHERE id=? AND user_id=? AND project_id IS ?`)
        .run(input.projectId, input.projectId ? input.folderId : null,
          input.projectId ? null : input.folderId, new Date().toISOString(), id,
          scope.userId, input.expectedProjectId).changes;
      return changed ? "moved" : "conflict";
    });
  },
  async updateMetadata(scope, id, input) {
    const current = aggregate(db(), scope.userId, id);
    if (!current) return false;
    return db().prepare(`UPDATE documents SET metadata_json=?,notes=?,updated_at=?
      WHERE id=? AND user_id=?`).run(JSON.stringify(input.metadata === undefined
        ? current.document.metadata ?? {} : normalizeDocumentMetadata(input.metadata)),
      input.notes === undefined ? current.document.notes ?? null : normalizeDocumentNotes(input.notes),
      new Date().toISOString(), id, scope.userId).changes > 0;
  },
  async clearCleanup(scope, id, versionId, keys) {
    sqliteTransaction((database) => {
      const current = aggregate(database, scope.userId, id);
      const version = current?.versions.find(({ id }) => id === versionId);
      if (!version) return;
      const removed = new Set(keys);
      database.prepare(`UPDATE document_versions SET cleanup_paths_json=?
        WHERE id=? AND document_id=?`).run(JSON.stringify(
          version.cleanupKeys.filter((key) => !removed.has(key))), versionId, id);
    });
  },
  async recordOrphan(scope, key) {
    db().prepare(`INSERT OR REPLACE INTO object_cleanup(storage_path,user_id,created_at)
      VALUES(?,?,?)`).run(key, scope.userId, new Date().toISOString());
  },
  async clearOrphan(_scope, key) { db().prepare(`DELETE FROM object_cleanup WHERE storage_path=?`).run(key); },
  async pendingOrphans(_scope, limit = 100) {
    return (db().prepare(`SELECT storage_path FROM object_cleanup ORDER BY created_at LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 500))) as { storage_path: string }[])
      .map(({ storage_path }) => storage_path);
  },
  async pendingCleanup(_scope, limit = 100) {
    return (db().prepare(`SELECT v.id,v.document_id,v.cleanup_paths_json,d.user_id
      FROM document_versions v JOIN documents d ON d.id=v.document_id
      WHERE v.cleanup_paths_json<>'[]' LIMIT ?`).all(
        Math.max(1, Math.min(limit, 500))) as Row[]).flatMap((row) => {
      const keys = json<string[]>(row.cleanup_paths_json, []);
      return keys.length ? [{ scope: { userId: String(row.user_id) },
        documentId: String(row.document_id), versionId: String(row.id), keys }] : [];
    });
  },
};
