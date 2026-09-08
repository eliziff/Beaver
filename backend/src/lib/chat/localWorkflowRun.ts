import { jsonRecord as row, trimmedText as text } from "../value";
import type { WorkProductReference } from "../workProduct";
import { workflow } from "./assistantWire";

export const workProductResult = (product: WorkProductReference,
  values: Record<string, unknown> = {}) => ({ ok: true,
    work_product: { id: product.id, kind: product.kind, revision: product.revision }, ...values });

export function workProductEvent(value: unknown, id: string) {
  const result = row(value);
  if (!result) return null;
  const error = text(result.error);
  const base = { type: "workflow_run", id, tool: "update_work_product", stage: "Update work product" };
  const parsed = workflow.safeParse(result.ok !== true || error
    ? { ...base, status: "error", error: error || "Workflow failed" }
    : { ...base, status: "complete",
      ...(text(result.filename) && { outputs: [{ name: text(result.filename) }] }),
      ...(text(result.app_url) && { app_url: text(result.app_url) }),
      ...(result.work_product !== undefined && { work_product: result.work_product }),
      ...(text(result.requested_action) && { requested_action: text(result.requested_action) }),
      ...(result.version_number !== undefined && { version_number: result.version_number }) });
  return parsed.success ? parsed.data : null;
}
