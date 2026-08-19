import crypto from "node:crypto";
import { sqliteDatabase, sqliteTransaction } from "./sqliteDatabase";
import {
  type ReviewInput,
  type TabularCell,
  type TabularColumn,
  type TabularReview,
  type TabularRepository,
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
const parse = <T>(raw: string | null, fallback: T): T => {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
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

class SqliteTabularRepository implements TabularRepository {
  private get db() { return sqliteDatabase(); }
  private transaction<T>(run: () => T & (T extends PromiseLike<unknown> ? never : unknown)) {
    return sqliteTransaction(() => run());
  }
  private get(userId: string, id: string) {
    const row = this.db.prepare(`SELECT ${REVIEW_COLUMNS} FROM tabular_reviews
      WHERE id=? AND user_id=?`).get(id, userId) as ReviewRow | undefined;
    return row ? review(row) : null;
  }
  private oneCell(userId: string, reviewId: string, documentId: string, index: number) {
    const row = this.db.prepare(`SELECT c.* FROM tabular_cells c
      JOIN tabular_reviews r ON r.id=c.review_id AND r.user_id=?
      WHERE c.review_id=? AND c.document_id=? AND c.column_index=?`)
      .get(userId, reviewId, documentId, index) as CellRow | undefined;
    return row ? cell(row) : null;
  }
  private syncCells(reviewId: string, documentIds: string[], config: TabularColumn[]) {
    const wanted = new Set(documentIds.flatMap((id) => config.map((col) => `${id}:${col.index}`)));
    const rows = this.db.prepare(`SELECT id,document_id,column_index FROM tabular_cells
      WHERE review_id=?`).all(reviewId) as { id: string; document_id: string; column_index: number }[];
    const present = new Set(rows.map((row) => `${row.document_id}:${row.column_index}`));
    const remove = this.db.prepare("DELETE FROM tabular_cells WHERE id=?");
    rows.filter((row) => !wanted.has(`${row.document_id}:${row.column_index}`))
      .forEach((row) => remove.run(row.id));
    const insert = this.db.prepare(`INSERT INTO tabular_cells
      (id,review_id,document_id,column_index,content_json,status,created_at,updated_at)
      VALUES(?,?,?,?,NULL,'pending',?,?)`), now = new Date().toISOString();
    for (const documentId of documentIds) for (const column of config) {
      if (!present.has(`${documentId}:${column.index}`))
        insert.run(crypto.randomUUID(), reviewId, documentId, column.index, now, now);
    }
  }

  async page(scope: Parameters<TabularRepository["page"]>[0],
    options: Parameters<TabularRepository["page"]>[1]) {
    const { userId } = scope;
    const where = ["user_id=?"], params: (string | number)[] = [userId];
    if (options.projectId) { where.push("project_id=?"); params.push(options.projectId); }
    else if (options.scope !== "all") where.push(options.scope === "in-project"
      ? "project_id IS NOT NULL" : "project_id IS NULL");
    if (options.q) { where.push("instr(lower(coalesce(title,'')),?)>0"); params.push(options.q); }
    if (options.after) { where.push("(created_at<? OR (created_at=? AND id<?))");
      params.push(options.after[0], options.after[0], options.after[1]); }
    const rows = this.db.prepare(`SELECT ${REVIEW_COLUMNS} FROM tabular_reviews
      WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...params, options.limit + 1) as ReviewRow[];
    const page = rows.slice(0, options.limit).map(review), last = page.at(-1);
    return { items: page.map((item) => ({ ...item, column_count: item.columns_config.length })),
      nextAfter: rows.length > options.limit && last
        ? [String(last.created_at), last.id] as [string, string] : null };
  }

  async detail(scope: Parameters<TabularRepository["detail"]>[0], reviewId: string) {
    const { userId } = scope;
    const item = this.get(userId, reviewId);
    if (!item) return null;
    const cells = (this.db.prepare(`SELECT * FROM tabular_cells WHERE review_id=?
      ORDER BY document_id,column_index,id`).all(reviewId) as CellRow[]).map(cell);
    return { review: item, cells };
  }

  async create(scope: Parameters<TabularRepository["create"]>[0], input: ReviewInput & { projectId: string | null;
    columns: TabularColumn[]; documentIds: string[] }) {
    const { userId } = scope;
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const config = input.columns, documentIds = input.documentIds;
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO tabular_reviews
        (id,user_id,project_id,title,columns_json,document_ids_json,workflow_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, userId, text(input.projectId), text(input.title, 300),
        JSON.stringify(config), JSON.stringify(documentIds), text(input.workflowId), now, now);
      this.syncCells(id, documentIds, config);
      return { status: "committed", value: this.get(userId, id)! } as const;
    });
  }

  async update(scope: Parameters<TabularRepository["update"]>[0], id: string,
    expected: string, input: ReviewInput) {
    const { userId } = scope;
    const current = this.get(userId, id);
    if (!current) return { status: "missing" } as const;
    const next = { title: input.title === undefined ? current.title : text(input.title, 300),
      project: input.projectId === undefined ? current.project_id : text(input.projectId),
      columns: input.columns === undefined ? current.columns_config : input.columns,
      documents: input.documentIds === undefined ? current.document_ids : input.documentIds };
    return this.transaction<WriteResult<TabularReview>>(() => {
      const changed = this.db.prepare(`UPDATE tabular_reviews SET title=?,project_id=?,
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

  async delete(scope: Parameters<TabularRepository["delete"]>[0], id: string,
    expected: string): Promise<WriteResult<null>> {
    const { userId } = scope;
    const changed = this.db.prepare(`DELETE FROM tabular_reviews
      WHERE id=? AND user_id=? AND updated_at=?`).run(id, userId, expected).changes;
    if (changed) return { status: "committed", value: null };
    return this.get(userId, id) ? { status: "conflict", value: null } : { status: "missing" };
  }

  async setCell(scope: Parameters<TabularRepository["setCell"]>[0],
    input: Parameters<TabularRepository["setCell"]>[1]) {
    const { userId } = scope;
    const previous = input.expected.content ? JSON.stringify(input.expected.content) : null;
    const changed = this.db.prepare(`UPDATE tabular_cells SET content_json=?,status=?,updated_at=?
      WHERE review_id=? AND document_id=? AND column_index=? AND status=? AND content_json IS ?
      AND review_id IN(SELECT id FROM tabular_reviews WHERE user_id=?)`)
      .run(input.content ? JSON.stringify(input.content) : null, input.status, new Date().toISOString(),
        input.reviewId, input.documentId, input.columnIndex, input.expected.status, previous, userId).changes;
    const value = this.oneCell(userId, input.reviewId, input.documentId, input.columnIndex);
    return changed && value ? { status: "committed", value } as const
      : value ? { status: "conflict", value } as const : { status: "missing" } as const;
  }

  async people(scope: Parameters<TabularRepository["people"]>[0], id: string) {
    return await this.detail(scope, id)
      ? { owner: { user_id: scope.userId, email: null, display_name: null }, members: [] }
      : null;
  }

  async missingRecipient(_scope: Parameters<TabularRepository["missingRecipient"]>[0],
    emails: string[]) { return emails[0] ?? null; }

  async deleteAll(scope: Parameters<TabularRepository["deleteAll"]>[0]) {
    return Number(this.db.prepare("DELETE FROM tabular_reviews WHERE user_id=?")
      .run(scope.userId).changes);
  }

  async recordGeneration() {}
}

export const sqliteTabularRepository: TabularRepository = new SqliteTabularRepository();
