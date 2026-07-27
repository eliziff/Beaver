import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mikeLocalDataHome } from "./legalDataPath";

export type LocalTabularColumn = {
  index: number;
  name: string;
  prompt: string;
  format?: string;
  tags?: string[];
};

type CellContent = {
  summary: string;
  flag?: string;
  reasoning?: string;
};

type Review = {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  columns_config: LocalTabularColumn[];
  document_ids: string[];
  workflow_id: string | null;
  shared_with: [];
  is_owner: true;
  created_at: string;
  updated_at: string;
  document_count: number;
};

type Cell = {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: CellContent | null;
  status: "pending" | "generating" | "done" | "error";
  created_at: string;
};

type ReviewRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string | null;
  columns_json: string;
  document_ids_json: string;
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
};

type CellRow = Omit<Cell, "content"> & { content_json: string | null };

const REVIEW_COLUMNS =
  "id, user_id, project_id, title, columns_json, document_ids_json, " +
  "workflow_id, created_at, updated_at";

function cleanText(value: unknown, maximum = 200) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function uniqueText(values: Iterable<unknown>, maximum = 200) {
  return [...new Set(values)]
    .map((value) => cleanText(value, maximum))
    .filter((value): value is string => value !== null);
}

function normalizedColumns(input: LocalTabularColumn[]) {
  const indices = new Set<number>();
  return input.map((column) => {
    if (
      !Number.isSafeInteger(column.index) ||
      column.index < 0 ||
      indices.has(column.index)
    ) {
      throw new Error("Column indices must be unique non-negative integers");
    }
    indices.add(column.index);
    const name = cleanText(column.name);
    const prompt = cleanText(column.prompt, 20_000);
    if (!name || !prompt) throw new Error("Each column needs a name and prompt");
    const format = cleanText(column.format, 80);
    const tags = Array.isArray(column.tags)
      ? uniqueText(column.tags).slice(0, 100)
      : [];
    return {
      index: column.index,
      name,
      prompt,
      ...(format ? { format } : {}),
      ...(tags.length ? { tags } : {}),
    };
  });
}

function json<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function review(row: ReviewRow): Review {
  const documentIds = json<string[]>(row.document_ids_json, []);
  return {
    id: row.id,
    project_id: row.project_id,
    user_id: row.user_id,
    title: row.title,
    columns_config: json(row.columns_json, []),
    document_ids: documentIds,
    workflow_id: row.workflow_id,
    shared_with: [],
    is_owner: true,
    created_at: row.created_at,
    updated_at: row.updated_at,
    document_count: documentIds.length,
  };
}

function cell(row: CellRow): Cell {
  const { content_json, ...rest } = row;
  return { ...rest, content: json(content_json, null) };
}

class LocalTabularStore {
  private readonly database: DatabaseSync;

  constructor(filename = path.join(mikeLocalDataHome(), "tabular.sqlite")) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS local_tabular_reviews (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        title TEXT,
        columns_json TEXT NOT NULL DEFAULT '[]',
        document_ids_json TEXT NOT NULL DEFAULT '[]',
        workflow_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_tabular_cells (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL
          REFERENCES local_tabular_reviews(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        column_index INTEGER NOT NULL,
        content_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'generating', 'done', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (review_id, document_id, column_index)
      );
    `);
  }

  close() {
    this.database.close();
  }

  private transaction<T>(operation: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private syncCells(
    reviewId: string,
    documentIds: string[],
    columnsConfig: LocalTabularColumn[],
  ) {
    const documents = new Set(documentIds);
    const columns = new Set(
      columnsConfig.map((column) => column.index),
    );
    const rows = this.database
      .prepare(
        `SELECT id, document_id, column_index FROM local_tabular_cells
         WHERE review_id = ?`,
      )
      .all(reviewId) as {
      id: string;
      document_id: string;
      column_index: number;
    }[];
    const existing = new Set<string>();
    const remove = this.database.prepare(
      "DELETE FROM local_tabular_cells WHERE id = ?",
    );
    for (const row of rows) {
      if (
        !documents.has(row.document_id) ||
        !columns.has(row.column_index)
      ) {
        remove.run(row.id);
      } else {
        existing.add(`${row.document_id}:${row.column_index}`);
      }
    }

    const insert = this.database.prepare(
      `INSERT INTO local_tabular_cells
        (id, review_id, document_id, column_index, content_json, status,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const documentId of documentIds) {
      for (const column of columnsConfig) {
        if (existing.has(`${documentId}:${column.index}`)) continue;
        insert.run(
          crypto.randomUUID(),
          reviewId,
          documentId,
          column.index,
          now,
          now,
        );
      }
    }
  }

  list(userId: string, projectId?: string) {
    const statement = this.database.prepare(
      `SELECT ${REVIEW_COLUMNS} FROM local_tabular_reviews
       WHERE user_id = ?${projectId ? " AND project_id = ?" : ""}
       ORDER BY updated_at DESC, id`,
    );
    const rows = (
      projectId
        ? statement.all(userId, projectId)
        : statement.all(userId)
    ) as ReviewRow[];
    return rows.map(review);
  }

  get(userId: string, reviewId: string) {
    const row = this.database
      .prepare(
        `SELECT ${REVIEW_COLUMNS} FROM local_tabular_reviews
         WHERE id = ? AND user_id = ?`,
      )
      .get(reviewId, userId) as ReviewRow | undefined;
    return row ? review(row) : null;
  }

  detail(userId: string, reviewId: string) {
    const item = this.get(userId, reviewId);
    if (!item) return null;
    const cells = (
      this.database
        .prepare(
          `SELECT id, review_id, document_id, column_index, content_json,
                  status, created_at
           FROM local_tabular_cells
           WHERE review_id = ?
           ORDER BY document_id, column_index, id`,
        )
        .all(reviewId) as CellRow[]
    ).map(cell);
    return { review: item, cells };
  }

  create(params: {
    userId: string;
    title?: string | null;
    projectId?: string | null;
    columns: LocalTabularColumn[];
    documentIds: string[];
    workflowId?: string | null;
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const columns = normalizedColumns(params.columns);
    const documents = uniqueText(params.documentIds);
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO local_tabular_reviews
            (id, user_id, project_id, title, columns_json, document_ids_json,
             workflow_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.userId,
          cleanText(params.projectId),
          cleanText(params.title, 300),
          JSON.stringify(columns),
          JSON.stringify(documents),
          cleanText(params.workflowId),
          now,
          now,
        );
      this.syncCells(id, documents, columns);
      return this.get(params.userId, id)!;
    });
  }

  update(
    userId: string,
    reviewId: string,
    update: {
      title?: string | null;
      projectId?: string | null;
      columns?: LocalTabularColumn[];
      documentIds?: string[];
    },
  ) {
    const current = this.get(userId, reviewId);
    if (!current) return null;
    const next = {
      title:
        update.title === undefined ? current.title : cleanText(update.title, 300),
      projectId:
        update.projectId === undefined
          ? current.project_id
          : cleanText(update.projectId),
      columns:
        update.columns === undefined
          ? current.columns_config
          : normalizedColumns(update.columns),
      documents:
        update.documentIds === undefined
          ? current.document_ids
          : uniqueText(update.documentIds),
    };
    return this.transaction(() => {
      this.database
        .prepare(
          `UPDATE local_tabular_reviews
           SET title = ?, project_id = ?, columns_json = ?,
               document_ids_json = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .run(
          next.title,
          next.projectId,
          JSON.stringify(next.columns),
          JSON.stringify(next.documents),
          new Date().toISOString(),
          reviewId,
          userId,
        );
      this.syncCells(reviewId, next.documents, next.columns);
      return this.get(userId, reviewId)!;
    });
  }

  delete(userId: string, reviewId: string) {
    return (
      this.database
        .prepare(
          "DELETE FROM local_tabular_reviews WHERE id = ? AND user_id = ?",
        )
        .run(reviewId, userId).changes > 0
    );
  }

  deleteProjectReviews(userId: string, projectId: string) {
    this.database
      .prepare(
        "DELETE FROM local_tabular_reviews WHERE user_id = ? AND project_id = ?",
      )
      .run(userId, projectId);
  }

  removeDocument(userId: string, documentId: string) {
    for (const item of this.list(userId)) {
      if (!item.document_ids.includes(documentId)) continue;
      this.update(userId, item.id, {
        documentIds: item.document_ids.filter((id) => id !== documentId),
      });
    }
  }

  clearCells(userId: string, reviewId: string, documentIds: string[]) {
    if (!this.get(userId, reviewId)) return false;
    const clear = this.database.prepare(
      `UPDATE local_tabular_cells
       SET content_json = NULL, status = 'pending', updated_at = ?
       WHERE review_id = ? AND document_id = ?`,
    );
    const now = new Date().toISOString();
    this.transaction(() => {
      for (const documentId of uniqueText(documentIds)) {
        clear.run(now, reviewId, documentId);
      }
    });
    return true;
  }

  setCell(params: {
    userId: string;
    reviewId: string;
    documentId: string;
    columnIndex: number;
    status: Cell["status"];
    content?: CellContent | null;
  }) {
    return (
      this.database
        .prepare(
          `UPDATE local_tabular_cells
           SET content_json = ?, status = ?, updated_at = ?
           WHERE review_id = ? AND document_id = ? AND column_index = ?
             AND review_id IN (
               SELECT id FROM local_tabular_reviews WHERE user_id = ?
             )`,
        )
        .run(
          params.content ? JSON.stringify(params.content) : null,
          params.status,
          new Date().toISOString(),
          params.reviewId,
          params.documentId,
          params.columnIndex,
          params.userId,
        ).changes > 0
    );
  }
}

let sharedStore: LocalTabularStore | null = null;

export function localTabularStore() {
  sharedStore ??= new LocalTabularStore();
  return sharedStore;
}

export function closeLocalTabularStore() {
  sharedStore?.close();
  sharedStore = null;
}

export function removeDocumentFromLocalTabularReviews(
  userId: string,
  documentId: string,
) {
  const temporary = sharedStore === null;
  const store = sharedStore ?? new LocalTabularStore();
  try {
    store.removeDocument(userId, documentId);
  } finally {
    if (temporary) store.close();
  }
}
