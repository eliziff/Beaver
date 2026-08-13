import path from "node:path";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { docxToPdf } from "./convert";
import { sha256 } from "./hash";
import {
  ALLOWED_DOCUMENT_TYPES,
  shouldConvertToPdf,
} from "./documentTypes";
import { mikeLocalDataHome } from "./legalDataPath";
import { isImageDocumentType, validateImageBytes } from "./llm/images";
import {
  peekLocalPdfParseState,
  removeLocalPdfParseArtifacts,
} from "./localPdfIngestion";
import { legalKnowledgeGraphStore } from "./legalKnowledgeGraphStore";
import { removeDocumentFromLocalTabularReviews } from "./localTabularStore";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "./docxTrackedChanges";

export type LocalLibraryKind = "file" | "template";

export type LocalDocumentMetadata = {
  jurisdiction: string | null;
  areas_of_law: string[];
  document_types: string[];
  description: string | null;
};

export type LocalTrackedEdit = {
  id: string;
  changeId: string;
  delWId?: string;
  insWId?: string;
  deletedText: string;
  insertedText: string;
  contextBefore: string;
  contextAfter: string;
  reason?: string;
  status: "pending" | "accepted" | "rejected";
};

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
  source: "upload" | "user_upload";
  provenance?: {
    schemaVersion: 1;
    actor: "assistant";
    action: "created" | "revised";
    parentVersionId?: string;
    changeCount?: number;
    trackedEdits?: LocalTrackedEdit[];
    generation?: {
      rendererVersion: "beaver.docx-markdown.v1";
      markdownSha256: string;
      fieldValuesSha256: string;
      sourceRegistrySha256: string;
      evidenceBindings: {
        id: string;
        handles: string[];
        sourceSha256: string;
        locators: string[];
        url: string;
      }[];
    };
  };
  createdAt: string;
  filename: string;
  fileType: string;
  sizeBytes: number;
  pageCount: number | null;
  storagePath: string;
  pdfStoragePath: string | null;
  sourceSha256?: string;
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
  metadata?: LocalDocumentMetadata;
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

const dataRoot = mikeLocalDataHome();
const databasePath = path.join(dataRoot, "library.sqlite");
let mutationTail: Promise<unknown> = Promise.resolve();
let databasePromise: Promise<DatabaseSync> | null = null;

function emptyDocumentMetadata(): LocalDocumentMetadata {
  return {
    jurisdiction: null,
    areas_of_law: [],
    document_types: [],
    description: null,
  };
}

function cleanMetadata(value: unknown): LocalDocumentMetadata {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (input: unknown, max: number) =>
    typeof input === "string" && input.trim()
      ? input.trim().slice(0, max)
      : null;
  const list = (input: unknown) =>
    Array.isArray(input)
      ? [...new Set(input.filter((item): item is string => typeof item === "string")
          .map((item) => item.trim()).filter(Boolean))].slice(0, 20)
      : [];
  return {
    jurisdiction: text(source.jurisdiction, 160),
    areas_of_law: list(source.areas_of_law),
    document_types: list(source.document_types),
    description: text(source.description, 500),
  };
}

function loadDatabase() {
  if (!databasePromise) {
    databasePromise = openDatabase().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function openDatabase() {
  await mkdir(dataRoot, { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS local_library_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'template')),
      name TEXT NOT NULL,
      parent_folder_id TEXT REFERENCES local_library_folders(id) ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_library_documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'template')),
      folder_id TEXT REFERENCES local_library_folders(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      filename TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_library_legal_sources (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      pointer_json TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS local_library_documents_scope
      ON local_library_documents(user_id, kind, folder_id, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS local_library_folders_scope
      ON local_library_folders(user_id, kind, parent_folder_id, name COLLATE NOCASE, id);
    CREATE VIRTUAL TABLE IF NOT EXISTS local_document_filenames USING fts5(
      document_id UNINDEXED, filename, tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS local_document_filenames_insert
    AFTER INSERT ON local_library_documents BEGIN
      INSERT INTO local_document_filenames(document_id, filename)
      VALUES (new.id, new.filename);
    END;
    CREATE TRIGGER IF NOT EXISTS local_document_filenames_update
    AFTER UPDATE OF filename ON local_library_documents BEGIN
      DELETE FROM local_document_filenames WHERE document_id = old.id;
      INSERT INTO local_document_filenames(document_id, filename)
      VALUES (new.id, new.filename);
    END;
    CREATE TRIGGER IF NOT EXISTS local_document_filenames_delete
    AFTER DELETE ON local_library_documents BEGIN
      DELETE FROM local_document_filenames WHERE document_id = old.id;
    END;
    PRAGMA user_version = 1;
  `);
  return database;
}

function mutateDatabase<T>(
  operation: (database: DatabaseSync) => Promise<T> | T,
): Promise<T> {
  const result = mutationTail.then(async () => {
    const database = await loadDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = await operation(database);
      database.exec("COMMIT");
      return value;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
  mutationTail = result.catch(() => undefined);
  return result;
}

async function currentDatabase() {
  await mutationTail;
  return loadDatabase();
}

export async function warmLocalDocumentStore() {
  await currentDatabase();
}

export async function closeLocalDocumentStore() {
  await mutationTail;
  if (!databasePromise) return;
  const database = await databasePromise;
  database.close();
  databasePromise = null;
}

async function ensureLocalPdfRendition(
  userId: string,
  documentId: string,
  versionId?: string | null,
) {
  return mutateDatabase(async (database) => {
    const document = databaseDocument(database, userId, documentId);
    if (!document) return;
    const version = versionId
      ? document.versions.find((item) => item.id === versionId)
      : activeVersion(document);
    if (
      !version ||
      version.pdfStoragePath ||
      !shouldConvertToPdf(version.fileType)
    ) {
      return;
    }

    const pdf = await docxToPdf(
      await readFile(absoluteDataPath(version.storagePath)),
    );
    const hash = sha256(pdf);
    const relativePath = path.join(
      "files",
      documentId,
      `${version.id}-${hash.slice(0, 16)}.pdf`,
    );
    await writeFile(absoluteDataPath(relativePath), pdf);
    version.pdfStoragePath = relativePath;
    saveDocument(database, document);
  });
}

function suffixFor(filename: string) {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

function activeVersion(document: LocalDocument) {
  const version =
    document.versions.find((version) => version.id === document.currentVersionId) ??
    document.versions[document.versions.length - 1];
  if (!version) throw new Error("Local document has no versions");
  return version;
}

function absoluteDataPath(relativePath: string) {
  const resolved = path.resolve(dataRoot, relativePath);
  if (resolved !== dataRoot && !resolved.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error("Invalid local document path");
  }
  return resolved;
}

async function writeVersionFiles(
  documentId: string,
  versionId: string,
  filename: string,
  bytes: Buffer,
) {
  const suffix = suffixFor(filename);
  if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
    throw new Error(`Unsupported file type: ${suffix || "unknown"}`);
  }
  if (isImageDocumentType(suffix)) validateImageBytes(filename, bytes);

  const sourceSha256 = sha256(bytes);
  const relativeDirectory = path.join("files", documentId);
  const relativeSource = path.join(
    relativeDirectory,
    `${versionId}-${sourceSha256.slice(0, 16)}.${suffix}`,
  );
  await mkdir(absoluteDataPath(relativeDirectory), { recursive: true });
  await writeFile(absoluteDataPath(relativeSource), bytes);

  let relativePdf: string | null = suffix === "pdf" ? relativeSource : null;
  if (
    shouldConvertToPdf(suffix) &&
    process.env.MIKE_EAGER_OFFICE_PDF_RENDITION !== "0"
  ) {
    try {
      const pdf = await docxToPdf(bytes);
      const pdfHash = sha256(pdf);
      relativePdf = path.join(
        relativeDirectory,
        `${versionId}-${pdfHash.slice(0, 16)}.pdf`,
      );
      await writeFile(absoluteDataPath(relativePdf), pdf);
    } catch (error) {
      console.warn("[local-library] Office to PDF conversion unavailable", {
        filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { suffix, relativeSource, relativePdf, sourceSha256 };
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
      ? await peekLocalPdfParseState(absoluteDataPath(version.storagePath))
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
    metadata: cleanMetadata(document.metadata),
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
  const row = (await currentDatabase()).prepare(
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
  const database = await currentDatabase();
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
  const database = await currentDatabase();
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
  const database = await currentDatabase();
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
  const database = await currentDatabase();
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

export async function createLocalDocument(params: {
  userId: string;
  kind: LocalLibraryKind;
  filename: string;
  bytes: Buffer;
  provenance?: LocalVersion["provenance"];
}) {
  const saved = await mutateDatabase(async (database) => {
    const now = new Date().toISOString();
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const files = await writeVersionFiles(
      documentId,
      versionId,
      params.filename,
      params.bytes,
    );
    const version: LocalVersion = {
      id: versionId,
      versionNumber: 1,
      source: "upload",
      provenance: params.provenance,
      createdAt: now,
      filename: params.filename.slice(0, 200),
      fileType: files.suffix,
      sizeBytes: params.bytes.byteLength,
      pageCount: null,
      storagePath: files.relativeSource,
      pdfStoragePath: files.relativePdf,
      sourceSha256: files.sourceSha256,
    };
    const document: LocalDocument = {
      id: documentId,
      userId: params.userId,
      kind: params.kind,
      folderId: null,
      createdAt: now,
      updatedAt: now,
      currentVersionId: versionId,
      versions: [version],
      metadata: emptyDocumentMetadata(),
      notes: null,
    };
    saveDocument(database, document);
    return { document, version };
  });
  return localDocumentResponse(saved.document);
}

async function getLocalDocument(userId: string, documentId: string) {
  return databaseDocument(await currentDatabase(), userId, documentId);
}

export async function getLocalVersionFile(
  userId: string,
  documentId: string,
  versionId?: string | null,
  preferPdf = false,
) {
  let document = await getLocalDocument(userId, documentId);
  if (!document) return null;
  let version = versionId
    ? document.versions.find((item) => item.id === versionId)
    : activeVersion(document);
  if (!version) return null;
  if (
    preferPdf &&
    !version.pdfStoragePath &&
    shouldConvertToPdf(version.fileType)
  ) {
    try {
      await ensureLocalPdfRendition(userId, documentId, version.id);
      const refreshed = await getLocalDocument(userId, documentId);
      const refreshedVersion = refreshed?.versions.find(
        (item) => item.id === version!.id,
      );
      if (refreshed && refreshedVersion) {
        document = refreshed;
        version = refreshedVersion;
      }
    } catch {
      // Native Office preview remains available when conversion is unavailable.
    }
  }
  const relativePath = preferPdf && version.pdfStoragePath
    ? version.pdfStoragePath
    : version.storagePath;
  return {
    document: await localDocumentResponse(document),
    version: localVersionResponse(version),
    path: absoluteDataPath(relativePath),
    fileType:
      preferPdf && version.pdfStoragePath ? "pdf" : version.fileType,
  };
}

export async function getLocalVersionFiles(
  userId: string,
  documentIds: Iterable<string>,
) {
  const wanted = [...new Set(documentIds)];
  if (!wanted.length) return new Map();
  const database = await currentDatabase();
  return new Map(databaseDocuments(database, userId, wanted).map((document) => {
    const version = activeVersion(document);
    return [document.id, { path: absoluteDataPath(version.storagePath),
      fileType: version.fileType, filename: version.filename }];
  }));
}

export async function listLocalVersions(userId: string, documentId: string) {
  const document = await getLocalDocument(userId, documentId);
  if (!document) return null;
  return {
    current_version_id: document.currentVersionId,
    versions: document.versions.map(localVersionResponse),
  };
}

export async function addLocalVersion(params: {
  userId: string;
  documentId: string;
  filename: string;
  bytes: Buffer;
  expectedVersionId?: string;
  provenance?: LocalVersion["provenance"];
}) {
  const saved = await mutateDatabase(async (database) => {
    const document = databaseDocument(database, params.userId, params.documentId);
    if (
      !document ||
      (params.expectedVersionId &&
        document.currentVersionId !== params.expectedVersionId)
    ) {
      return null;
    }
    const versionId = crypto.randomUUID();
    const files = await writeVersionFiles(
      document.id,
      versionId,
      params.filename,
      params.bytes,
    );
    const version: LocalVersion = {
      id: versionId,
      versionNumber:
        Math.max(...document.versions.map((item) => item.versionNumber)) + 1,
      source: "user_upload",
      provenance: params.provenance,
      createdAt: new Date().toISOString(),
      filename: params.filename.slice(0, 200),
      fileType: files.suffix,
      sizeBytes: params.bytes.byteLength,
      pageCount: null,
      storagePath: files.relativeSource,
      pdfStoragePath: files.relativePdf,
      sourceSha256: files.sourceSha256,
    };
    document.versions.push(version);
    document.currentVersionId = version.id;
    document.updatedAt = version.createdAt;
    saveDocument(database, document);
    return { document, version };
  });
  if (!saved) return null;
  return localVersionResponse(saved.version);
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

function databaseDocuments(
  database: DatabaseSync,
  userId: string,
  documentIds: string[],
) {
  if (!documentIds.length) return [];
  const rows = database.prepare(
    `SELECT payload FROM local_library_documents
     WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
  ).all(userId, JSON.stringify(documentIds)) as DocumentRow[];
  return documentsFromRows(rows);
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

async function overwriteLocalVersionFiles(
  document: LocalDocument,
  version: LocalVersion,
  filename: string,
  bytes: Buffer,
) {
  if (suffixFor(filename) !== version.fileType) return false;
  const previousPaths = new Set(
    [version.storagePath, version.pdfStoragePath].filter(
      (item): item is string => !!item,
    ),
  );
  const files = await writeVersionFiles(
    document.id,
    version.id,
    filename,
    bytes,
  );
  version.filename = filename.slice(0, 200);
  version.sizeBytes = bytes.byteLength;
  version.storagePath = files.relativeSource;
  version.pdfStoragePath = files.relativePdf;
  version.sourceSha256 = files.sourceSha256;
  const nextPaths = new Set(
    [version.storagePath, version.pdfStoragePath].filter(
      (item): item is string => !!item,
    ),
  );
  await Promise.all(
    [...previousPaths]
      .filter((item) => !nextPaths.has(item))
      .flatMap((item) => {
        const absolute = absoluteDataPath(item);
        return [
          rm(absolute, { force: true }),
          removeLocalPdfParseArtifacts(absolute),
        ];
      }),
  );
  return true;
}

/** Overwrite the one assistant-edit version created for this turn. */
export async function updateLocalAssistantTurnVersion(params: {
  userId: string;
  documentId: string;
  versionId: string;
  parentVersionId: string;
  filename: string;
  bytes: Buffer;
  trackedEdits: LocalTrackedEdit[];
}) {
  const saved = await mutateDatabase(async (database) => {
    const document = databaseDocument(database, params.userId, params.documentId);
    const version = document?.versions.find(
      (item) => item.id === params.versionId,
    );
    if (
      !document ||
      !version ||
      document.currentVersionId !== version.id ||
      version.provenance?.actor !== "assistant" ||
      version.provenance.action !== "revised" ||
      version.provenance.parentVersionId !== params.parentVersionId
    ) {
      return null;
    }
    const priorEdits = version.provenance.trackedEdits ?? [];
    const retainedIds = new Set(
      (await extractTrackedChangeIds(params.bytes)).map((entry) => entry.w_id),
    );
    if (
      priorEdits.some((edit) =>
        [edit.delWId, edit.insWId]
          .filter((id): id is string => !!id)
          .some((id) => !retainedIds.has(id)),
      )
    ) {
      // A later same-turn edit touched an earlier tracked wrapper. Refuse the
      // overwrite instead of leaving an accept/reject receipt pointing at an
      // ID that no longer exists.
      throw new Error(
        "A later same-turn edit overlaps an earlier tracked change; split it into a new turn so every accept/reject receipt remains valid",
      );
    }
    if (
      !(await overwriteLocalVersionFiles(
        document,
        version,
        params.filename,
        params.bytes,
      ))
    ) {
      return null;
    }
    version.provenance = {
      schemaVersion: 1,
      actor: "assistant",
      action: "revised",
      parentVersionId: params.parentVersionId,
      changeCount:
        (version.provenance.changeCount ?? priorEdits.length) +
        params.trackedEdits.length,
      trackedEdits: [...priorEdits, ...params.trackedEdits],
    };
    document.updatedAt = new Date().toISOString();
    saveDocument(database, document);
    return version;
  });
  return saved ? localVersionResponse(saved) : null;
}

export async function renameLocalVersion(
  userId: string,
  documentId: string,
  versionId: string,
  filename: string,
) {
  return mutateDatabase((database) => {
    const document = databaseDocument(database, userId, documentId);
    const version = document?.versions.find((item) => item.id === versionId);
    if (!document || !version) return null;
    version.filename = filename.slice(0, 200);
    document.updatedAt = new Date().toISOString();
    saveDocument(database, document);
    return localVersionResponse(version);
  });
}

export async function replaceLocalVersion(params: {
  userId: string;
  documentId: string;
  versionId: string;
  filename: string;
  bytes: Buffer;
}) {
  const saved = await mutateDatabase(async (database) => {
    const document = databaseDocument(database, params.userId, params.documentId);
    const version = document?.versions.find((item) => item.id === params.versionId);
    if (!document || !version) return null;
    if (
      !(await overwriteLocalVersionFiles(
        document,
        version,
        params.filename,
        params.bytes,
      ))
    ) {
      return null;
    }
    version.createdAt = new Date().toISOString();
    delete version.provenance;
    document.updatedAt = version.createdAt;
    saveDocument(database, document);
    return { document, version };
  });
  if (!saved) return null;
  return localVersionResponse(saved.version);
}

export async function resolveLocalTrackedEdit(params: {
  userId: string;
  documentId: string;
  editId: string;
  mode: "accept" | "reject";
}) {
  const saved = await mutateDatabase(async (database) => {
    const document = databaseDocument(database, params.userId, params.documentId);
    if (!document) return { status: "missing" as const };
    const version = activeVersion(document);
    const edit = version.provenance?.trackedEdits?.find(
      (item) => item.id === params.editId,
    );
    if (!edit) return { status: "missing" as const };
    const nextStatus =
      params.mode === "accept" ? ("accepted" as const) : ("rejected" as const);
    if (edit.status !== "pending") {
      return edit.status === nextStatus
        ? { status: "unchanged" as const, document, version, edit }
        : { status: "conflict" as const, edit };
    }
    const changeIds = [edit.delWId, edit.insWId].filter(
      (item): item is string => !!item,
    );
    if (!changeIds.length) return { status: "invalid" as const };

    const previousPaths = new Set(
      [version.storagePath, version.pdfStoragePath].filter(
        (item): item is string => !!item,
      ),
    );
    const resolved = await resolveTrackedChange(
      await readFile(absoluteDataPath(version.storagePath)),
      changeIds,
      params.mode,
    );
    if (!resolved.found) return { status: "invalid" as const };
    const files = await writeVersionFiles(
      document.id,
      version.id,
      version.filename,
      resolved.bytes,
    );
    version.sizeBytes = resolved.bytes.byteLength;
    version.storagePath = files.relativeSource;
    version.pdfStoragePath = files.relativePdf;
    version.sourceSha256 = files.sourceSha256;
    edit.status = nextStatus;
    document.updatedAt = new Date().toISOString();
    saveDocument(database, document);

    const nextPaths = new Set(
      [version.storagePath, version.pdfStoragePath].filter(
        (item): item is string => !!item,
      ),
    );
    await Promise.all(
      [...previousPaths]
        .filter((item) => !nextPaths.has(item))
        .flatMap((item) => {
          const absolute = absoluteDataPath(item);
          return [
            rm(absolute, { force: true }),
            removeLocalPdfParseArtifacts(absolute),
          ];
        }),
    );
    return { status: "resolved" as const, document, version, edit };
  });
  if (
    saved.status !== "resolved" &&
    saved.status !== "unchanged"
  ) {
    return saved;
  }
  return {
    status: saved.status,
    edit: saved.edit,
    document: await localDocumentResponse(saved.document),
    version: localVersionResponse(saved.version),
  };
}

export async function localTrackedEditStatuses(
  userId: string,
  documentIds: Iterable<string>,
) {
  const database = await currentDatabase();
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

export async function deleteLocalVersion(
  userId: string,
  documentId: string,
  versionId: string,
) {
  return mutateDatabase(async (database) => {
    const document = databaseDocument(database, userId, documentId);
    if (!document) return { status: "missing" as const };
    if (document.versions.length <= 1) return { status: "only" as const };
    const index = document.versions.findIndex((item) => item.id === versionId);
    if (index < 0) return { status: "missing" as const };
    const [removed] = document.versions.splice(index, 1);
    if (document.currentVersionId === versionId) {
      document.currentVersionId = document.versions
        .slice()
        .sort((a, b) => b.versionNumber - a.versionNumber)[0].id;
    }
    document.updatedAt = new Date().toISOString();
    saveDocument(database, document);
    await Promise.all(
      [...new Set([removed.storagePath, removed.pdfStoragePath])]
        .filter((item): item is string => !!item)
        .flatMap((item) => {
          const absolute = absoluteDataPath(item);
          return [
            rm(absolute, { force: true }),
            removeLocalPdfParseArtifacts(absolute),
          ];
        }),
    );
    return {
      status: "deleted" as const,
      currentVersionId: document.currentVersionId,
    };
  });
}

export async function moveLocalDocument(
  userId: string,
  kind: LocalLibraryKind,
  documentId: string,
  folderId: string | null,
) {
  return mutateDatabase((database) => {
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
    return localDocumentResponse(document);
  });
}

export async function deleteLocalDocument(userId: string, documentId: string) {
  const deleted = await mutateDatabase(async (database) => {
    const document = databaseDocument(database, userId, documentId);
    if (!document) return false;
    await Promise.all(
      document.versions
        .filter((version) => version.fileType === "pdf")
        .map((version) =>
          removeLocalPdfParseArtifacts(
            absoluteDataPath(version.storagePath),
          ),
        ),
    );
    database.prepare(
      "DELETE FROM local_library_documents WHERE id = ? AND user_id = ?",
    ).run(documentId, userId);
    if (/^[a-f0-9-]{36}$/i.test(documentId)) {
      await rm(absoluteDataPath(path.join("files", documentId)), {
        recursive: true,
        force: true,
      });
    }
    return true;
  });
  if (deleted) {
    legalKnowledgeGraphStore().removeDocumentsFromMatters(userId, [documentId]);
    removeDocumentFromLocalTabularReviews(userId, documentId);
  }
  return deleted;
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

export async function deleteLocalFolder(
  userId: string,
  kind: LocalLibraryKind,
  folderId: string,
) {
  const deletedDocumentIds = await mutateDatabase(async (database) => {
    if (!database.prepare(
      `SELECT 1 FROM local_library_folders
       WHERE id = ? AND user_id = ? AND kind = ?`,
    ).get(folderId, userId, kind)) return null;
    const rows = database.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM local_library_folders
         WHERE id = ? AND user_id = ? AND kind = ?
         UNION ALL
         SELECT f.id FROM local_library_folders f
         JOIN descendants d ON f.parent_folder_id = d.id
         WHERE f.user_id = ? AND f.kind = ?
       )
       SELECT d.payload
       FROM local_library_documents d
       WHERE d.user_id = ? AND d.kind = ?
         AND d.folder_id IN (SELECT id FROM descendants)`,
    ).all(folderId, userId, kind, userId, kind, userId, kind) as DocumentRow[];
    const documents = documentsFromRows(rows);
    const documentIds = documents.map((document) => document.id);
    await Promise.all(
      documents.flatMap((document) =>
        document.versions
          .filter((version) => version.fileType === "pdf")
          .map((version) =>
            removeLocalPdfParseArtifacts(
              absoluteDataPath(version.storagePath),
            ),
          ),
      ),
    );
    database.prepare(
      `DELETE FROM local_library_folders
       WHERE id = ? AND user_id = ? AND kind = ?`,
    ).run(folderId, userId, kind);
    await Promise.all(
      documentIds
        .filter((id) => /^[a-f0-9-]{36}$/i.test(id))
        .map((id) =>
          rm(absoluteDataPath(path.join("files", id)), {
            recursive: true,
            force: true,
          }),
        ),
    );
    return documentIds;
  });
  if (!deletedDocumentIds) return false;
  legalKnowledgeGraphStore().removeDocumentsFromMatters(
    userId,
    deletedDocumentIds,
  );
  for (const documentId of deletedDocumentIds) {
    removeDocumentFromLocalTabularReviews(userId, documentId);
  }
  return true;
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
  const database = await currentDatabase();
  const rows = database.prepare(
    `SELECT pointer_json FROM local_library_legal_sources
     WHERE user_id = ? ORDER BY id`,
  ).all(userId) as { pointer_json: string }[];
  return rows.map((row) =>
    legalSourceResponse(parsedJson(row.pointer_json, {} as LocalLegalSourcePointer)));
}

export async function getLocalLegalSource(userId: string, id: string) {
  const row = (await currentDatabase()).prepare(
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
  filename?: string;
  metadata?: unknown;
  notes?: unknown;
}) {
  return mutateDatabase((database) => {
    const document = databaseDocument(database, params.userId, params.documentId);
    if (document?.kind !== params.kind) return null;
    if (params.filename !== undefined) {
      activeVersion(document).filename = params.filename.slice(0, 200);
    }
    if (params.metadata !== undefined) {
      document.metadata = cleanMetadata(params.metadata);
    }
    if (params.notes !== undefined) {
      document.notes =
        typeof params.notes === "string" && params.notes.trim()
          ? params.notes.trim().slice(0, 500)
          : null;
    }
    document.updatedAt = new Date().toISOString();
    saveDocument(database, document);
    return localDocumentResponse(document);
  });
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
