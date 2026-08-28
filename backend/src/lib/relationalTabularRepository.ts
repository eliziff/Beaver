import { randomUUID } from "node:crypto";
import type { ApplicationScope } from "./applicationError";
import type { TabularCell, TabularColumn, TabularRepository, TabularReview, WriteResult } from "./tabularStore";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { changes, missingProfileEmail, now, one, projectAccess, replaceMembers, reviewAccess, rows, type Row } from "./relationalRepositorySupport";

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
      if (input.projectId && !await one(sql`SELECT 1 ok FROM projects p
        WHERE p.id=${input.projectId} AND ${projectAccess(scope)}`, tx))
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
    const { recordAudit } = await import("./audit");
    await recordAudit(db, { userId: scope.userId,
      userEmail: scope.userEmail, action: "tabular.generated",
      ...(input.failed ? { status: "failed" as const } : {}), title: input.title,
      surface: "tabular", projectId: input.projectId, reviewId: input.reviewId,
      model: input.model });
  },
};
