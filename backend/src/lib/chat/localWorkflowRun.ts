import { jsonRecord as row, trimmedText as text } from "../value";
import { WORK_PRODUCT_KINDS, type WorkProductKind,
  type WorkProductReference } from "../workProduct";
import type { WorkflowRunEvent } from "./assistantEvents";

type WorkflowRunTool = "update_work_product";
type Row = Record<string, unknown>;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? value
  : undefined;
const workProduct = (value: unknown): WorkProductReference | undefined => {
  const item = row(value), id = text(item?.id), revision = number(item?.revision);
  const kind = item?.kind;
  return id && Number.isSafeInteger(revision) && revision! >= 1 &&
    WORK_PRODUCT_KINDS.includes(kind as WorkProductKind)
    ? { id, kind: kind as WorkProductKind, revision: revision! } : undefined;
};

export const workProductResult = (product: WorkProductReference,
  values: Row = {}) => ({ ok: true, work_product: { id: product.id, kind: product.kind,
    revision: product.revision }, ...values });

function event(
  tool: WorkflowRunTool,
  stage: string,
  fields: ReadonlyArray<readonly [label: string, key: string]>,
  value: unknown,
  id: string,
): WorkflowRunEvent | null {
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

