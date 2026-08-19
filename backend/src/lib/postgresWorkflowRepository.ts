import { createServerSupabase } from "./supabase";
import { findMissingUserEmails } from "./userLookup";
import type {
  CreateWorkflowRepository,
  WorkflowAccess,
  WorkflowCollaboration,
  WorkflowRecord,
  WorkflowUpdate,
  WorkflowValues,
} from "./workflowRepository";

type Db = ReturnType<typeof createServerSupabase>;
const query = async <T>(operation: PromiseLike<{ data: T; error: unknown }>): Promise<T> => {
  const { data, error } = await operation;
  if (error) throw error;
  return data;
};
const rowValues = (input: WorkflowValues | WorkflowUpdate) => ({
  ...(input.title !== undefined ? { title: input.title } : {}),
  ...("type" in input && input.type !== undefined ? { type: input.type } : {}),
  ...(input.promptMd !== undefined ? { prompt_md: input.promptMd } : {}),
  ...(input.columns !== undefined ? { columns_config: input.columns } : {}),
  ...(input.language !== undefined ? { language: input.language } : {}),
  ...(input.practice !== undefined ? { practice: input.practice } : {}),
  ...(input.jurisdictions !== undefined ? { jurisdictions: input.jurisdictions } : {}),
});

async function access(db: Db, userId: string, email: string | undefined,
  workflowId: string): Promise<WorkflowAccess | null> {
  const workflow = await query(db.from("workflows").select("*")
    .eq("id", workflowId).maybeSingle()) as WorkflowRecord | null;
  if (!workflow) return null;
  if (workflow.user_id === userId) {
    return { workflow, allowEdit: true, isOwner: true };
  }
  if (!email) return null;
  const share = await query(db.from("workflow_shares").select("allow_edit")
    .eq("workflow_id", workflowId).eq("shared_with_email", email)
    .maybeSingle()) as { allow_edit?: boolean } | null;
  return share ? { workflow, allowEdit: !!share.allow_edit, isOwner: false } : null;
}

export const postgresWorkflowRepository: CreateWorkflowRepository = (scope) => {
  const db = createServerSupabase();
  const email = scope.userEmail?.trim().toLowerCase();
  return {
    async page(options) {
      const rows = await query(db.rpc("get_collection_page", {
        p_resource: "workflows",
        p_user_id: scope.userId,
        p_user_email: email || null,
        p_filter: options.type,
        p_q: options.q,
        p_after_created_at: options.after?.[0] ?? null,
        p_after_id: options.after?.[1] ?? null,
        p_limit: options.limit + 1,
      })) as { payload: WorkflowRecord }[];
      const records = rows.map(({ payload }) => payload);
      const items = records.slice(0, options.limit), last = items.at(-1);
      return { items, nextAfter: records.length > options.limit && last
        ? [last.created_at, last.id] : null };
    },
    async hidden() {
      const rows = await query(db.from("hidden_workflows").select("workflow_id")
        .eq("user_id", scope.userId)) as { workflow_id: string }[];
      return rows.map(({ workflow_id }) => workflow_id);
    },
    async hide(workflowId) {
      await query(db.from("hidden_workflows").upsert(
        { user_id: scope.userId, workflow_id: workflowId },
        { onConflict: "user_id,workflow_id" },
      ));
    },
    async unhide(workflowId) {
      await query(db.from("hidden_workflows").delete()
        .eq("user_id", scope.userId).eq("workflow_id", workflowId));
    },
    async create(input) {
      return await query(db.from("workflows").insert({
        user_id: scope.userId, ...rowValues(input),
      }).select("*").single()) as WorkflowRecord;
    },
    get: (workflowId) => access(db, scope.userId, email, workflowId),
    async update(workflowId, input) {
      const visible = await access(db, scope.userId, email, workflowId);
      if (!visible?.allowEdit) return null;
      const workflow = await query(db.from("workflows").update(rowValues(input))
        .eq("id", workflowId).select("*").maybeSingle()) as WorkflowRecord | null;
      return workflow ? { ...visible, workflow } : null;
    },
    async remove(workflowId) {
      const removed = await query(db.from("workflows").delete()
        .eq("id", workflowId).eq("user_id", scope.userId).select("id")) as { id: string }[];
      if (removed.length) await query(db.from("hidden_workflows").delete()
        .eq("workflow_id", workflowId));
      return removed.length > 0;
    },
    async assistants() {
      const owned = await query(db.from("workflows").select("id,title,prompt_md")
        .eq("user_id", scope.userId).eq("type", "assistant")) as {
          id: string; title: string; prompt_md: string | null;
        }[];
      let shared: typeof owned = [];
      if (email) {
        const shares = await query(db.from("workflow_shares").select("workflow_id")
          .eq("shared_with_email", email)) as { workflow_id: string }[];
        const ids = [...new Set(shares.map(({ workflow_id }) => workflow_id))];
        if (ids.length) shared = await query(db.from("workflows")
          .select("id,title,prompt_md").in("id", ids).eq("type", "assistant")) as typeof owned;
      }
      return new Map([...owned, ...shared].flatMap((workflow) => workflow.prompt_md
        ? [[workflow.id, { title: workflow.title, skill_md: workflow.prompt_md }] as const]
        : []));
    },
  };
};

export const postgresWorkflowCollaboration: WorkflowCollaboration = {
  async shares(scope, workflowId) {
    const db = createServerSupabase();
    const workflow = await query(db.from("workflows").select("id")
      .eq("id", workflowId).eq("user_id", scope.userId).maybeSingle());
    if (!workflow) return null;
    return await query(db.from("workflow_shares")
      .select("id,shared_with_email,allow_edit,created_at")
      .eq("workflow_id", workflowId).order("created_at", { ascending: true })) as never;
  },
  async removeShare(scope, workflowId, shareId) {
    const db = createServerSupabase();
    const workflow = await query(db.from("workflows").select("id")
      .eq("id", workflowId).eq("user_id", scope.userId).maybeSingle());
    if (!workflow) return false;
    const removed = await query(db.from("workflow_shares").delete()
      .eq("id", shareId).eq("workflow_id", workflowId).select("id")) as { id: string }[];
    return removed.length > 0;
  },
  async share(scope, workflowId, emails, allowEdit) {
    const db = createServerSupabase();
    const workflow = await query(db.from("workflows").select("id")
      .eq("id", workflowId).eq("user_id", scope.userId).maybeSingle());
    if (!workflow) return "missing";
    const missingEmail = (await findMissingUserEmails(db, emails))[0];
    if (missingEmail) return { missingEmail };
    await query(db.from("workflow_shares").upsert(emails.map((sharedEmail) => ({
      workflow_id: workflowId,
      shared_by_user_id: scope.userId,
      shared_with_email: sharedEmail,
      allow_edit: allowEdit,
    })), { onConflict: "workflow_id,shared_with_email" }));
    return "ok";
  },
  async latestSubmission(scope, workflowId) {
    return await query(createServerSupabase().from("workflow_open_source_submissions")
      .select("id,status,submitted_at,updated_at,reviewed_at")
      .eq("workflow_id", workflowId).eq("submitted_by_user_id", scope.userId)
      .order("submitted_at", { ascending: false }).limit(1).maybeSingle()) as never;
  },
  async submit(scope, workflow, input) {
    const db = createServerSupabase();
    const profile = await query(db.from("user_profiles").select("display_name")
      .eq("user_id", scope.userId).maybeSingle()) as { display_name?: string } | null;
    const displayName = profile?.display_name?.trim() || null;
    const now = new Date().toISOString();
    const pending = await query(db.from("workflow_open_source_submissions")
      .select("id").eq("workflow_id", workflow.id)
      .eq("submitted_by_user_id", scope.userId).eq("status", "pending")
      .maybeSingle()) as { id: string } | null;
    const values = {
      submitter_email: scope.userEmail ?? null,
      submitter_name: input.contributorMode === "named" ? displayName : null,
      contributor_mode: input.contributorMode,
      snapshot: {
        workflow_id: workflow.id,
        metadata: input.metadata,
        skill_md: workflow.prompt_md,
        columns_config: workflow.columns_config,
        contributor_mode: input.contributorMode,
        created_at: workflow.created_at,
      },
      updated_at: now,
    };
    const selection = "id,status,submitted_at,updated_at,reviewed_at";
    if (pending) {
      const updated = await query(db.from("workflow_open_source_submissions")
        .update(values).eq("id", pending.id).select(selection).single()) as object;
      return { ...updated, mode: "updated" } as never;
    }
    const created = await query(db.from("workflow_open_source_submissions").insert({
      ...values,
      workflow_id: workflow.id,
      submitted_by_user_id: scope.userId,
      status: "pending",
      submitted_at: now,
    }).select(selection).single()) as object;
    return { ...created, mode: "created" } as never;
  },
};
