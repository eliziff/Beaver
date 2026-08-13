import { checkProjectAccess, ensureReviewAccess, filterAccessibleDocumentIds } from "./access";
import { recordAudit } from "./audit";
import { attachActiveVersionPaths } from "./documentVersions";
import { createServerSupabase } from "./supabase";
import {
  TabularStoreError,
  type TabularCell,
  type TabularReview,
  type TabularScope,
  type TabularStore,
} from "./tabularStore";

type Db = ReturnType<typeof createServerSupabase>;
type Row = Record<string, any> & { id: string };

const fail = (status: number, message: string): never => {
  throw new TabularStoreError(status, message);
};

const databaseError = (error: { message?: string } | null, fallback: string) => {
  if (error) fail(500, error.message ?? fallback);
};

function review(row: Row, isOwner = true): TabularReview {
  return {
    ...row,
    id: String(row.id),
    user_id: String(row.user_id ?? ""),
    project_id: typeof row.project_id === "string" ? row.project_id : null,
    title: typeof row.title === "string" ? row.title : null,
    columns_config: Array.isArray(row.columns_config) ? row.columns_config : [],
    document_ids: Array.isArray(row.document_ids) ? row.document_ids : [],
    workflow_id: typeof row.workflow_id === "string" ? row.workflow_id : null,
    shared_with: Array.isArray(row.shared_with) ? row.shared_with : [],
    is_owner: isOwner,
  };
}

function cell(row: Row): TabularCell {
  const content = typeof row.content === "string"
    ? JSON.parse(row.content)
    : row.content ?? null;
  return { ...row, content } as TabularCell;
}

async function accessibleReview(db: Db, scope: TabularScope, reviewId: string) {
  const { data, error } = await db.from("tabular_reviews")
    .select("*").eq("id", reviewId).single();
  if (error || !data) return null;
  const access = await ensureReviewAccess(data, scope.userId, scope.userEmail, db);
  return access.ok ? { row: data as Row, isOwner: access.isOwner } : null;
}

async function accessibleDocuments(db: Db, scope: TabularScope, ids: string[]) {
  const allowed = new Set(await filterAccessibleDocumentIds(
    ids, scope.userId, scope.userEmail, db,
  ));
  return [...new Set(ids)].filter((id) => allowed.has(id));
}

export const cloudTabularData = {
  async page(scope, options) {
    const db = createServerSupabase();
    const { data, error } = await db.rpc("get_collection_page", {
      p_resource: "tabular",
      p_user_id: scope.userId,
      p_user_email: scope.userEmail ?? null,
      p_filter: options.projectId ??
        (options.scope === "all" ? null : options.scope),
      p_q: options.q,
      p_after_created_at: options.after?.[0] ?? null,
      p_after_id: options.after?.[1] ?? null,
      p_limit: options.limit + 1,
    });
    databaseError(error, "Failed to load tabular reviews");
    const rows = (data ?? []) as { payload: Row; id: string; created_at: string }[];
    const items = rows.slice(0, options.limit).map(({ payload }) => payload);
    const last = rows[options.limit - 1];
    return {
      items,
      nextAfter: rows.length > options.limit && last
        ? [last.created_at, last.id] as [string, string]
        : null,
    };
  },

  async create(scope, input) {
    const db = createServerSupabase();
    if (input.projectId && !(await checkProjectAccess(
      input.projectId, scope.userId, scope.userEmail, db,
    )).ok) fail(404, "Project not found");
    const documentIds = await accessibleDocuments(db, scope, input.documentIds);
    const { data, error } = await db.from("tabular_reviews").insert({
      user_id: scope.userId,
      title: input.title ?? null,
      columns_config: input.columns,
      document_ids: documentIds,
      project_id: input.projectId,
      workflow_id: input.workflowId ?? null,
    }).select("*").single();
    databaseError(error, "Failed to create review");
    if (!data) fail(500, "Failed to create review");
    const cells = documentIds.flatMap((documentId) => input.columns.map(
      ({ index }) => ({
        review_id: data.id,
        document_id: documentId,
        column_index: index,
        status: "pending",
      }),
    ));
    if (cells.length) {
      const inserted = await db.from("tabular_cells").insert(cells);
      databaseError(inserted.error, "Failed to create review cells");
    }
    void recordAudit(db, {
      userId: scope.userId,
      userEmail: scope.userEmail,
      action: "tabular.created",
      title: data.title ?? null,
      surface: "tabular",
      projectId: input.projectId,
      reviewId: data.id,
    });
    return review(data);
  },

  async detail(scope, reviewId) {
    const db = createServerSupabase();
    const access = await accessibleReview(db, scope, reviewId);
    if (!access) return null;
    const item = review(access.row, access.isOwner);
    const { data: cells, error } = await db.from("tabular_cells")
      .select("*").eq("review_id", reviewId);
    databaseError(error, "Failed to load review cells");
    const result = item.document_ids.length
      ? await db.from("documents").select("*").in("id", item.document_ids)
      : { data: [] as Row[], error: null };
    databaseError(result.error, "Failed to load review documents");
    const documents = (result.data ?? []) as Row[];
    await attachActiveVersionPaths(db, documents);
    return {
      review: item,
      cells: (cells ?? []).map(cell),
      documents,
    };
  },

  async people(scope, reviewId) {
    const db = createServerSupabase();
    const access = await accessibleReview(db, scope, reviewId);
    if (!access) return null;
    const { loadProfileUsersByEmail } = await import("./userLookup");
    const { userByEmail, userById } = await loadProfileUsersByEmail(db);
    const item = review(access.row, access.isOwner);
    const owner = userById.get(item.user_id);
    return {
      owner: {
        user_id: item.user_id,
        email: owner?.email ?? null,
        display_name: owner?.display_name ?? null,
      },
      members: item.shared_with.map((raw) => {
        const email = raw.toLowerCase();
        return { email, display_name: userByEmail.get(email)?.display_name ?? null };
      }),
    };
  },

  async update(scope, reviewId, input) {
    const db = createServerSupabase();
    const access = await accessibleReview(db, scope, reviewId);
    if (!access) return null;
    if (!access.isOwner && input.columns !== undefined) {
      fail(403, "Only the review owner can change columns");
    }
    if (!access.isOwner && input.sharedWith !== undefined) {
      fail(403, "Only the review owner can change sharing");
    }
    if (!access.isOwner && input.projectId !== undefined) {
      fail(403, "Only the review owner can move a review");
    }
    if (input.projectId && !(await checkProjectAccess(
      input.projectId, scope.userId, scope.userEmail, db,
    )).ok) fail(404, "Target project not found");
    if (input.sharedWith) {
      const { findMissingUserEmails } = await import("./userLookup");
      const missing = await findMissingUserEmails(db, input.sharedWith);
      if (missing.length) fail(400, `${missing[0]} does not belong to a Beaver user.`);
    }

    const current = review(access.row, access.isOwner);
    const documentIds = input.documentIds === undefined
      ? current.document_ids
      : await accessibleDocuments(db, scope, input.documentIds);
    const columns = input.columns ?? current.columns_config;
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
      ...(input.columns !== undefined ? { columns_config: columns } : {}),
      ...(input.documentIds !== undefined ? { document_ids: documentIds } : {}),
      ...(input.sharedWith !== undefined ? { shared_with: input.sharedWith } : {}),
    };
    const changed = await db.from("tabular_reviews").update(updates)
      .eq("id", reviewId).select("*").single();
    databaseError(changed.error, "Failed to update review");
    if (!changed.data) fail(500, "Failed to update review");

    if (input.columns !== undefined || input.documentIds !== undefined) {
      const existing = await db.from("tabular_cells")
        .select("id,document_id,column_index").eq("review_id", reviewId);
      databaseError(existing.error, "Failed to load review cells");
      const wanted = new Set(documentIds.flatMap((documentId) =>
        columns.map(({ index }) => `${documentId}:${index}`)));
      const rows = (existing.data ?? []) as Row[];
      const remove = rows.filter((row) =>
        !wanted.has(`${row.document_id}:${row.column_index}`));
      if (remove.length) {
        const deleted = await db.from("tabular_cells").delete()
          .in("id", remove.map(({ id }) => id));
        databaseError(deleted.error, "Failed to remove review cells");
      }
      const present = new Set(rows.map((row) =>
        `${row.document_id}:${row.column_index}`));
      const insert = documentIds.flatMap((documentId) => columns.flatMap(
        ({ index }) => present.has(`${documentId}:${index}`) ? [] : [{
          review_id: reviewId,
          document_id: documentId,
          column_index: index,
          status: "pending",
        }],
      ));
      if (insert.length) {
        const inserted = await db.from("tabular_cells").insert(insert);
        databaseError(inserted.error, "Failed to create review cells");
      }
    }
    return review({ ...changed.data, document_ids: documentIds }, access.isOwner);
  },

  async delete(scope, reviewId) {
    const db = createServerSupabase();
    const result = await db.from("tabular_reviews").delete()
      .eq("id", reviewId).eq("user_id", scope.userId);
    databaseError(result.error, "Failed to delete review");
    return true;
  },

  async clearCells(scope, reviewId, documentIds) {
    const db = createServerSupabase();
    if (!await accessibleReview(db, scope, reviewId)) return false;
    const result = await db.from("tabular_cells")
      .update({ content: null, status: "pending" })
      .eq("review_id", reviewId).in("document_id", documentIds);
    databaseError(result.error, "Failed to clear review cells");
    return true;
  },

  async setCell(scope, input) {
    const db = createServerSupabase();
    if (!await accessibleReview(db, scope, input.reviewId)) return false;
    const result = await db.from("tabular_cells").update({
      content: input.content ? JSON.stringify(input.content) : null,
      status: input.status,
    }).eq("review_id", input.reviewId)
      .eq("document_id", input.documentId)
      .eq("column_index", input.columnIndex);
    databaseError(result.error, "Failed to update review cell");
    return true;
  },

  async recordGeneration(scope, input) {
    const db = createServerSupabase();
    await recordAudit(db, {
      userId: scope.userId,
      userEmail: scope.userEmail,
      action: "tabular.generated",
      ...(input.failed ? { status: "failed" } : {}),
      title: input.title,
      surface: "tabular",
      projectId: input.projectId,
      reviewId: input.reviewId,
      model: input.model,
    });
  },

} satisfies TabularStore;
