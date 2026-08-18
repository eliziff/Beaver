import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mikeLocalDataHome } from "./legalDataPath";
import { legalKnowledgeGraphStore } from "./legalKnowledgeGraphStore";
import { listLocalDocumentsById } from "./localDocumentStore";
import {
  TabularStoreError,
  type ReviewInput,
  type TabularCell,
  type TabularCellContent,
  type TabularColumn,
  type TabularReview,
  type TabularScope,
  type TabularStore,
  type WriteResult,
} from "./tabularStore";

type ReviewRow = {
  id: string; user_id: string; project_id: string | null; title: string | null;
  columns_json: string; document_ids_json: string; workflow_id: string | null;
  created_at: string; updated_at: string;
};
type CellRow = Omit<TabularCell, "content"> & { content_json: string | null };
const REVIEW_COLUMNS = "id,user_id,project_id,title,columns_json," +
  "document_ids_json,workflow_id,created_at,updated_at";
const text = (value: unknown, max = 200) => typeof value === "string" && value.trim()
  ? value.trim().slice(0, max) : null;
const unique = (values: Iterable<unknown>, max = 200) => [...new Set(values)]
  .map((value) => text(value, max)).filter((value): value is string => !!value);
const parse = <T>(raw: string | null, fallback: T): T => {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
};
const columns = (input: TabularColumn[]) => {
  const seen = new Set<number>();
  return input.map((column) => {
    if (!Number.isSafeInteger(column.index) || column.index < 0 || seen.has(column.index))
      throw new TabularStoreError(400, "Column indices must be unique non-negative integers");
    seen.add(column.index);
    const name = text(column.name), prompt = text(column.prompt, 20_000);
    if (!name || !prompt) throw new TabularStoreError(400, "Each column needs a name and prompt");
    const format = text(column.format, 80), tags = unique(column.tags ?? []).slice(0, 100);
    return { index: column.index, name, prompt, ...(format ? { format } : {}),
      ...(tags.length ? { tags } : {}) };
  });
};
const review = (row: ReviewRow): TabularReview => {
  const documentIds = parse<string[]>(row.document_ids_json, []);
  const { columns_json, document_ids_json, ...stored } = row;
  return { ...stored, project_id: row.project_id, columns_config: parse(columns_json, []),
    document_ids: documentIds, shared_with: [], is_owner: true,
    document_count: documentIds.length };
};
const cell = (row: CellRow): TabularCell => {
  const { content_json, ...rest } = row;
  return { ...rest, content: parse(content_json, null) } as TabularCell;
};
const nextVersion = (expected: string) => new Date(Math.max(
  Date.now(), (Date.parse(expected) || 0) + 1,
)).toISOString();

class LocalTabularStore {
  private readonly db: DatabaseSync;

  constructor(filename = path.join(mikeLocalDataHome(), "tabular.sqlite")) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS local_tabular_reviews (
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT,title TEXT,
        columns_json TEXT NOT NULL DEFAULT '[]',document_ids_json TEXT NOT NULL DEFAULT '[]',
        workflow_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_tabular_cells (
        id TEXT PRIMARY KEY,review_id TEXT NOT NULL REFERENCES local_tabular_reviews(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,column_index INTEGER NOT NULL,content_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','generating','done','error')),
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(review_id,document_id,column_index));
      CREATE INDEX IF NOT EXISTS local_tabular_reviews_user_updated
        ON local_tabular_reviews(user_id,updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS local_tabular_reviews_project_updated
        ON local_tabular_reviews(user_id,project_id,updated_at DESC,id);`);
  }

  close() { this.db.close(); }
  private transaction<T>(run: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private get(userId: string, id: string) {
    const row = this.db.prepare(`SELECT ${REVIEW_COLUMNS} FROM local_tabular_reviews
      WHERE id=? AND user_id=?`).get(id, userId) as ReviewRow | undefined;
    return row ? review(row) : null;
  }
  private oneCell(userId: string, reviewId: string, documentId: string, index: number) {
    const row = this.db.prepare(`SELECT c.* FROM local_tabular_cells c
      JOIN local_tabular_reviews r ON r.id=c.review_id AND r.user_id=?
      WHERE c.review_id=? AND c.document_id=? AND c.column_index=?`)
      .get(userId, reviewId, documentId, index) as CellRow | undefined;
    return row ? cell(row) : null;
  }
  private syncCells(reviewId: string, documentIds: string[], config: TabularColumn[]) {
    const wanted = new Set(documentIds.flatMap((id) => config.map((col) => `${id}:${col.index}`)));
    const rows = this.db.prepare(`SELECT id,document_id,column_index FROM local_tabular_cells
      WHERE review_id=?`).all(reviewId) as { id: string; document_id: string; column_index: number }[];
    const present = new Set(rows.map((row) => `${row.document_id}:${row.column_index}`));
    const remove = this.db.prepare("DELETE FROM local_tabular_cells WHERE id=?");
    rows.filter((row) => !wanted.has(`${row.document_id}:${row.column_index}`))
      .forEach((row) => remove.run(row.id));
    const insert = this.db.prepare(`INSERT INTO local_tabular_cells
      (id,review_id,document_id,column_index,content_json,status,created_at,updated_at)
      VALUES(?,?,?,?,NULL,'pending',?,?)`), now = new Date().toISOString();
    for (const documentId of documentIds) for (const column of config) {
      if (!present.has(`${documentId}:${column.index}`))
        insert.run(crypto.randomUUID(), reviewId, documentId, column.index, now, now);
    }
  }

  page(userId: string, options: Parameters<TabularStore["page"]>[1]) {
    const where = ["user_id=?"], params: (string | number)[] = [userId];
    if (options.projectId) { where.push("project_id=?"); params.push(options.projectId); }
    else if (options.scope !== "all") where.push(options.scope === "in-project"
      ? "project_id IS NOT NULL" : "project_id IS NULL");
    if (options.q) { where.push("instr(lower(coalesce(title,'')),?)>0"); params.push(options.q); }
    if (options.after) { where.push("(created_at<? OR (created_at=? AND id<?))");
      params.push(options.after[0], options.after[0], options.after[1]); }
    const rows = this.db.prepare(`SELECT ${REVIEW_COLUMNS} FROM local_tabular_reviews
      WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...params, options.limit + 1) as ReviewRow[];
    const page = rows.slice(0, options.limit).map(review), last = page.at(-1);
    return { items: page.map((item) => ({ ...item, column_count: item.columns_config.length })),
      nextAfter: rows.length > options.limit && last
        ? [String(last.created_at), last.id] as [string, string] : null };
  }

  detail(userId: string, reviewId: string) {
    const item = this.get(userId, reviewId);
    if (!item) return null;
    const cells = (this.db.prepare(`SELECT * FROM local_tabular_cells WHERE review_id=?
      ORDER BY document_id,column_index,id`).all(reviewId) as CellRow[]).map(cell);
    return { review: item, cells };
  }

  create(userId: string, input: ReviewInput & { projectId: string | null;
    columns: TabularColumn[]; documentIds: string[] }) {
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const config = columns(input.columns), documentIds = unique(input.documentIds);
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO local_tabular_reviews
        (id,user_id,project_id,title,columns_json,document_ids_json,workflow_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, userId, text(input.projectId), text(input.title, 300),
        JSON.stringify(config), JSON.stringify(documentIds), text(input.workflowId), now, now);
      this.syncCells(id, documentIds, config);
      return { status: "committed", value: this.get(userId, id)! } as const;
    });
  }

  update(userId: string, id: string, expected: string, input: ReviewInput) {
    const current = this.get(userId, id);
    if (!current) return { status: "missing" } as const;
    const next = { title: input.title === undefined ? current.title : text(input.title, 300),
      project: input.projectId === undefined ? current.project_id : text(input.projectId),
      columns: input.columns === undefined ? current.columns_config : columns(input.columns),
      documents: input.documentIds === undefined ? current.document_ids : unique(input.documentIds) };
    return this.transaction<WriteResult<TabularReview>>(() => {
      const changed = this.db.prepare(`UPDATE local_tabular_reviews SET title=?,project_id=?,
        columns_json=?,document_ids_json=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=?`)
        .run(next.title, next.project, JSON.stringify(next.columns), JSON.stringify(next.documents),
          nextVersion(expected), id, userId, expected).changes;
      if (!changed) {
        const value = this.get(userId, id);
        return value ? { status: "conflict", value } : { status: "missing" };
      }
      this.syncCells(id, next.documents, next.columns);
      return { status: "committed", value: this.get(userId, id)! };
    });
  }

  delete(userId: string, id: string, expected: string): WriteResult<null> {
    const changed = this.db.prepare(`DELETE FROM local_tabular_reviews
      WHERE id=? AND user_id=? AND updated_at=?`).run(id, userId, expected).changes;
    if (changed) return { status: "committed", value: null };
    return this.get(userId, id) ? { status: "conflict", value: null } : { status: "missing" };
  }

  setCell(userId: string, input: Parameters<TabularStore["setCell"]>[1]) {
    const previous = input.expected.content ? JSON.stringify(input.expected.content) : null;
    const changed = this.db.prepare(`UPDATE local_tabular_cells SET content_json=?,status=?,updated_at=?
      WHERE review_id=? AND document_id=? AND column_index=? AND status=? AND content_json IS ?
      AND review_id IN(SELECT id FROM local_tabular_reviews WHERE user_id=?)`)
      .run(input.content ? JSON.stringify(input.content) : null, input.status, new Date().toISOString(),
        input.reviewId, input.documentId, input.columnIndex, input.expected.status, previous, userId).changes;
    const value = this.oneCell(userId, input.reviewId, input.documentId, input.columnIndex);
    return changed && value ? { status: "committed", value } as const
      : value ? { status: "conflict", value } as const : { status: "missing" } as const;
  }

  deleteProjectReviews(userId: string, projectId: string) {
    this.db.prepare("DELETE FROM local_tabular_reviews WHERE user_id=? AND project_id=?")
      .run(userId, projectId);
  }
  removeDocument(userId: string, documentId: string) {
    this.transaction(() => {
      this.db.prepare(`UPDATE local_tabular_reviews SET document_ids_json=(SELECT
        json_group_array(value) FROM json_each(document_ids_json) WHERE value<>?),updated_at=?
        WHERE user_id=? AND EXISTS(SELECT 1 FROM json_each(document_ids_json) WHERE value=?)`)
        .run(documentId, new Date().toISOString(), userId, documentId);
      this.db.prepare(`DELETE FROM local_tabular_cells WHERE document_id=? AND review_id IN
        (SELECT id FROM local_tabular_reviews WHERE user_id=?)`).run(documentId, userId);
    });
  }
}

let shared: LocalTabularStore | null = null;
export const localTabularStore = () => shared ??= new LocalTabularStore();
export const closeLocalTabularStore = () => { shared?.close(); shared = null; };

async function documents(scope: TabularScope, ids: string[], projectId: string | null) {
  const requested = unique(ids), owned = await listLocalDocumentsById(scope.userId, requested);
  const graph = legalKnowledgeGraphStore();
  if (projectId && !graph.getMatter(scope.userId, projectId))
    throw new TabularStoreError(404, "Project not found");
  const allowed = new Set(owned.filter(({ id }) => !projectId ||
    graph.hasMatterDocument(scope.userId, projectId, id)).map(({ id }) => id));
  if (allowed.size !== requested.length) throw new TabularStoreError(404, "Document not found");
  return requested;
}

export const localTabularData = {
  async page(scope, options) {
    const page = localTabularStore().page(scope.userId, options);
    return { ...page, items: page.items.map((item) => ({ ...item, project_name: item.project_id
      ? legalKnowledgeGraphStore().getMatter(scope.userId, String(item.project_id))?.name ?? null
      : null })) };
  },
  async create(scope, input) {
    return localTabularStore().create(scope.userId, { ...input,
      documentIds: await documents(scope, input.documentIds, input.projectId) });
  },
  async detail(scope, id) {
    const detail = localTabularStore().detail(scope.userId, id);
    if (!detail) return null;
    const rows = await listLocalDocumentsById(scope.userId, detail.review.document_ids);
    return { ...detail, documents: rows.map((document) => ({ ...document,
      project_id: detail.review.project_id, folder_id: null })) };
  },
  async people(scope, id) { return localTabularStore().detail(scope.userId, id)
    ? { owner: { user_id: scope.userId, email: null, display_name: null }, members: [] } : null; },
  async update(scope, id, expected, input) {
    const current = localTabularStore().detail(scope.userId, id)?.review;
    if (!current) return { status: "missing" } as const;
    if (input.sharedWith?.length) throw new TabularStoreError(400, "Sharing requires an account");
    const projectId = input.projectId === undefined ? current.project_id : input.projectId;
    const documentIds = input.documentIds === undefined && input.projectId === undefined
      ? undefined : await documents(scope, input.documentIds ?? current.document_ids, projectId ?? null);
    return localTabularStore().update(scope.userId, id, expected,
      { ...input, ...(documentIds ? { documentIds } : {}) });
  },
  async delete(scope, id, expected) { return localTabularStore().delete(scope.userId, id, expected); },
  async setCell(scope, input) { return localTabularStore().setCell(scope.userId, input); },
  async recordGeneration() {},
} satisfies TabularStore;

export function removeDocumentFromLocalTabularReviews(userId: string, documentId: string) {
  const temporary = !shared, store = shared ?? new LocalTabularStore();
  try { store.removeDocument(userId, documentId); } finally { if (temporary) store.close(); }
}
