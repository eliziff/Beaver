import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mikeLocalDataHome } from "./legalDataPath";

export const LOCAL_APPLICATION_SCHEMA_VERSION = 3;

const processState = globalThis as typeof globalThis & {
  __beaverLocalApplicationDatabase?: { database: DatabaseSync | null };
};
const shared = processState.__beaverLocalApplicationDatabase ??=
  { database: null };

const schema = `
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
  CREATE TABLE IF NOT EXISTS object_cleanup (
    storage_path TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
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

  CREATE TABLE IF NOT EXISTS legal_knowledge_projects (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS legal_knowledge_nodes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS legal_knowledge_nodes_scope
    ON legal_knowledge_nodes(user_id, project_id, kind, sort_order);
  CREATE TABLE IF NOT EXISTS legal_knowledge_edges (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL REFERENCES legal_knowledge_nodes(id) ON DELETE CASCADE,
    to_node_id TEXT NOT NULL REFERENCES legal_knowledge_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id, from_node_id, to_node_id, relation)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS legal_knowledge_one_parent
    ON legal_knowledge_edges(user_id, project_id, from_node_id)
    WHERE relation = 'parent';
  CREATE INDEX IF NOT EXISTS legal_knowledge_edges_scope
    ON legal_knowledge_edges(user_id, project_id, relation, sort_order);
  CREATE TABLE IF NOT EXISTS legal_knowledge_evidence (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    locator_kind TEXT NOT NULL DEFAULT '',
    locator TEXT NOT NULL DEFAULT '',
    quote TEXT NOT NULL DEFAULT '',
    quote_sha256 TEXT NOT NULL DEFAULT '',
    canonical_url TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, project_id, source_id, locator_kind, locator)
  );
  CREATE INDEX IF NOT EXISTS legal_knowledge_evidence_scope
    ON legal_knowledge_evidence(user_id, project_id, source_id);
  CREATE TABLE IF NOT EXISTS legal_knowledge_evidence_links (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES legal_knowledge_evidence(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES legal_knowledge_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id, evidence_id, node_id, relation)
  );
  CREATE INDEX IF NOT EXISTS legal_knowledge_evidence_links_scope
    ON legal_knowledge_evidence_links(user_id, project_id, relation);
  CREATE TABLE IF NOT EXISTS legal_knowledge_source_marks (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id, source_id)
  );
  CREATE TABLE IF NOT EXISTS legal_knowledge_source_mark_labels (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    label_id TEXT NOT NULL REFERENCES legal_knowledge_nodes(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, project_id, source_id, label_id),
    FOREIGN KEY (user_id, project_id, source_id)
      REFERENCES legal_knowledge_source_marks(user_id, project_id, source_id)
      ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS legal_knowledge_source_mark_labels_scope
    ON legal_knowledge_source_mark_labels(user_id, project_id, source_id, sort_order);
  CREATE TABLE IF NOT EXISTS mike_matter_metadata (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    cm_number TEXT,
    practice TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    notes TEXT,
    PRIMARY KEY (user_id, project_id),
    FOREIGN KEY (user_id, project_id)
      REFERENCES legal_knowledge_projects(user_id, id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS mike_matter_documents (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES local_library_documents(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id, document_id),
    FOREIGN KEY (user_id, project_id)
      REFERENCES legal_knowledge_projects(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS mike_matter_documents_scope
    ON mike_matter_documents(user_id, project_id, sort_order, created_at);
  CREATE TRIGGER IF NOT EXISTS local_library_documents_matter_delete
  AFTER DELETE ON local_library_documents BEGIN
    DELETE FROM mike_matter_documents
    WHERE user_id = old.user_id AND document_id = old.id;
  END;
  CREATE INDEX IF NOT EXISTS legal_knowledge_projects_user_created
    ON legal_knowledge_projects(user_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS local_chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    tabular_review_id TEXT,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    transcript_version INTEGER NOT NULL DEFAULT 0 CHECK (transcript_version >= 0),
    messages_json TEXT NOT NULL DEFAULT '[]',
    CHECK (project_id IS NULL OR tabular_review_id IS NULL),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, project_id)
      REFERENCES legal_knowledge_projects(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS local_chats_active
    ON local_chats(user_id, deleted_at, updated_at DESC, created_at DESC, id);
  CREATE INDEX IF NOT EXISTS local_chats_project
    ON local_chats(user_id, project_id, deleted_at, updated_at DESC, id);
  CREATE TABLE IF NOT EXISTS local_codex_sessions (
    chat_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    continuation_id TEXT NOT NULL,
    compatibility_key TEXT NOT NULL,
    transcript_version INTEGER NOT NULL CHECK (transcript_version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id, chat_id)
      REFERENCES local_chats(user_id, id) ON DELETE CASCADE
  );
`;

export function openLocalApplicationDatabase(
  filename = path.join(mikeLocalDataHome(), "application.sqlite"),
) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA recursive_triggers = ON;
      ${schema}
      PRAGMA user_version = ${LOCAL_APPLICATION_SCHEMA_VERSION};
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function localApplicationDatabase() {
  return shared.database ??= openLocalApplicationDatabase();
}

export function localApplicationTransaction<T>(
  operation: (database: DatabaseSync) => T &
    (T extends PromiseLike<unknown> ? never : unknown),
  database = localApplicationDatabase(),
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

export function warmLocalApplicationDatabase() {
  localApplicationDatabase();
}

export function closeLocalApplicationDatabase() {
  shared.database?.close();
  shared.database = null;
}
