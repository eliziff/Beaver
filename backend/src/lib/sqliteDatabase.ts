import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mikeLocalDataHome } from "./legalDataPath";

export const SQLITE_SCHEMA_VERSION = 9;

const processState = globalThis as typeof globalThis & {
  __beaverSqliteDatabase?: { database: DatabaseSync | null };
};
const shared = processState.__beaverSqliteDatabase ??=
  { database: null };

const schema = `
  CREATE TABLE IF NOT EXISTS library_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'template')),
    name TEXT NOT NULL,
    parent_folder_id TEXT REFERENCES library_folders(id) ON DELETE CASCADE
      DEFERRABLE INITIALLY DEFERRED,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'template')),
    project_id TEXT,
    folder_id TEXT,
    library_folder_id TEXT REFERENCES library_folders(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'ready',
    current_version_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    filename TEXT NOT NULL,
    CHECK (project_id IS NULL OR library_folder_id IS NULL),
    CHECK (project_id IS NOT NULL OR folder_id IS NULL)
  );
  CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    page_count INTEGER,
    source_sha256 TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    pdf_storage_path TEXT,
    cleanup_paths_json TEXT NOT NULL DEFAULT '[]',
    provenance_json TEXT,
    UNIQUE(document_id, version_number)
  );
  CREATE TABLE IF NOT EXISTS document_edits (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    change_id TEXT NOT NULL,
    del_w_id TEXT,
    ins_w_id TEXT,
    deleted_text TEXT NOT NULL DEFAULT '',
    inserted_text TEXT NOT NULL DEFAULT '',
    context_before TEXT NOT NULL DEFAULT '',
    context_after TEXT NOT NULL DEFAULT '',
    reason TEXT,
    diff_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected'))
  );
  CREATE TABLE IF NOT EXISTS library_legal_sources (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    pointer_json TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS object_cleanup (
    storage_path TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_scope
    ON documents(
      user_id, project_id, kind, library_folder_id, updated_at DESC, id DESC
    );
  CREATE INDEX IF NOT EXISTS project_documents_scope
    ON documents(user_id, project_id, folder_id, filename, id);
  CREATE INDEX IF NOT EXISTS document_versions_scope
    ON document_versions(document_id, version_number);
  CREATE INDEX IF NOT EXISTS document_edits_scope
    ON document_edits(document_id, version_id);
  CREATE INDEX IF NOT EXISTS library_folders_scope
    ON library_folders(user_id, kind, parent_folder_id, name COLLATE NOCASE, id);
  CREATE VIRTUAL TABLE IF NOT EXISTS document_filenames USING fts5(
    document_id UNINDEXED, filename, tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS document_filenames_insert
  AFTER INSERT ON documents BEGIN
    INSERT INTO document_filenames(document_id, filename)
    VALUES (new.id, new.filename);
  END;
  CREATE TRIGGER IF NOT EXISTS document_filenames_update
  AFTER UPDATE OF filename ON documents BEGIN
    DELETE FROM document_filenames WHERE document_id = old.id;
    INSERT INTO document_filenames(document_id, filename)
    VALUES (new.id, new.filename);
  END;
  CREATE TRIGGER IF NOT EXISTS document_filenames_delete
  AFTER DELETE ON documents BEGIN
    DELETE FROM document_filenames WHERE document_id = old.id;
  END;

  CREATE TABLE IF NOT EXISTS projects (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    cm_number TEXT,
    practice TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS project_subfolders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_folder_id TEXT REFERENCES project_subfolders(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id, project_id)
      REFERENCES projects(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS project_subfolders_scope
    ON project_subfolders(user_id, project_id, parent_folder_id, name, id);
  CREATE INDEX IF NOT EXISTS projects_user_created
    ON projects(user_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS tabular_reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    title TEXT,
    columns_json TEXT NOT NULL DEFAULT '[]',
    document_ids_json TEXT NOT NULL DEFAULT '[]',
    workflow_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS tabular_cells (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES tabular_reviews(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    column_index INTEGER NOT NULL,
    content_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','generating','done','error')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(review_id,document_id,column_index)
  );
  CREATE INDEX IF NOT EXISTS tabular_reviews_user_updated
    ON tabular_reviews(user_id,updated_at DESC,id);
  CREATE INDEX IF NOT EXISTS tabular_reviews_project_updated
    ON tabular_reviews(user_id,project_id,updated_at DESC,id);
  CREATE TRIGGER IF NOT EXISTS document_tabular_cleanup
  AFTER DELETE ON documents BEGIN
    UPDATE tabular_reviews SET document_ids_json=(SELECT json_group_array(value)
      FROM json_each(document_ids_json) WHERE value<>old.id),updated_at=datetime('now')
      WHERE user_id=old.user_id AND EXISTS(
        SELECT 1 FROM json_each(document_ids_json) WHERE value=old.id);
    DELETE FROM tabular_cells WHERE document_id=old.id AND review_id IN(
      SELECT id FROM tabular_reviews WHERE user_id=old.user_id);
  END;

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    tabular_review_id TEXT,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    transcript_version INTEGER NOT NULL DEFAULT 0 CHECK (transcript_version >= 0),
    CHECK (project_id IS NULL OR tabular_review_id IS NULL),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, project_id)
      REFERENCES projects(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS chats_active
    ON chats(user_id, deleted_at, updated_at DESC, created_at DESC, id);
  CREATE INDEX IF NOT EXISTS chats_project
    ON chats(user_id, project_id, deleted_at, updated_at DESC, id);
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    turn_id TEXT,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content_json TEXT NOT NULL,
    files_json TEXT,
    workflow_json TEXT,
    citations_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_messages_chat
    ON chat_messages(chat_id,created_at,id);
  CREATE TABLE IF NOT EXISTS provider_sessions (
    chat_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    continuation_id TEXT NOT NULL,
    compatibility_key TEXT NOT NULL,
    transcript_version INTEGER NOT NULL CHECK (transcript_version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id, chat_id)
      REFERENCES chats(user_id, id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('assistant','tabular')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workflows_user_created
    ON workflows(user_id,created_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS hidden_workflows (
    user_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    PRIMARY KEY(user_id,workflow_id)
  );
`;

export function openSqliteDatabase(
  filename = path.join(mikeLocalDataHome(), "application.sqlite"),
) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  try {
    const version = (database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version;
    if (version !== 0 && version !== SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported local application schema version ${version}; ` +
        `expected ${SQLITE_SCHEMA_VERSION}`,
      );
    }
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA recursive_triggers = ON;
      ${schema}
      PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function sqliteDatabase() {
  return shared.database ??= openSqliteDatabase();
}

export function sqliteTransaction<T>(
  operation: (database: DatabaseSync) => T &
    (T extends PromiseLike<unknown> ? never : unknown),
  database = sqliteDatabase(),
) {
  if (operation.constructor.name === "AsyncFunction") {
    throw new Error("Local application transactions must be synchronous");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation(database);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("Local application transactions must be synchronous");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function closeSqliteDatabase() {
  shared.database?.close();
  shared.database = null;
}
