import { cloudData, cloudScope, type CloudScope } from "./access";
import { recordAudit } from "./audit";
import { attachActiveVersionPaths } from "./documentVersions";
import {
  TabularStoreError,
  type TabularCell,
  type TabularReview,
  type TabularStore,
  type WriteResult,
} from "./tabularStore";

type Row = Record<string, any> & { id: string };
const fail = (status: number, message: string): never => {
  throw new TabularStoreError(status, message);
};
const run = async <T>(query: PromiseLike<{ data: T; error: any }>, operation: string) => {
  try { return await cloudData<T>(operation, query); } catch { return fail(500, operation); }
};
const review = (row: Row, isOwner = true): TabularReview => ({ ...row,
  id: String(row.id), user_id: String(row.user_id ?? ""),
  project_id: typeof row.project_id === "string" ? row.project_id : null,
  title: typeof row.title === "string" ? row.title : null,
  columns_config: Array.isArray(row.columns_config) ? row.columns_config : [],
  document_ids: Array.isArray(row.document_ids) ? row.document_ids : [],
  workflow_id: typeof row.workflow_id === "string" ? row.workflow_id : null,
  shared_with: Array.isArray(row.shared_with) ? row.shared_with : [],
  updated_at: String(row.updated_at ?? row.created_at ?? ""), is_owner: isOwner,
});
const cell = (row: Row): TabularCell => {
  let content = row.content ?? null;
  try { if (typeof content === "string") content = JSON.parse(content); } catch { content = null; }
  return { ...row, content } as TabularCell;
};
const versionAfter = (expected: string) => new Date(Math.max(
  Date.now(), (Date.parse(expected) || 0) + 1,
)).toISOString();

async function requireProject(scope: CloudScope, id: string | null) {
  if (id && !await scope.project(id)) fail(404, "Project not found");
}
async function documentIds(scope: CloudScope, ids: string[], projectId: string | null) {
  const unique = [...new Set(ids)], access = await scope.documents(unique);
  if (access.length !== unique.length || projectId &&
    access.some(({ row }) => row.project_id !== projectId)) fail(404, "Document not found");
  return unique;
}
async function currentCell(scope: CloudScope, reviewId: string,
  documentId: string, columnIndex: number) {
  if (!await scope.review(reviewId)) return null;
  const row = await run(scope.db.from("tabular_cells").select("*")
    .eq("review_id", reviewId).eq("document_id", documentId)
    .eq("column_index", columnIndex).maybeSingle(), "Failed to load review cell");
  return row ? cell(row as Row) : null;
}

export const cloudTabularData = {
  async page(identity, options) {
    const scope = cloudScope(identity);
    if (options.projectId) await requireProject(scope, options.projectId);
    const data = await run(scope.db.rpc("get_collection_page", {
      p_resource: "tabular", p_user_id: scope.userId,
      p_user_email: scope.userEmail || null,
      p_filter: options.projectId ?? (options.scope === "all" ? null : options.scope),
      p_q: options.q, p_after_created_at: options.after?.[0] ?? null,
      p_after_id: options.after?.[1] ?? null, p_limit: options.limit + 1,
    }), "Failed to load tabular reviews");
    const rows = (data ?? []) as { payload: Row; id: string; created_at: string }[];
    const items = rows.slice(0, options.limit).map(({ payload }) => payload), last = rows[options.limit - 1];
    return { items, nextAfter: rows.length > options.limit && last
      ? [last.created_at, last.id] as [string, string] : null };
  },

  async create(identity, input) {
    const scope = cloudScope(identity);
    await requireProject(scope, input.projectId);
    const ids = await documentIds(scope, input.documentIds, input.projectId);
    const row = await run(scope.db.from("tabular_reviews").insert({
      user_id: scope.userId, title: input.title ?? null, columns_config: input.columns,
      document_ids: ids, project_id: input.projectId, workflow_id: input.workflowId ?? null,
    }).select("*").single(), "Failed to create review");
    if (!row) fail(500, "Failed to create review");
    const cells = ids.flatMap((documentId) => input.columns.map(({ index }) => ({
      review_id: row.id, document_id: documentId, column_index: index, status: "pending",
    })));
    if (cells.length) await run(scope.db.from("tabular_cells").insert(cells),
      "Failed to create review cells");
    void recordAudit(scope.db, { userId: scope.userId, userEmail: scope.userEmail,
      action: "tabular.created", title: row.title ?? null, surface: "tabular",
      projectId: input.projectId, reviewId: row.id });
    return { status: "committed", value: review(row) } as const;
  },

  async detail(identity, id) {
    const scope = cloudScope(identity), access = await scope.review(id);
    if (!access) return null;
    const item = review(access.row, access.isOwner);
    const cells = await run(scope.db.from("tabular_cells").select("*").eq("review_id", id),
      "Failed to load review cells");
    const documents = item.document_ids.length ? await run(scope.db.from("documents")
      .select("*").in("id", item.document_ids), "Failed to load review documents") : [];
    await attachActiveVersionPaths(scope.db, documents ?? []);
    return { review: item, cells: (cells ?? []).map(cell), documents: (documents ?? []) as Row[] };
  },

  async people(identity, id) {
    const scope = cloudScope(identity), access = await scope.review(id);
    if (!access) return null;
    const { loadProfileUsersByEmail } = await import("./userLookup");
    const { userByEmail, userById } = await loadProfileUsersByEmail(scope.db);
    const item = review(access.row, access.isOwner), owner = userById.get(item.user_id);
    return { owner: { user_id: item.user_id, email: owner?.email ?? null,
      display_name: owner?.display_name ?? null }, members: item.shared_with.map((raw) => {
      const email = raw.toLowerCase();
      return { email, display_name: userByEmail.get(email)?.display_name ?? null };
    }) };
  },

  async update(identity, id, expected, input) {
    const scope = cloudScope(identity), access = await scope.review(id);
    if (!access) return { status: "missing" } as const;
    const current = review(access.row, access.isOwner);
    if (current.updated_at !== expected) return { status: "conflict", value: current } as const;
    if (!access.isOwner && input.columns !== undefined) fail(403,
      "Only the review owner can change columns");
    if (!access.isOwner && input.sharedWith !== undefined) fail(403,
      "Only the review owner can change sharing");
    if (!access.isOwner && input.projectId !== undefined) fail(403,
      "Only the review owner can move a review");
    const projectId = input.projectId === undefined ? current.project_id : input.projectId;
    await requireProject(scope, projectId);
    if (input.sharedWith) {
      const { findMissingUserEmails } = await import("./userLookup");
      const [missing] = await findMissingUserEmails(scope.db, input.sharedWith);
      if (missing) fail(400, `${missing} does not belong to a Beaver user.`);
    }
    const ids = input.documentIds === undefined && input.projectId === undefined
      ? current.document_ids : await documentIds(scope,
        input.documentIds ?? current.document_ids, projectId ?? null);
    const config = input.columns ?? current.columns_config;
    const changed = await run(scope.db.from("tabular_reviews").update({
      updated_at: versionAfter(expected),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
      ...(input.columns !== undefined ? { columns_config: config } : {}),
      ...(input.documentIds !== undefined || input.projectId !== undefined
        ? { document_ids: ids } : {}),
      ...(input.sharedWith !== undefined ? { shared_with: input.sharedWith } : {}),
    }).eq("id", id).eq("updated_at", expected).select("*").maybeSingle(),
    "Failed to update review");
    if (!changed) {
      const latest = await scope.review(id);
      return latest ? { status: "conflict", value: review(latest.row, latest.isOwner) }
        : { status: "missing" };
    }
    if (input.columns !== undefined || input.documentIds !== undefined ||
      input.projectId !== undefined) {
      const rows = (await run(scope.db.from("tabular_cells")
        .select("id,document_id,column_index").eq("review_id", id),
      "Failed to load review cells") ?? []) as Row[];
      const wanted = new Set(ids.flatMap((documentId) =>
        config.map(({ index }) => `${documentId}:${index}`)));
      const remove = rows.filter((row) => !wanted.has(`${row.document_id}:${row.column_index}`));
      if (remove.length) await run(scope.db.from("tabular_cells").delete()
        .in("id", remove.map(({ id }) => id)), "Failed to remove review cells");
      const present = new Set(rows.map((row) => `${row.document_id}:${row.column_index}`));
      const insert = ids.flatMap((documentId) => config.flatMap(({ index }) =>
        present.has(`${documentId}:${index}`) ? []
          : [{ review_id: id, document_id: documentId, column_index: index, status: "pending" }]));
      if (insert.length) await run(scope.db.from("tabular_cells").insert(insert),
        "Failed to create review cells");
    }
    return { status: "committed", value: review({ ...changed, document_ids: ids }, access.isOwner) };
  },

  async delete(identity, id, expected): Promise<WriteResult<null>> {
    const scope = cloudScope(identity), access = await scope.review(id, true);
    if (!access) return { status: "missing" };
    if (review(access.row).updated_at !== expected) return { status: "conflict", value: null };
    const row = await run(scope.db.from("tabular_reviews").delete().eq("id", id)
      .eq("user_id", scope.userId).eq("updated_at", expected).select("id").maybeSingle(),
    "Failed to delete review");
    return row ? { status: "committed", value: null }
      : await scope.review(id, true) ? { status: "conflict", value: null } : { status: "missing" };
  },

  async setCell(identity, input) {
    const scope = cloudScope(identity), access = await scope.review(input.reviewId);
    if (!access || !review(access.row).document_ids.includes(input.documentId))
      return { status: "missing" } as const;
    const previous = input.expected.content ? JSON.stringify(input.expected.content) : null;
    let query = scope.db.from("tabular_cells").update({
      content: input.content ? JSON.stringify(input.content) : null, status: input.status,
    }).eq("review_id", input.reviewId).eq("document_id", input.documentId)
      .eq("column_index", input.columnIndex).eq("status", input.expected.status);
    query = previous === null ? query.is("content", null) : query.eq("content", previous);
    const row = await run(query.select("*").maybeSingle(), "Failed to update review cell");
    if (row) return { status: "committed", value: cell(row as Row) } as const;
    const latest = await currentCell(scope, input.reviewId, input.documentId, input.columnIndex);
    return latest ? { status: "conflict", value: latest } as const : { status: "missing" } as const;
  },

  async recordGeneration(identity, input) {
    const scope = cloudScope(identity);
    await recordAudit(scope.db, { userId: scope.userId, userEmail: scope.userEmail,
      action: "tabular.generated", ...(input.failed ? { status: "failed" } : {}),
      title: input.title, surface: "tabular", projectId: input.projectId,
      reviewId: input.reviewId, model: input.model });
  },
} satisfies TabularStore;
