import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./hash";
import {
  localApplicationDatabase,
  localApplicationTransaction,
} from "./localApplicationDatabase";
import { documentProjectionService } from "./documentProjectionService";
import { legalKnowledgeGraphStore } from "./legalKnowledgeGraphStore";
import { localDocumentObjects } from "./localObjectStorage";
import { removeDocumentFromLocalTabularReviews } from "./localTabularStore";
import {
  normalizeDocumentMetadata,
  normalizeDocumentNotes,
  type DocumentMetadata,
} from "./normalize";
import { DocumentStoreError, type DocumentProvenance } from "./documentStore";
import type {
  DocumentAggregate,
  DocumentRepository,
  StoredDocumentVersion,
} from "./documentRepository";

export type LocalLibraryKind = "file" | "template";

export type LocalLegalSourcePdfFallback = {
  provider: "a2aj";
  identity: string;
  url: string;
  canonicalUrl: string;
  title?: string | null;
  version?: string | null;
  requestReference: string;
};

export type LocalLegalSourcePointer = {
  id: string;
  userId: string;
  provider: "a2aj" | "journal";
  docType: "cases" | "laws" | "articles";
  citation: string;
  language: "en" | "fr";
  dataset: string | null;
  sourceId?: string | null;
  pdfFallback?: LocalLegalSourcePdfFallback;
};

type LocalVersion = {
  id: string;
  versionNumber: number;
  source: string;
  provenance?: DocumentProvenance;
  createdAt: string;
  filename: string;
  fileType: string;
  sizeBytes: number;
  pageCount: number | null;
  storagePath: string;
  pdfStoragePath: string | null;
  sourceSha256?: string;
  cleanupPaths?: string[];
};

type LocalDocument = {
  id: string;
  userId: string;
  kind: LocalLibraryKind;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  currentVersionId: string;
  versions: LocalVersion[];
  metadata?: DocumentMetadata;
  notes?: string | null;
};

type LocalFolder = {
  id: string;
  userId: string;
  kind: LocalLibraryKind;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
};

const mutateDatabase = localApplicationTransaction;
const currentDatabase = localApplicationDatabase;

function activeVersion(document: LocalDocument) {
  const version =
    document.versions.find((version) => version.id === document.currentVersionId) ??
    document.versions[document.versions.length - 1];
  if (!version) throw new Error("Local document has no versions");
  return version;
}


async function localDocumentResponse(document: LocalDocument) {
  const version = activeVersion(document);
  // The durable parse job's state, denormalized onto every document
  // response so the Library can render parse lifecycle without a
  // per-document round trip. `status` stays the storage-readiness field
  // it always was; parse_state is the structural-parse lifecycle
  // (queued/parsing/ready/degraded/failed), null for non-PDF versions
  // (the flat-text lane has no parse job).
  const parseState =
    version.fileType === "pdf"
      ? await documentProjectionService.peekPdfState(
          localDocumentObjects().localPath!(version.storagePath),
        )
      : null;
  return {
    id: document.id,
    parse_state: parseState,
    user_id: document.userId,
    project_id: null,
    library_kind: document.kind,
    library_folder_id: document.folderId,
    folder_id: document.folderId,
    filename: version.filename,
    file_type: version.fileType,
    storage_path: version.storagePath,
    pdf_storage_path: version.pdfStoragePath,
    size_bytes: version.sizeBytes,
    page_count: version.pageCount,
    source_sha256: version.sourceSha256,
    status: "ready",
    current_version_id: document.currentVersionId,
    active_version_number: version.versionNumber,
    version_provenance: version.provenance
      ? {
          schema_version: version.provenance.schemaVersion,
          actor: version.provenance.actor,
          action: version.provenance.action,
          parent_version_id: version.provenance.parentVersionId,
          change_count: version.provenance.changeCount,
        }
      : undefined,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
    metadata: normalizeDocumentMetadata(document.metadata),
    notes: typeof document.notes === "string" ? document.notes : null,
  };
}

function localFolderResponse(folder: LocalFolder) {
  return {
    id: folder.id,
    user_id: folder.userId,
    library_kind: folder.kind,
    name: folder.name,
    parent_folder_id: folder.parentFolderId,
    created_at: folder.createdAt,
    updated_at: folder.updatedAt,
  };
}

function localVersionResponse(version: LocalVersion) {
  return {
    id: version.id,
    version_number: version.versionNumber,
    source: version.source,
    created_at: version.createdAt,
    filename: version.filename,
    file_type: version.fileType,
    size_bytes: version.sizeBytes,
    page_count: version.pageCount,
    source_sha256: version.sourceSha256,
    provenance: version.provenance
      ? {
          schema_version: version.provenance.schemaVersion,
          actor: version.provenance.actor,
          action: version.provenance.action,
          parent_version_id: version.provenance.parentVersionId,
          change_count: version.provenance.changeCount,
        }
      : undefined,
    deleted_at: null,
    deleted_by: null,
  };
}

export async function getLocalDocumentResponse(
  userId: string,
  documentId: string,
) {
  const document = await getLocalDocument(userId, documentId);
  return document ? localDocumentResponse(document) : null;
}

export async function countLocalDocuments(
  userId: string,
  kind: LocalLibraryKind,
) {
  const row = currentDatabase().prepare(
    `SELECT count(*) AS count FROM local_library_documents
     WHERE user_id = ? AND kind = ?`,
  ).get(userId, kind) as { count: number };
  return row.count;
}

export async function recentLocalDocuments(
  userId: string,
  kind: LocalLibraryKind,
  limit: number,
) {
  const database = currentDatabase();
  const rows = database.prepare(
    `SELECT payload FROM local_library_documents
     WHERE user_id = ? AND kind = ?
     ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).all(userId, kind, Math.max(0, Math.min(limit, 200))) as DocumentRow[];
  return Promise.all(documentsFromRows(rows).map(localDocumentResponse));
}

export async function pageLocalLibrary(
  userId: string,
  kind: LocalLibraryKind,
  options: {
    parentFolderId: string | null;
    q: string;
    limit: number;
    after: [number, string, string] | null;
    flat?: boolean;
  },
) {
  const database = currentDatabase();
  const query = options.q.trim().toLocaleLowerCase();
  const after = options.after;
  const pageSize = options.limit + 1;
  let rows: { kind: "folder" | "document"; id: string; bucket: number;
    sort_name: string; payload: string }[];
  if (query || options.flat) {
    rows = documentPageRows(database, userId, [kind], query, options.limit,
      after ? [kind, after[1], after[2]] : null).map((row) => ({
        ...row, kind: "document" as const, bucket: 1,
      }));
  } else {
    const params: (string | number | null)[] = [
      userId, kind, options.parentFolderId,
      userId, kind, options.parentFolderId,
    ];
    const afterSql = after
      ? `WHERE (bucket > ? OR
          (bucket = ? AND (sort_name > ? OR
            (sort_name = ? AND id > ?))))`
      : "";
    if (after) params.push(after[0], after[0], after[1], after[1], after[2]);
    params.push(pageSize);
    rows = database.prepare(
      `SELECT kind, id, bucket, sort_name, payload FROM (
         SELECT 'folder' AS kind, id, 0 AS bucket, lower(name) AS sort_name,
           json_object('id',id,'userId',user_id,'kind',kind,'name',name,
             'parentFolderId',parent_folder_id,'createdAt',created_at,
             'updatedAt',updated_at) AS payload
         FROM local_library_folders
         WHERE user_id = ? AND kind = ? AND parent_folder_id IS ?
         UNION ALL
         SELECT 'document' AS kind, d.id, 1 AS bucket,
                lower(d.filename) AS sort_name, d.payload
         FROM local_library_documents d
         WHERE d.user_id = ? AND d.kind = ? AND d.folder_id IS ?
       ) ${afterSql}
       ORDER BY bucket, sort_name, id
       LIMIT ?`,
    ).all(...params) as typeof rows;
  }

  const pageRows = rows.slice(0, options.limit);
  const items = await Promise.all(pageRows.map(async (row) => {
    if (row.kind === "document") {
      const document = documentFromRow(row);
      if (!document) throw new Error("Paged Local Library document disappeared");
      return { kind: "document" as const, document: await localDocumentResponse(document) };
    }
    const folder = parsedJson(row.payload, null as LocalFolder | null);
    if (!folder) throw new Error("Paged Local Library folder disappeared");
    return { kind: "folder" as const, folder: localFolderResponse(folder) };
  }));
  const last = pageRows.at(-1);
  return {
    items,
    nextAfter: rows.length > options.limit && last
      ? [last.bucket, last.sort_name, last.id] as [number, string, string]
      : null,
  };
}

export async function pageLocalDocuments(
  userId: string,
  kinds: LocalLibraryKind[],
  options: {
    q: string;
    limit: number;
    after: [string, string, string] | null;
  },
) {
  if (!kinds.length) return { items: [], nextAfter: null };
  const database = currentDatabase();
  const rows = documentPageRows(database, userId, kinds,
    options.q.trim().toLocaleLowerCase(), options.limit, options.after);
  const pageRows = rows.slice(0, options.limit);
  const items = await Promise.all(pageRows.map((row) => {
    const document = documentFromRow(row);
    if (!document) throw new Error("Paged local document disappeared");
    return localDocumentResponse(document);
  }));
  const last = pageRows.at(-1);
  return { items, nextAfter: rows.length > options.limit && last
    ? [last.kind, last.sort_name, last.id] as [string, string, string] : null };
}

function documentPageRows(database: DatabaseSync, userId: string,
  kinds: LocalLibraryKind[], query: string, limit: number,
  after: [string, string, string] | null) {
  const params: (string | number)[] = [userId, JSON.stringify(kinds)];
  const filters = ["d.kind IN (SELECT value FROM json_each(?))"];
  const ftsSql = query.length >= 3
    ? "JOIN local_document_filenames f ON f.document_id = d.id"
    : "";
  if (query.length >= 3) {
    filters.push("f.filename MATCH ?", "instr(lower(d.filename), ?) > 0");
    params.push(ftsPhrase(query), query);
  } else if (query) {
    filters.push("instr(lower(d.filename), ?) > 0");
    params.push(query);
  }
  if (after) {
    filters.push(
      `(d.kind > ? OR (d.kind = ? AND
        (lower(d.filename) > ? OR
          (lower(d.filename) = ? AND d.id > ?))))`,
    );
    params.push(
      after[0], after[0], after[1], after[1], after[2],
    );
  }
  params.push(limit + 1);
  return database.prepare(
    `SELECT d.id, d.kind, lower(d.filename) AS sort_name, d.payload
     FROM local_library_documents d
     ${ftsSql}
     WHERE d.user_id = ? AND ${filters.join(" AND ")}
     ORDER BY d.kind, lower(d.filename), d.id
     LIMIT ?`,
  ).all(...params) as { id: string; kind: string; sort_name: string; payload: string }[];
}

function ftsPhrase(query: string) {
  return `"${query.replaceAll('"', '""')}"`;
}

export async function listLocalDocumentsById(
  userId: string,
  documentIds: Iterable<string>,
) {
  const wanted = [...new Set(documentIds)];
  if (!wanted.length) return [];
  const database = currentDatabase();
  const rows = database.prepare(
    `SELECT payload FROM local_library_documents
     WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
  ).all(userId, JSON.stringify(wanted)) as DocumentRow[];
  const byId = new Map(
    documentsFromRows(rows).map((document) => [document.id, document]),
  );
  return Promise.all(
    wanted.flatMap((documentId) => {
      const document = byId.get(documentId);
      return document
        ? [localDocumentResponse(document)]
        : [];
    }),
  );
}

async function getLocalDocument(userId: string, documentId: string) {
  return databaseDocument(currentDatabase(), userId, documentId);
}

export async function getLocalVersionFile(
  userId: string,
  documentId: string,
  versionId?: string | null,
  preferPdf = false,
) {
  const document = await getLocalDocument(userId, documentId);
  if (!document) return null;
  const version = versionId
    ? document.versions.find((item) => item.id === versionId)
    : activeVersion(document);
  if (!version) return null;
  const key = preferPdf && version.pdfStoragePath
    ? version.pdfStoragePath
    : version.storagePath;
  return {
    document: await localDocumentResponse(document),
    version: localVersionResponse(version),
    path: localDocumentObjects().localPath!(key),
    fileType:
      preferPdf && version.pdfStoragePath ? "pdf" : version.fileType,
  };
}

type DocumentRow = { payload: string };

type FolderRow = {
  id: string;
  user_id: string;
  kind: LocalLibraryKind;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
};

function parsedJson<T>(value: string | null, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

const documentFromRow = (row: DocumentRow) =>
  parsedJson(row.payload, null as LocalDocument | null);
const documentsFromRows = (rows: DocumentRow[]) =>
  rows.flatMap((row) => documentFromRow(row) ?? []);

function saveDocument(database: DatabaseSync, document: LocalDocument) {
  database.prepare(
    `INSERT INTO local_library_documents
       (id,user_id,kind,folder_id,created_at,updated_at,filename,payload)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,
       updated_at=excluded.updated_at, filename=excluded.filename,
       payload=excluded.payload`,
  ).run(document.id, document.userId, document.kind, document.folderId,
    document.createdAt, document.updatedAt, activeVersion(document).filename,
    JSON.stringify(document));
}

function databaseDocument(
  database: DatabaseSync,
  userId: string,
  documentId: string,
) {
  const row = database.prepare(
    `SELECT payload FROM local_library_documents
     WHERE id = ? AND user_id = ?`,
  ).get(documentId, userId) as DocumentRow | undefined;
  return row ? documentFromRow(row) : null;
}

function folderFromRow(row: FolderRow): LocalFolder {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    name: row.name,
    parentFolderId: row.parent_folder_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


export async function localTrackedEditStatuses(
  userId: string,
  documentIds: Iterable<string>,
) {
  const database = currentDatabase();
  const documents = [...new Set(documentIds)].flatMap((documentId) => {
    const document = databaseDocument(database, userId, documentId);
    return document ? [document] : [];
  });
  return documents
    .flatMap((document) =>
      document.versions.flatMap((version) =>
        (version.provenance?.trackedEdits ?? []).map((edit) => ({
          documentId: document.id,
          versionId: version.id,
          versionNumber: version.versionNumber,
          editId: edit.id,
          status: edit.status,
        })),
      ),
    );
}

export async function moveLocalDocument(
  userId: string,
  kind: LocalLibraryKind,
  documentId: string,
  folderId: string | null,
) {
  const moved = mutateDatabase((database) => {
    const document = databaseDocument(database, userId, documentId);
    const folder = folderId
      ? database.prepare(
          `SELECT id FROM local_library_folders
           WHERE id = ? AND user_id = ? AND kind = ?`,
        ).get(folderId, userId, kind)
      : null;
    if (!document || document.kind !== kind || (folderId && !folder)) return null;
    document.folderId = folderId;
    document.updatedAt = new Date().toISOString();
    saveDocument(database, document);
    return document;
  });
  return moved ? localDocumentResponse(moved) : null;
}

export async function createLocalFolder(
  userId: string,
  kind: LocalLibraryKind,
  name: string,
  parentFolderId: string | null,
) {
  return mutateDatabase((database) => {
    if (
      parentFolderId &&
      !database.prepare(
        `SELECT 1 FROM local_library_folders
         WHERE id = ? AND user_id = ? AND kind = ?`,
      ).get(parentFolderId, userId, kind)
    ) {
      return null;
    }
    const now = new Date().toISOString();
    const folder: LocalFolder = {
      id: crypto.randomUUID(),
      userId,
      kind,
      name: name.slice(0, 200),
      parentFolderId,
      createdAt: now,
      updatedAt: now,
    };
    database.prepare(
      `INSERT INTO local_library_folders
        (id, user_id, kind, name, parent_folder_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(folder.id, folder.userId, folder.kind, folder.name,
      folder.parentFolderId, folder.createdAt, folder.updatedAt);
    return localFolderResponse(folder);
  });
}

export async function getLocalFolder(
  userId: string,
  kind: LocalLibraryKind,
  folderId: string,
) {
  const row = currentDatabase().prepare(
    `SELECT id, user_id, kind, name, parent_folder_id, created_at, updated_at
     FROM local_library_folders WHERE id = ? AND user_id = ? AND kind = ?`,
  ).get(folderId, userId, kind) as FolderRow | undefined;
  return row ? localFolderResponse(folderFromRow(row)) : null;
}

export async function updateLocalFolder(params: {
  userId: string;
  kind: LocalLibraryKind;
  folderId: string;
  name?: string;
  parentFolderId?: string | null;
}) {
  return mutateDatabase((database) => {
    const row = database.prepare(
      `SELECT id, user_id, kind, name, parent_folder_id, created_at, updated_at
       FROM local_library_folders WHERE id = ? AND user_id = ? AND kind = ?`,
    ).get(params.folderId, params.userId, params.kind) as FolderRow | undefined;
    const folder = row ? folderFromRow(row) : null;
    if (!folder) return null;
    if (params.parentFolderId !== undefined) {
      let cursor = params.parentFolderId;
      while (cursor) {
        if (cursor === folder.id) return null;
        const parent = database.prepare(
          `SELECT parent_folder_id FROM local_library_folders
           WHERE id = ? AND user_id = ? AND kind = ?`,
        ).get(cursor, params.userId, params.kind) as
          { parent_folder_id: string | null } | undefined;
        if (!parent) return null;
        cursor = parent.parent_folder_id;
      }
      folder.parentFolderId = params.parentFolderId;
    }
    if (params.name) folder.name = params.name.slice(0, 200);
    folder.updatedAt = new Date().toISOString();
    database.prepare(
      `UPDATE local_library_folders
       SET name = ?, parent_folder_id = ?, updated_at = ? WHERE id = ?`,
    ).run(folder.name, folder.parentFolderId, folder.updatedAt, folder.id);
    return localFolderResponse(folder);
  });
}

export async function listLocalFolderDocumentIds(
  userId: string,
  kind: LocalLibraryKind,
  folderId: string,
) {
  const database = currentDatabase();
  if (!database.prepare(
      `SELECT 1 FROM local_library_folders
       WHERE id = ? AND user_id = ? AND kind = ?`,
    ).get(folderId, userId, kind)) return null;
  return (database.prepare(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM local_library_folders WHERE id = ?
       UNION ALL SELECT f.id FROM local_library_folders f
       JOIN descendants d ON f.parent_folder_id = d.id
     )
     SELECT id FROM local_library_documents
     WHERE user_id = ? AND kind = ? AND folder_id IN (SELECT id FROM descendants)`,
  ).all(folderId, userId, kind) as { id: string }[]).map(({ id }) => id);
}

export async function deleteLocalFolder(
  userId: string, kind: LocalLibraryKind, folderId: string,
) {
  return mutateDatabase((database) => database.prepare(
    `DELETE FROM local_library_folders WHERE id = ? AND user_id = ? AND kind = ?`,
  ).run(folderId, userId, kind).changes > 0);
}

function legalSourceResponse(pointer: LocalLegalSourcePointer) {
  return {
    id: pointer.id,
    provider: pointer.provider,
    doc_type: pointer.docType,
    citation: pointer.citation,
    language: pointer.language,
    dataset: pointer.dataset,
    source_id: pointer.sourceId ?? null,
    ...(pointer.pdfFallback
      ? {
          pdf_fallback: {
            provider: pointer.pdfFallback.provider,
            identity: pointer.pdfFallback.identity,
            reference_id: pointer.pdfFallback.requestReference,
            status_url: `/library/legal/${encodeURIComponent(pointer.id)}/pdf-status`,
          },
        }
      : {}),
  };
}

function legalSourceId(pointer: {
  provider: "a2aj" | "journal";
  docType: "cases" | "laws" | "articles";
  citation: string;
  language: "en" | "fr";
  dataset?: string | null;
  sourceId?: string | null;
}) {
  return sha256(
    JSON.stringify([
      pointer.provider,
      pointer.docType,
      pointer.language,
      pointer.dataset?.trim().toLowerCase() ?? "",
      pointer.sourceId?.trim().toLowerCase() ?? "",
      pointer.citation.trim().toLowerCase(),
    ]),
  ).slice(0, 32);
}

export async function listLocalLegalSources(userId: string) {
  const database = currentDatabase();
  const rows = database.prepare(
    `SELECT pointer_json FROM local_library_legal_sources
     WHERE user_id = ? ORDER BY id`,
  ).all(userId) as { pointer_json: string }[];
  return rows.map((row) =>
    legalSourceResponse(parsedJson(row.pointer_json, {} as LocalLegalSourcePointer)));
}

export async function getLocalLegalSource(userId: string, id: string) {
  const row = currentDatabase().prepare(
    `SELECT pointer_json FROM local_library_legal_sources
     WHERE user_id = ? AND id = ?`,
  ).get(userId, id) as { pointer_json: string } | undefined;
  return row
    ? parsedJson(row.pointer_json, null as LocalLegalSourcePointer | null)
    : null;
}

export async function updateLocalDocument(params: {
  userId: string;
  kind: LocalLibraryKind;
  documentId: string;
  metadata?: unknown;
  notes?: unknown;
}) {
  const updated = mutateDatabase((database) => {
    const document = databaseDocument(database, params.userId, params.documentId);
    if (document?.kind !== params.kind) return null;
    if (params.metadata !== undefined) {
      document.metadata = normalizeDocumentMetadata(params.metadata);
    }
    if (params.notes !== undefined) {
      document.notes = normalizeDocumentNotes(params.notes);
    }
    document.updatedAt = new Date().toISOString();
    saveDocument(database, document);
    return document;
  });
  return updated ? localDocumentResponse(updated) : null;
}

export async function saveLocalLegalSource(params: {
  userId: string;
  provider: "a2aj" | "journal";
  docType: "cases" | "laws" | "articles";
  citation: string;
  language: "en" | "fr";
  dataset?: string | null;
  sourceId?: string | null;
  pdfFallback?: LocalLegalSourcePdfFallback;
}) {
  return mutateDatabase((database) => {
    const sourceId = params.sourceId?.trim();
    const pointer: LocalLegalSourcePointer = {
      id: legalSourceId(params),
      userId: params.userId,
      provider: params.provider,
      docType: params.docType,
      citation: params.citation.trim(),
      language: params.language,
      dataset: params.dataset?.trim() || null,
      ...(sourceId ? { sourceId } : {}),
      ...(params.pdfFallback ? { pdfFallback: params.pdfFallback } : {}),
    };
    const existingRow = database.prepare(
      `SELECT pointer_json FROM local_library_legal_sources
       WHERE user_id = ? AND id = ?`,
    ).get(params.userId, pointer.id) as { pointer_json: string } | undefined;
    const existing = existingRow
      ? parsedJson(existingRow.pointer_json, null as LocalLegalSourcePointer | null)
      : null;
    if (existing) {
      if (params.pdfFallback) existing.pdfFallback = params.pdfFallback;
      database.prepare(
        `UPDATE local_library_legal_sources SET pointer_json = ?
         WHERE user_id = ? AND id = ?`,
      ).run(JSON.stringify(existing), params.userId, pointer.id);
      return legalSourceResponse(existing);
    }
    database.prepare(
      `INSERT INTO local_library_legal_sources(user_id, id, pointer_json)
       VALUES (?, ?, ?)`,
    ).run(params.userId, pointer.id, JSON.stringify(pointer));
    return legalSourceResponse(pointer);
  });
}

export async function deleteLocalLegalSource(userId: string, id: string) {
  return mutateDatabase((database) =>
    database.prepare(
      "DELETE FROM local_library_legal_sources WHERE user_id = ? AND id = ?",
    ).run(userId, id).changes > 0);
}

const storedVersion = (
  documentId: string,
  version: LocalVersion,
): StoredDocumentVersion => ({
  id: version.id,
  documentId,
  versionNumber: version.versionNumber,
  source: version.source,
  createdAt: version.createdAt,
  filename: version.filename,
  fileType: version.fileType,
  sizeBytes: version.sizeBytes,
  pageCount: version.pageCount,
  sourceSha256: version.sourceSha256 ?? "",
  blobKey: version.storagePath,
  pdfBlobKey: version.pdfStoragePath,
  cleanupKeys: version.cleanupPaths ?? [],
  provenance: version.provenance,
});

const localVersion = (version: StoredDocumentVersion): LocalVersion => ({
  id: version.id,
  versionNumber: version.versionNumber,
  source: version.source,
  createdAt: version.createdAt,
  filename: version.filename,
  fileType: version.fileType,
  sizeBytes: version.sizeBytes,
  pageCount: version.pageCount,
  storagePath: version.blobKey,
  pdfStoragePath: version.pdfBlobKey,
  sourceSha256: version.sourceSha256,
  cleanupPaths: version.cleanupKeys,
  provenance: version.provenance,
});

function localAggregate(
  database: DatabaseSync,
  userId: string,
  documentId: string,
): DocumentAggregate | null {
  const document = databaseDocument(database, userId, documentId);
  if (!document) return null;
  const project = database.prepare(
    `SELECT project_id FROM mike_matter_documents
     WHERE user_id = ? AND document_id = ? LIMIT 1`,
  ).get(userId, documentId) as { project_id: string } | undefined;
  return {
    document: {
      id: document.id,
      userId: document.userId,
      projectId: project?.project_id ?? null,
      libraryKind: document.kind,
      folderId: document.folderId,
      status: "ready",
      currentVersionId: document.currentVersionId,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      metadata: normalizeDocumentMetadata(document.metadata),
      notes: typeof document.notes === "string" ? document.notes : null,
    },
    versions: document.versions.map((version) => storedVersion(document.id, version)),
    edits: document.versions.flatMap((version) =>
      (version.provenance?.trackedEdits ?? []).map((edit) => ({
        ...edit,
        versionId: version.id,
      }))),
    isOwner: true,
  };
}

export const localDocumentRepository: DocumentRepository = {
  async authorizeCreate(scope, input) {
    const database = currentDatabase();
    if (input.projectId) {
      if (input.folderId) return "folder-unavailable";
      return database.prepare(
        `SELECT 1 FROM legal_knowledge_projects WHERE user_id = ? AND id = ?`,
      ).get(scope.userId, input.projectId) ? "ok" : "project-missing";
    }
    if (input.folderId && !database.prepare(
      `SELECT 1 FROM local_library_folders
       WHERE id = ? AND user_id = ? AND kind = ?`,
    ).get(input.folderId, scope.userId, input.libraryKind)) return "folder-missing";
    return "ok";
  },

  async create(scope, input) {
    mutateDatabase((database) => {
      const { document, version } = input;
      const local: LocalDocument = {
        id: document.id,
        userId: scope.userId,
        kind: document.libraryKind,
        folderId: document.projectId ? null : document.folderId,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        currentVersionId: version.id,
        versions: [localVersion(version)],
        metadata: normalizeDocumentMetadata(document.metadata),
        notes: normalizeDocumentNotes(document.notes),
      };
      saveDocument(database, local);
      if (document.projectId && !legalKnowledgeGraphStore().attachMatterDocument(
        scope.userId, document.projectId, document.id,
      )) throw new DocumentStoreError(404, "Project not found");
    });
  },

  async get(scope, documentId) {
    return localAggregate(currentDatabase(), scope.userId, documentId);
  },

  async getMany(scope, documentIds) {
    const database = currentDatabase();
    return [...new Set(documentIds)].flatMap((documentId) => {
      const aggregate = localAggregate(database, scope.userId, documentId);
      return aggregate ? [aggregate] : [];
    });
  },

  async insertVersion(scope, documentId, input) {
    return mutateDatabase((database) => {
      const document = databaseDocument(database, scope.userId, documentId);
      if (!document) return "missing" as const;
      if (document.currentVersionId !== input.expectedCurrentVersionId) {
        return "conflict" as const;
      }
      const version = localVersion(input.version);
      if (input.edits?.length && version.provenance) {
        version.provenance = {
          ...version.provenance,
          trackedEdits: input.edits,
          changeCount: input.edits.length,
        };
      }
      document.versions.push(version);
      document.currentVersionId = version.id;
      document.updatedAt = version.createdAt;
      saveDocument(database, document);
      return "created" as const;
    });
  },

  async updateVersion(scope, documentId, input) {
    return mutateDatabase((database) => {
      const document = databaseDocument(database, scope.userId, documentId);
      if (!document) return "missing" as const;
      const version = document.versions.find(({ id }) => id === input.versionId);
      if (!version) return "missing" as const;
      if (version.storagePath !== input.expectedBlobKey) return "conflict" as const;
      const update = input.update;
      if (update.filename !== undefined) version.filename = update.filename;
      if (update.fileType !== undefined) version.fileType = update.fileType;
      if (update.sizeBytes !== undefined) version.sizeBytes = update.sizeBytes;
      if (update.pageCount !== undefined) version.pageCount = update.pageCount;
      if (update.sourceSha256 !== undefined) version.sourceSha256 = update.sourceSha256;
      if (update.blobKey !== undefined) version.storagePath = update.blobKey;
      if (update.pdfBlobKey !== undefined) version.pdfStoragePath = update.pdfBlobKey;
      if (update.cleanupKeys !== undefined) version.cleanupPaths = update.cleanupKeys;
      if (update.provenance === null) delete version.provenance;
      else if (update.provenance !== undefined) version.provenance = update.provenance;
      if (update.createdAt !== undefined) version.createdAt = update.createdAt;
      if (input.edits?.length && update.provenance === undefined) {
        version.provenance ??= {
          schemaVersion: 1,
          actor: "assistant",
          action: "revised",
          trackedEdits: [],
        };
        version.provenance.trackedEdits = [
          ...(version.provenance.trackedEdits ?? []),
          ...input.edits,
        ];
      }
      if (input.resolveEdit) {
        const edit = version.provenance?.trackedEdits?.find(
          ({ id }) => id === input.resolveEdit!.id,
        );
        if (!edit) return "conflict" as const;
        edit.status = input.resolveEdit.status;
      }
      document.updatedAt = new Date().toISOString();
      saveDocument(database, document);
      return "updated" as const;
    });
  },

  async renameVersion(scope, documentId, versionId, filename) {
    return mutateDatabase((database) => {
      const document = databaseDocument(database, scope.userId, documentId);
      const version = document?.versions.find(({ id }) => id === versionId);
      if (!document || !version) return false;
      version.filename = filename;
      document.updatedAt = new Date().toISOString();
      saveDocument(database, document);
      return true;
    });
  },

  async deleteVersion(scope, documentId, versionId, currentVersionId) {
    return mutateDatabase((database) => {
      const document = databaseDocument(database, scope.userId, documentId);
      if (!document) return false;
      const index = document.versions.findIndex(({ id }) => id === versionId);
      if (index < 0) return false;
      document.versions.splice(index, 1);
      document.currentVersionId = currentVersionId;
      document.updatedAt = new Date().toISOString();
      saveDocument(database, document);
      return true;
    });
  },

  async deleteDocument(scope, documentId) {
    const deleted = mutateDatabase((database) =>
      database.prepare(
        `DELETE FROM local_library_documents WHERE id = ? AND user_id = ?`,
      ).run(documentId, scope.userId).changes > 0);
    if (deleted) removeDocumentFromLocalTabularReviews(scope.userId, documentId);
    return deleted;
  },

  async clearCleanup(scope, documentId, versionId, keys) {
    mutateDatabase((database) => {
      const document = databaseDocument(database, scope.userId, documentId);
      const version = document?.versions.find(({ id }) => id === versionId);
      if (!document || !version) return;
      const removed = new Set(keys);
      version.cleanupPaths = (version.cleanupPaths ?? []).filter(
        (key) => !removed.has(key),
      );
      saveDocument(database, document);
    });
  },

  async recordOrphan(scope, key) {
    mutateDatabase((database) => database.prepare(
      `INSERT OR REPLACE INTO object_cleanup (storage_path, user_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(key, scope.userId, new Date().toISOString()));
  },

  async clearOrphan(key) {
    mutateDatabase((database) => database.prepare(
      `DELETE FROM object_cleanup WHERE storage_path = ?`,
    ).run(key));
  },

  async pendingOrphans(limit = 100) {
    return (currentDatabase().prepare(
      `SELECT storage_path FROM object_cleanup ORDER BY created_at LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 500))) as { storage_path: string }[])
      .map(({ storage_path }) => storage_path);
  },

  async pendingCleanup(limit = 100) {
    const rows = currentDatabase().prepare(
      `SELECT payload FROM local_library_documents ORDER BY updated_at LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 500))) as DocumentRow[];
    return documentsFromRows(rows).flatMap((document) =>
      document.versions.flatMap((version) => version.cleanupPaths?.length ? [{
        scope: { userId: document.userId },
        documentId: document.id,
        versionId: version.id,
        keys: version.cleanupPaths,
      }] : []));
  },
};
