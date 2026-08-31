import { randomUUID } from "node:crypto";
import type { ApplicationScope } from "./applicationError";
import type { CreateWorkflowRepository, WorkflowAccess, WorkflowCollaboration, WorkflowRecord } from "./workflowRepository";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { changes, email, missingProfileEmail, now, one, rows, type Row } from "./relationalRepositorySupport";
import { workflowVisibleTo, type WorkflowAudience } from "./systemWorkflows";

const workflowRecord = (row: Row): WorkflowRecord => ({ ...row, id: String(row.id),
  user_id: typeof row.user_id === "string" ? row.user_id : null,
  title: String(row.title), execution: row.execution === "tabular" ? "tabular" : "assistant",
  variant_label: String(row.variant_label),
  variant_result: typeof row.variant_result === "string" ? row.variant_result : null,
  prompt_md: typeof row.prompt_md === "string" ? row.prompt_md : null,
  columns_config: decode(row.columns_config, null),
  language: typeof row.language === "string" ? row.language : null,
  version: typeof row.version === "string" ? row.version : null,
  category: String(row.category) as WorkflowRecord["category"],
  audiences: decode<WorkflowAudience[]>(row.audiences, []),
  jurisdictions: decode(row.jurisdictions, null), contributors: decode(row.contributors, null),
  created_at: String(row.created_at) });
async function workflowAccess(scope: ApplicationScope, id: string,
  db?: RelationalDatabase): Promise<WorkflowAccess | null> {
  const row = await one(sql`SELECT w.*,
      CASE WHEN w.user_id=${scope.userId} THEN 1 ELSE 0 END is_owner,
      COALESCE((SELECT allow_edit FROM workflow_shares s WHERE s.workflow_id=w.id
        AND s.shared_with_email=${email(scope)}),0) allow_edit
    FROM workflows w WHERE w.id=${id} AND (w.user_id=${scope.userId} OR EXISTS(
      SELECT 1 FROM workflow_shares s WHERE s.workflow_id=w.id
        AND s.shared_with_email=${email(scope)}))`, db);
  if (!row) return null;
  const isOwner = Boolean(row.is_owner);
  return { workflow: workflowRecord(row), isOwner,
    allowEdit: isOwner || Boolean(row.allow_edit) };
}

export const workflowRepository: CreateWorkflowRepository = (scope) => ({
  async list(options) {
    const result = (await rows(sql`SELECT w.* FROM workflows w WHERE
      (w.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM workflow_shares s
        WHERE s.workflow_id=w.id AND s.shared_with_email=${email(scope)}))
      ORDER BY w.created_at DESC,w.id DESC`)).map(workflowRecord);
    return result.filter((workflow) =>
      (!options.q || [workflow.title, workflow.variant_label, workflow.variant_result ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(options.q))) &&
      workflowVisibleTo(workflow.audiences, options.audience));
  },
  async create(input) {
    const id = randomUUID(), created = now();
    await changes(sql`INSERT INTO workflows(id,user_id,title,execution,variant_label,variant_result,
      prompt_md,columns_config,
      language,version,category,audiences,jurisdictions,contributors,created_at,updated_at)
      VALUES(${id},${scope.userId},${input.title},${input.execution},${input.variantLabel},
      ${input.variantResult},${input.promptMd},
      ${input.columns === null ? null : encode(input.columns)},${input.language},${null},
      ${input.category},${encode(input.audiences)},
      ${input.jurisdictions === null ? null : encode(input.jurisdictions)},
      ${null},${created},${created})`);
    return (await workflowAccess(scope, id))!.workflow;
  },
  get(id) { return workflowAccess(scope, id); },
  async update(id, input) {
    const current = await workflowAccess(scope, id);
    if (!current?.allowEdit) return null;
    const value = current.workflow;
    await changes(sql`UPDATE workflows SET title=${input.title ?? value.title},
      execution=${input.execution ?? value.execution},
      variant_label=${input.variantLabel ?? value.variant_label},
      variant_result=${input.variantResult === undefined ? value.variant_result : input.variantResult},
      prompt_md=${input.promptMd === undefined ? value.prompt_md : input.promptMd},
      columns_config=${input.columns === undefined
        ? value.columns_config === null ? null : encode(value.columns_config)
        : input.columns === null ? null : encode(input.columns)},
      language=${input.language === undefined ? value.language : input.language},
      category=${input.category ?? value.category},
      audiences=${input.audiences === undefined ? encode(value.audiences) : encode(input.audiences)},
      jurisdictions=${input.jurisdictions === undefined
        ? value.jurisdictions === null ? null : encode(value.jurisdictions)
        : input.jurisdictions === null ? null : encode(input.jurisdictions)},
      updated_at=${now()} WHERE id=${id}`);
    return workflowAccess(scope, id);
  },
  async remove(id) {
    return await changes(sql`DELETE FROM workflows WHERE id=${id}
      AND user_id=${scope.userId}`) > 0;
  },
  async assistants() {
    const values = await rows(sql`SELECT w.* FROM workflows w WHERE w.execution='assistant'
      AND (w.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM workflow_shares s
        WHERE s.workflow_id=w.id AND s.shared_with_email=${email(scope)}))`);
    return new Map(values.flatMap((row) => {
      const workflow = workflowRecord(row);
      return workflow.prompt_md ? [[workflow.id, { workflow_id: workflow.id, title: workflow.title,
        skill_md: workflow.prompt_md }] as const] : [];
    }));
  },
});

export const workflowCollaboration: WorkflowCollaboration = {
  async shares(scope, workflowId) {
    const owner = await workflowAccess(scope, workflowId);
    if (!owner?.isOwner) return null;
    return (await rows(sql`SELECT id,shared_with_email,allow_edit,created_at FROM workflow_shares
      WHERE workflow_id=${workflowId} ORDER BY created_at`)).map((row) => ({ ...row,
        allow_edit: Boolean(row.allow_edit) })) as never;
  },
  async removeShare(scope, workflowId, shareId) {
    const owner = await workflowAccess(scope, workflowId);
    return !!owner?.isOwner && await changes(sql`DELETE FROM workflow_shares
      WHERE id=${shareId} AND workflow_id=${workflowId}`) > 0;
  },
  async share(scope, workflowId, emails, allowEdit) {
    const db = await relationalDatabase(), owner = await workflowAccess(scope, workflowId, db);
    if (!owner?.isOwner) return "missing";
    const missingEmail = await missingProfileEmail(db, emails);
    if (missingEmail) return { missingEmail };
    for (const value of emails) await changes(sql`INSERT INTO workflow_shares(id,workflow_id,
      shared_by_user_id,shared_with_email,allow_edit,created_at) VALUES(${randomUUID()},
      ${workflowId},${scope.userId},${value.trim().toLowerCase()},
      ${allowEdit ? sql.raw("TRUE") : sql.raw("FALSE")},${now()})
      ON CONFLICT(workflow_id,shared_with_email) DO UPDATE SET allow_edit=excluded.allow_edit`, db);
    return "ok";
  },
  async latestSubmission(scope, workflowId) {
    return await one(sql`SELECT id,status,submitted_at,updated_at,reviewed_at
      FROM workflow_open_source_submissions WHERE workflow_id=${workflowId}
        AND submitted_by_user_id=${scope.userId} ORDER BY submitted_at DESC LIMIT 1`) as never;
  },
  async submit(scope, workflow, input) {
    const db = await relationalDatabase();
    const profile = db.engine === "postgres" ? await one<{ display_name: string | null }>(
      sql`SELECT display_name FROM user_preferences WHERE user_id=${scope.userId}`, db) : null;
    const created = now(), pending = await one<{ id: string }>(sql`SELECT id
      FROM workflow_open_source_submissions WHERE workflow_id=${workflow.id}
        AND submitted_by_user_id=${scope.userId} AND status='pending' LIMIT 1`, db);
    const snapshot = encode({ workflow_id: workflow.id, metadata: input.metadata,
      launcher: { kind: "instructions", variants: [{ id: workflow.id,
        label: workflow.variant_label, result: workflow.variant_result,
        execution: workflow.execution, skill_md: workflow.prompt_md,
        columns_config: workflow.columns_config }] },
      contributor_mode: input.contributorMode, created_at: workflow.created_at });
    if (pending) {
      await changes(sql`UPDATE workflow_open_source_submissions SET
        submitter_email=${scope.userEmail ?? null},submitter_name=${input.contributorMode === "named"
          ? profile?.display_name?.trim() || null : null},contributor_mode=${input.contributorMode},
        snapshot=${snapshot},updated_at=${created} WHERE id=${pending.id}`, db);
      const result = await one<Row>(sql`SELECT id,status,submitted_at,updated_at,reviewed_at
        FROM workflow_open_source_submissions WHERE id=${pending.id}`, db);
      return { ...result, mode: "updated" } as never;
    }
    const id = randomUUID();
    await changes(sql`INSERT INTO workflow_open_source_submissions(id,workflow_id,
      submitted_by_user_id,submitter_email,submitter_name,contributor_mode,snapshot,status,
      submitted_at,updated_at,reviewed_at) VALUES(${id},${workflow.id},${scope.userId},
      ${scope.userEmail ?? null},${input.contributorMode === "named"
        ? profile?.display_name?.trim() || null : null},${input.contributorMode},${snapshot},
      'pending',${created},${created},${null})`, db);
    const result = await one<Row>(sql`SELECT id,status,submitted_at,updated_at,reviewed_at
      FROM workflow_open_source_submissions WHERE id=${id}`, db);
    return { ...result, mode: "created" } as never;
  },
};
