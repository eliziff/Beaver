import { jsonRecord as row, trimmedText as text } from "../value";
import type { WorkProductReference } from "../workProduct";

type WorkflowRunTool =
  | "update_work_product"
  | "fix_docx_supras";
type Row = Record<string, unknown>;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? value
  : undefined;
const workProduct = (value: unknown) => {
  const item = row(value), id = text(item?.id), revision = number(item?.revision);
  const kind = item?.kind;
  return id && Number.isSafeInteger(revision) && revision! >= 1 &&
    ["court-record", "authorities", "research-set"].includes(String(kind))
    ? { id, kind, revision } : undefined;
};

export type LocalWorkflowRunEvent = Row & { type: "workflow_run"; id: string };
export const workProductResult = (product: WorkProductReference,
  values: Row = {}) => ({ ok: true, work_product: { id: product.id, kind: product.kind,
    revision: product.revision }, ...values });

function event(
  tool: WorkflowRunTool,
  stage: string,
  fields: ReadonlyArray<readonly [label: string, key: string]>,
  value: unknown,
  id: string,
): LocalWorkflowRunEvent | null {
  const result = row(value);
  if (!result) return null;
  const error = text(result.error);
  const product = workProduct(result.work_product);
  const base = { type: "workflow_run" as const, id, tool, stage };
  if (result.ok !== true || error) {
    return { ...base, status: "error", error: error || "Workflow failed" };
  }
  const counts = fields.flatMap(([label, key]) =>
    number(result[key]) === undefined ? [] : [{ label, value: number(result[key])! }]);
  return {
    ...base,
    status: "complete",
    ...(counts.length && { counts }),
    ...(text(result.filename) && { outputs: [{ name: text(result.filename) }] }),
    ...(text(result.app_url) && { app_url: text(result.app_url) }),
    ...(product && { work_product: product }),
    ...(text(result.requested_action) && { requested_action: text(result.requested_action) }),
    ...(number(result.version_number) !== undefined && { version_number: number(result.version_number) }),
  };
}

export const workProductEvent = (value: unknown, id: string) =>
  event("update_work_product", "Update work product", [], value, id);

export const supraFixEvent = (value: unknown, id: string) =>
  event("fix_docx_supras", "Fix supra references", [
    ["Found", "detected"],
    ["Fixed", "converted"],
    ["Already linked", "already_linked"],
    ["Needs review", "review_required"],
  ], value, id);
