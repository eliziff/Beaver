import { workflowRoleRank, workflowAccessPredicate } from "./resourceAccess";
import { randomUUID } from "node:crypto";
import type { ApplicationScope } from "./applicationError";
import type { CreateWorkflowRepository, WorkflowAccess, WorkflowRecord } from "./workflowRepository";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { changes, deleteDocumentRows, now, one, rows, type Row } from "./relationalRepositorySupport";
import { resourceReference } from "mike/shared/runtime/resourceReferences.mjs";
import { workflowVisibleTo } from "./systemWorkflows";
import { type WorkflowAudience } from "mike/shared/runtime/clientContracts.mjs";

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
  const row = await one(sql`SELECT w.*,${workflowRoleRank(scope)} access_rank
    FROM workflows w WHERE w.id=${id} AND ${workflowAccessPredicate(scope)}`, db);
  if (!row) return null;
  const isOwner = Number(row.access_rank) === 3;
  return { workflow: workflowRecord(row), isOwner,
    allowEdit: Number(row.access_rank) >= 2 };
}

export const workflowRepository: CreateWorkflowRepository = (scope) => ({
  async documents(id) {
    return (await rows(sql`SELECT d.id,v.filename,v.id current_version_id,v.working_revision current_working_revision,
      v.source_sha256,v.size_bytes FROM workflow_documents wd JOIN workflows w ON w.id=wd.workflow_id
      JOIN documents d ON d.id=wd.document_id JOIN document_versions v ON v.id=d.current_version_id
      WHERE w.id=${id} AND ${workflowAccessPredicate(scope)} ORDER BY v.filename,d.id`)).map((row) => ({
        id: String(row.id), filename: String(row.filename), current_version_id: String(row.current_version_id),
        current_working_revision: Number(row.current_working_revision), source_sha256: String(row.source_sha256), size_bytes: Number(row.size_bytes) }));
  },
  async list(options) {
    const result = (await rows(sql`SELECT w.* FROM workflows w WHERE
      ${workflowAccessPredicate(scope)}
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
    await changes(sql`UPDATE workflows AS w SET title=${input.title ?? value.title},
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
      updated_at=${now()} WHERE w.id=${id} AND ${workflowAccessPredicate(scope, "edit")}`);
    return workflowAccess(scope, id);
  },
  async remove(id) {
    return (await relationalDatabase()).transaction(async (db) => {
      if (!await one(sql`SELECT w.id FROM workflows w WHERE w.id=${id} AND ${workflowAccessPredicate(scope, "owner")}
        ${db.engine === "postgres" ? sql.raw("FOR UPDATE") : sql.raw("")}`, db)) return false;
      const documents = await rows<{ document_id: string }>(sql`SELECT document_id FROM workflow_documents WHERE workflow_id=${id}`, db);
      await deleteDocumentRows(db, documents.map(({ document_id }) => document_id));
      return await changes(sql`DELETE FROM workflows WHERE id=${id}`, db) > 0;
    });
  },
  async assistants() {
    const values = await rows(sql`SELECT w.* FROM workflows w WHERE w.execution='assistant'
      AND ${workflowAccessPredicate(scope)}`);
    const references = await rows(sql`SELECT wd.workflow_id,d.id,v.id version_id,v.filename FROM workflow_documents wd
      JOIN workflows w ON w.id=wd.workflow_id JOIN documents d ON d.id=wd.document_id
      JOIN document_versions v ON v.id=d.current_version_id WHERE ${workflowAccessPredicate(scope)} ORDER BY v.filename,d.id`);
    return new Map(values.flatMap((row) => {
      const workflow = workflowRecord(row);
      const attached = references.filter((reference) => reference.workflow_id === workflow.id)
        .map((reference) => `${JSON.stringify(reference.filename)}: ${resourceReference.document(String(reference.id), String(reference.version_id))}`);
      return workflow.prompt_md ? [[workflow.id, { workflow_id: workflow.id, title: workflow.title,
        skill_md: workflow.prompt_md + (attached.length ? `\n\nReference documents (use Read when needed):\n${attached.join("\n")}` : "") }] as const] : [];
    }));
  },
});
