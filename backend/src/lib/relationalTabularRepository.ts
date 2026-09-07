import { randomUUID } from "node:crypto";
import type { ApplicationScope } from "./applicationError";
import { tabularSubjectId, type TabularCell, type TabularColumn, type TabularRepository,
  type TabularReview, type TabularSelection, type TabularOperation, type TabularSeedCell, type ReviewInput, type WriteResult } from "./tabularStore";
import { ApplicationError } from "./applicationError";
import { applyTableChanges, resultState, tableChanges, type TableState } from "./tabular/history";
import { researchChangeCounts, researchChangeSummary, sameResearchValue,
  type ResearchChange, type ResearchChangeField } from "./researchHistory";
import { parseResourceReference } from "./resourceReferences";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { changes, documentAccess, missingProfileEmail, now, one, projectAccess,
  replaceMembers, reviewAccess, rows, type Row } from "./relationalRepositorySupport";
import { searchFilter } from "./searchQuery";

const tabularReview = (scope: ApplicationScope, row: Row): TabularReview => {
  const documents = decode<string[]>(row.document_ids, []);
  return { ...row, id: String(row.id), user_id: String(row.user_id),
    project_id: typeof row.project_id === "string" ? row.project_id : null,
    title: typeof row.title === "string" ? row.title : null,
    columns_config: decode<TabularColumn[]>(row.columns_config, []), document_ids: documents,
    scope_config: decode<TabularSelection>(row.scope_config, { subjects: [] }),
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
  db?: RelationalDatabase, lock = false) {
  const row = await one(sql`SELECT r.* FROM tabular_reviews r WHERE r.id=${id}
    AND ${reviewAccess(scope, owner)} ${lock && db?.engine === "postgres" ? sql.raw("FOR UPDATE") : sql.raw("")}`, db);
  return row ? tabularReview(scope, row) : null;
}
async function findCell(scope: ApplicationScope, reviewId: string, documentId: string,
  columnIndex: number, db?: RelationalDatabase) {
  const row = await one(sql`SELECT c.* FROM tabular_cells c JOIN tabular_reviews r
    ON r.id=c.review_id WHERE c.review_id=${reviewId} AND c.document_id=${documentId}
      AND c.column_index=${columnIndex} AND ${reviewAccess(scope)}`, db);
  return row ? tabularCell(row) : null;
}
/** Seed canonical cells in the same transaction as the review/configuration. */
function applySeeds(cells: TabularCell[], seeds: TabularSeedCell[] = []) {
  const known = new Set(cells.map((cell) => `${cell.document_id}:${cell.column_index}`));
  const selected = new Map<string, TabularSeedCell>();
  for (const seed of seeds) {
    const key = `${seed.document_id}:${seed.column_index}`;
    if (!known.has(key) || selected.has(key)) throw new ApplicationError(400, "Invalid or duplicate seeded cell");
    selected.set(key, seed);
  }
  return cells.map((cell) => ({ ...cell, ...selected.get(`${cell.document_id}:${cell.column_index}`) }));
}

async function lockDocuments(db: RelationalDatabase, scope: ApplicationScope,
  documentIds: string[], projectId: string | null, selection?: TabularSelection) {
  const subjects = new Map(selection?.subjects.map((subject) => [tabularSubjectId(subject), subject]));
  const ids = [...new Set(documentIds.flatMap((id) => {
    const reference = subjects.get(id)?.reference;
    return reference ? reference.kind === "document" ? [reference.id] : []
      : parseResourceReference(id)?.kind === "source" ? [] : [id];
  }))];
  if (!ids.length) return true;
  const found = await rows<{ id: string }>(sql`SELECT d.id FROM documents d
    WHERE d.id IN(${sql.join(ids)}) AND ${documentAccess(scope)}
      ${projectId ? sql`AND d.project_id=${projectId}` : sql.raw("")}
    ${db.engine === "postgres" ? sql.raw("FOR SHARE OF d") : sql.raw("")}`, db);
  return found.length === ids.length;
}
const nextVersion = (expected: string) => new Date(Math.max(
  Date.now(), (Date.parse(expected) || 0) + 1,
)).toISOString();
const reviewCells = async (db: RelationalDatabase, id: string) =>
  (await rows(sql`SELECT * FROM tabular_cells WHERE review_id=${id} ORDER BY document_id,column_index,id`, db)).map(tabularCell);

function updatedState(current: TableState, input: ReviewInput): TableState {
  const review = { ...current.review };
  for (const [key, field] of Object.entries({ title: "title", projectId: "project_id", columns: "columns_config",
    documentIds: "document_ids", scopeConfig: "scope_config", workflowId: "workflow_id", sharedWith: "shared_with" }))
    if (input[key as keyof ReviewInput] !== undefined) review[field] = input[key as keyof ReviewInput];
  const priorSubjects = new Map(current.review.scope_config?.subjects.map((subject) => [tabularSubjectId(subject), subject]));
  const readInput = (subject: TabularSelection["subjects"][number] | undefined) => subject && ({
    resource: subject.resource, evidence: subject.evidence, sourceSha256: subject.sourceSha256,
    sourceSha256s: subject.sourceSha256s });
  const changedRows = new Set(review.scope_config?.subjects.filter((subject) => !sameResearchValue(readInput(subject),
    readInput(priorSubjects.get(tabularSubjectId(subject))))).map(tabularSubjectId));
  const question = (column: TabularColumn | undefined) => column && ({ prompt: column.prompt,
    format: column.format ?? "text", tags: column.tags ?? [] });
  const changedColumns = new Set(review.columns_config.filter((column) => !sameResearchValue(question(column),
    question(current.review.columns_config.find(({ index }) => index === column.index)))).map(({ index }) => index));
  const existing = new Map(current.cells.map((cell) => [`${cell.document_id}:${cell.column_index}`, cell]));
  const cells = review.document_ids.flatMap((documentId) => review.columns_config.map((column): TabularCell => {
    const previous = existing.get(`${documentId}:${column.index}`);
    return previous ? { ...previous, ...(changedRows.has(documentId) || changedColumns.has(column.index)
      ? { status: "pending", content: null } : {}) } : { id: randomUUID(), review_id: review.id,
      document_id: documentId, column_index: column.index, status: "pending", content: null };
  }));
  return { review, cells: applySeeds(cells, input.seedCells) };
}

async function persistState(db: RelationalDatabase, before: TableState, next: TableState) {
  const r = next.review, updated = nextVersion(before.review.updated_at);
  if (!await changes(sql`UPDATE tabular_reviews SET title=${r.title},project_id=${r.project_id},
    columns_config=${encode(r.columns_config)},document_ids=${encode(r.document_ids)},
    scope_config=${encode(r.scope_config ?? { subjects: [] })},workflow_id=${r.workflow_id},
    shared_with=${encode(r.shared_with)},updated_at=${updated} WHERE id=${r.id}
    AND updated_at=${before.review.updated_at}`, db)) throw new ApplicationError(409, "Table changed; reload it");
  if (!sameResearchValue(before.review.shared_with, r.shared_with))
    await replaceMembers(db, "tabular_review_members", r.id, r.shared_with);
  const prior = new Map(before.cells.map((cell) => [cell.id, cell])), wanted = new Set(next.cells.map(({ id }) => id));
  for (const cell of before.cells) if (!wanted.has(cell.id))
    await changes(sql`DELETE FROM tabular_cells WHERE id=${cell.id} AND review_id=${r.id}`, db);
  for (const cell of next.cells) if (!prior.has(cell.id) || !sameResearchValue(resultState(prior.get(cell.id)!), resultState(cell))) {
    await changes(sql`INSERT INTO tabular_cells(id,review_id,document_id,column_index,content,status,created_at,updated_at)
      VALUES(${cell.id},${r.id},${cell.document_id},${cell.column_index},${cell.content ? encode(cell.content) : null},
        ${cell.status},${String(cell.created_at ?? updated)},${updated}) ON CONFLICT(id) DO UPDATE SET
        document_id=excluded.document_id,column_index=excluded.column_index,content=excluded.content,
        status=excluded.status,updated_at=excluded.updated_at`, db);
  }
  return { review: { ...r, updated_at: updated }, cells: await reviewCells(db, r.id) };
}

async function recordChange(db: RelationalDatabase, scope: ApplicationScope, review: TabularReview,
  fields: ResearchChangeField[], operation: TabularOperation = { executor: "human" }, undoOf?: string) {
  if (!fields.length) return null;
  const prior = operation.changeKey ? await one(sql`SELECT record FROM tabular_changes
    WHERE review_id=${review.id} AND change_key=${operation.changeKey}`, db) : null;
  const previous = prior ? decode<ResearchChange>(prior.record, null!) : null;
  const merged = new Map(previous?.changes.map((field) => [`${field.target}:${field.id}:${field.field}`, field]));
  for (const field of fields) {
    const key = `${field.target}:${field.id}:${field.field}`, earlier = merged.get(key);
    if (earlier && !sameResearchValue(earlier.after, field.before))
      throw new ApplicationError(409, "An extraction result changed while it was being updated");
    const next = { ...field, before: earlier ? earlier.before : field.before };
    if (sameResearchValue(next.before, next.after)) merged.delete(key); else merged.set(key, next);
  }
  const values = [...merged.values()];
  if (!values.length) { if (previous) await changes(sql`DELETE FROM tabular_changes WHERE id=${previous.id}`, db); return null; }
  const record: ResearchChange = { id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now(),
    executor: operation.executor, userId: scope.userId, ...(operation.model ? { model: operation.model } : {}),
    title: (previous?.title ?? operation.title ?? "Update table").slice(0, 200),
    status: operation.propose ? "pending" : "applied", ...(undoOf ? { undoOf } : {}),
    changes: values, counts: researchChangeCounts(values) };
  await changes(sql`INSERT INTO tabular_changes(id,review_id,change_key,record,status,created_at)
    VALUES(${record.id},${review.id},${operation.changeKey ?? null},${encode(record)},${record.status},${record.createdAt})
    ON CONFLICT(id) DO UPDATE SET record=excluded.record,status=excluded.status`, db);
  return record;
}

export const tabularRepository: TabularRepository = {
  async page(scope, options) {
    const project = options.projectId ? sql`AND r.project_id=${options.projectId}`
      : options.scope === "in-project" ? sql`AND r.project_id IS NOT NULL`
        : options.scope === "standalone" ? sql`AND r.project_id IS NULL` : sql.raw("");
    const result = await rows(sql`SELECT r.* FROM tabular_reviews r
      WHERE ${reviewAccess(scope)} ${project}
      ${options.q ? sql`AND ${searchFilter(sql`lower(COALESCE(r.title,''))`, options.q)}`
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
      if (!await lockDocuments(tx, scope, input.documentIds, input.projectId, input.scopeConfig))
        return { status: "missing" } as const;
      const shared = input.sharedWith ?? [];
      await changes(sql`INSERT INTO tabular_reviews(id,user_id,project_id,title,columns_config,
        document_ids,scope_config,workflow_id,shared_with,created_at,updated_at) VALUES(${id},${scope.userId},
        ${input.projectId},${input.title ?? null},${encode(input.columns)},
        ${encode(input.documentIds)},${encode(input.scopeConfig ?? { subjects: [] })},${input.workflowId ?? null},${encode(shared)},
        ${created},${created})`, tx);
      await replaceMembers(tx, "tabular_review_members", id, shared);
      const review = (await findReview(scope, id, true, tx))!, before = { review, cells: [] };
      const saved = await persistState(tx, before, updatedState(before, input));
      await recordChange(tx, scope, saved.review, tableChanges({ review: { ...review, columns_config: [],
        document_ids: [], scope_config: { subjects: [] } }, cells: [] }, saved),
      { executor: "human", title: "Configure table", ...input.operation });
      return { status: "committed", value: saved.review } as const;
    });
  },
  async detail(scope, id) {
    const review = await findReview(scope, id);
    if (!review) return null;
    const cells = await reviewCells(await relationalDatabase(), id);
    const [proposals, count] = await Promise.all([
      rows(sql`SELECT record FROM tabular_changes WHERE review_id=${id} AND status='pending' ORDER BY created_at,id`),
      one(sql`SELECT COUNT(*) total FROM tabular_changes WHERE review_id=${id}`),
    ]);
    return { review: { ...review, proposals: proposals.map((row) => researchChangeSummary(
      decode<ResearchChange>(row.record, null!))), history_count: Number(count?.total ?? 0) }, cells };
  },
  async people(scope, id) {
    const review = await findReview(scope, id);
    if (!review) return null;
    const db = await relationalDatabase(), shared = review.shared_with;
    if (db.engine === "sqlite") return { owner: { user_id: review.user_id,
      email: null, display_name: null }, members: shared.map((value) => ({
        email: value, display_name: null })) };
    const profiles = await rows<{ user_id: string; email: string | null;
      display_name: string | null }>(sql`SELECT p.user_id,p.email,u.display_name
      FROM user_profiles p LEFT JOIN user_preferences u ON u.user_id=p.user_id
      WHERE p.user_id=${review.user_id} OR lower(p.email) IN(${shared.length
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
      const current = await findReview(scope, id, false, tx, true);
      if (!current) return { status: "missing" };
      if (current.updated_at !== expected) return { status: "conflict", value: current };
      const before = { review: current, cells: await reviewCells(tx, id) }, next = updatedState(before, input);
      if (!await lockDocuments(tx, scope, next.review.document_ids, next.review.project_id, next.review.scope_config))
        return { status: "missing" };
      const saved = input.operation?.propose ? before : await persistState(tx, before, next);
      const recorded = await recordChange(tx, scope, saved.review, tableChanges(before, next), input.operation);
      return { status: "committed", value: { ...saved.review,
        ...(recorded ? { change: researchChangeSummary(recorded) } : {}) } };
    });
  },
  async delete(scope, id, expected): Promise<WriteResult<null>> {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await findReview(scope, id, true, tx, true);
      if (!current) return { status: "missing" };
      if (current.updated_at !== expected) return { status: "conflict", value: null };
      await changes(sql`UPDATE chats SET tabular_review_id=NULL,project_id=COALESCE(project_id,${current.project_id})
        WHERE tabular_review_id=${id}`, tx);
      await changes(sql`DELETE FROM tabular_reviews WHERE id=${id} AND user_id=${scope.userId}`, tx);
      return { status: "committed", value: null };
    });
  },
  async deleteAll(scope) {
    return (await relationalDatabase()).transaction(async (tx) => {
      await changes(sql`UPDATE chats SET project_id=COALESCE(project_id,(SELECT r.project_id FROM tabular_reviews r
        WHERE r.id=chats.tabular_review_id)),tabular_review_id=NULL
        WHERE tabular_review_id IN (SELECT id FROM tabular_reviews WHERE user_id=${scope.userId})`, tx);
      return changes(sql`DELETE FROM tabular_reviews WHERE user_id=${scope.userId}`, tx);
    });
  },
  async history(scope, reviewId, input) {
    const db = await relationalDatabase();
    if (!await findReview(scope, reviewId, false, db)) return null;
    const [found, count] = await Promise.all([
      rows(sql`SELECT record FROM tabular_changes WHERE review_id=${reviewId}
        ORDER BY created_at DESC,id DESC LIMIT ${input.limit} OFFSET ${input.offset}`, db),
      one(sql`SELECT COUNT(*) total FROM tabular_changes WHERE review_id=${reviewId}`, db),
    ]);
    const total = Number(count?.total ?? 0);
    return { items: found.map((row) => decode<ResearchChange>(row.record, null!)), total,
      next_offset: input.offset + input.limit < total ? input.offset + input.limit : null };
  },
  async change(scope, reviewId, changeId, action, expectedVersion, operation = { executor: "human" }) {
    const db = await relationalDatabase();
    return db.transaction(async (tx): Promise<WriteResult<TabularReview>> => {
      const review = await findReview(scope, reviewId, false, tx, true);
      if (!review) return { status: "missing" };
      if (review.updated_at !== expectedVersion) return { status: "conflict", value: review };
      const row = await one(sql`SELECT record FROM tabular_changes WHERE id=${changeId} AND review_id=${reviewId}`, tx);
      if (!row) return { status: "missing" };
      const record = decode<ResearchChange>(row.record, null!);
      if (action === "undo" ? record.status !== "applied" : record.status !== "pending")
        throw new ApplicationError(409, "This table change is no longer available for that action");
      if (!review.is_owner && record.changes.some((field) => field.target === "table" &&
          (field.field.startsWith("columns_config.") ||
          ["columns_order", "shared_with", "project_id", "scope_config"].includes(field.field))))
        throw new ApplicationError(403, "Only the table owner can change this configuration");
      if (action === "reject") {
        await changes(sql`UPDATE tabular_changes SET record=${encode({ ...record, status: "rejected",
          resolvedBy: scope.userId, resolvedAt: now() })},status='rejected' WHERE id=${changeId}`, tx);
        return { status: "committed", value: review };
      }
      const before = { review, cells: await reviewCells(tx, reviewId) },
        next = applyTableChanges(before, record.changes, action === "undo");
      if (next.review.project_id && !await one(sql`SELECT 1 ok FROM projects p
          WHERE p.id=${next.review.project_id} AND ${projectAccess(scope)}`, tx) ||
          !await lockDocuments(tx, scope, next.review.document_ids, next.review.project_id, next.review.scope_config))
        return { status: "missing" };
      const saved = await persistState(tx, before, next), fields = tableChanges(before, saved);
      if (action === "undo") await recordChange(tx, scope, saved.review, fields,
        { ...operation, title: `Undo ${record.title}`, propose: false, changeKey: undefined }, record.id);
      else await changes(sql`UPDATE tabular_changes SET record=${encode({ ...record,
        status: "applied", resolvedBy: scope.userId, resolvedAt: now(), changes: fields,
        counts: researchChangeCounts(fields) })},status='applied' WHERE id=${changeId}`, tx);
      return { status: "committed", value: saved.review };
    });
  },
  async setCell(scope, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx): Promise<WriteResult<TabularCell>> => {
      const review = await findReview(scope, input.reviewId, false, tx, true),
        before = review && await findCell(scope, input.reviewId, input.documentId, input.columnIndex, tx);
      if (!review || !before) return { status: "missing" };
      const expected = input.expected.content === null
        ? sql`content IS NULL` : sql`content=${encode(input.expected.content)}`;
      const changed = await changes(sql`UPDATE tabular_cells SET content=${input.content
        ? encode(input.content) : null},status=${input.status},updated_at=${nextVersion(input.expected.updated_at ?? "")}
        WHERE review_id=${input.reviewId} AND document_id=${input.documentId}
          AND column_index=${input.columnIndex} AND status=${input.expected.status} AND ${expected}
          ${input.expected.updated_at ? sql`AND updated_at=${input.expected.updated_at}` : sql.raw("")}
          ${input.expectedReviewVersion ? sql`AND EXISTS(SELECT 1 FROM tabular_reviews r
            WHERE r.id=${input.reviewId} AND r.updated_at=${input.expectedReviewVersion})` : sql.raw("")}`, tx);
      const value = await findCell(scope, input.reviewId, input.documentId, input.columnIndex, tx);
      if (changed && value) await recordChange(tx, scope, review,
        tableChanges({ review, cells: [before] }, { review, cells: [value] }), input.operation);
      return changed && value ? { status: "committed", value }
        : value ? { status: "conflict", value } : { status: "missing" };
    });
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
