import { cloudData, cloudScope, type CloudScope } from "./access";
import { recordAudit } from "./audit";
import {
  type TabularCell,
  type TabularReview,
  type TabularRepository,
  type WriteResult,
} from "./tabularStore";
import { ApplicationError } from "./applicationError";

type Row = Record<string, any> & { id: string };
const fail = (status: number, message: string): never => {
  throw new ApplicationError(status, message);
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

const writeResult = (raw: unknown): WriteResult<TabularReview> => {
  const result = raw && typeof raw === "object" ? raw as Row : {} as Row;
  const value = result.value && typeof result.value === "object"
    ? review(result.value as Row, Boolean((result.value as Row).is_owner)) : null;
  if (result.status === "committed" && value) return { status: "committed", value };
  if (result.status === "conflict" && value) return { status: "conflict", value };
  return { status: "missing" };
};

async function currentCell(scope: CloudScope, reviewId: string,
  documentId: string, columnIndex: number) {
  if (!await scope.review(reviewId)) return null;
  const row = await run(scope.db.from("tabular_cells").select("*")
    .eq("review_id", reviewId).eq("document_id", documentId)
    .eq("column_index", columnIndex).maybeSingle(), "Failed to load review cell");
  return row ? cell(row as Row) : null;
}

export const postgresTabularRepository = {
  async page(identity, options) {
    const scope = cloudScope(identity);
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
    const result = writeResult(await run(scope.db.rpc("write_tabular_review", {
      p_actor_user_id: scope.userId, p_actor_user_email: scope.userEmail || null,
      p_review_id: null, p_expected_version: null, p_input: { title: input.title ?? null,
        columns_config: input.columns, document_ids: input.documentIds,
        project_id: input.projectId, workflow_id: input.workflowId ?? null, shared_with: [] },
    }), "Failed to create review"));
    if (result.status !== "committed") return result;
    const row = result.value;
    void recordAudit(scope.db, { userId: scope.userId, userEmail: scope.userEmail,
      action: "tabular.created", title: row.title ?? null, surface: "tabular",
      projectId: input.projectId, reviewId: row.id });
    return result;
  },

  async detail(identity, id) {
    const scope = cloudScope(identity), access = await scope.review(id);
    if (!access) return null;
    const item = review(access.row, access.isOwner);
    const cells = await run(scope.db.from("tabular_cells").select("*").eq("review_id", id),
      "Failed to load review cells");
    return { review: item, cells: (cells ?? []).map(cell) };
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

  async missingRecipient(identity, emails) {
    const { findMissingUserEmails } = await import("./userLookup");
    return (await findMissingUserEmails(cloudScope(identity).db, emails))[0] ?? null;
  },

  async update(identity, id, expected, input) {
    const scope = cloudScope(identity), access = await scope.review(id);
    if (!access) return { status: "missing" } as const;
    const current = review(access.row, access.isOwner);
    if (current.updated_at !== expected) return { status: "conflict", value: current } as const;
    const ids = input.documentIds ?? current.document_ids;
    const config = input.columns ?? current.columns_config;
    if (input.columns !== undefined || input.documentIds !== undefined) return writeResult(
      await run(scope.db.rpc("write_tabular_review", {
        p_actor_user_id: scope.userId, p_actor_user_email: scope.userEmail || null,
        p_review_id: id, p_expected_version: expected,
        p_input: { title: input.title !== undefined ? input.title : current.title,
          project_id: input.projectId !== undefined ? input.projectId : current.project_id,
          columns_config: config, document_ids: ids, workflow_id: current.workflow_id,
          shared_with: input.sharedWith ?? current.shared_with },
      }), "Failed to update review"));
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

  async deleteAll(identity) {
    const scope = cloudScope(identity);
    return (await run(scope.db.from("tabular_reviews").delete().eq("user_id", scope.userId)
      .select("id"), "Failed to delete reviews") ?? []).length;
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
} satisfies TabularRepository;
