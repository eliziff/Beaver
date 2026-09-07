import { WORK_PRODUCT_KINDS, type WorkProductKind, type WorkProductInput,
  type WorkProductState, type WorkProductMetadata, type WorkProductBuildReceipt, type WorkProductOutputRef,
  type WorkProduct as Product, type WorkProductResolution as Resolution,
} from "mike/shared/work-products.mjs";
import type { ApplicationScope } from "./applicationError";
import { jsonRecord as record } from "./value";

export { WORK_PRODUCT_KINDS };
export type { WorkProductKind, WorkProductInput, WorkProductState, WorkProductOutput,
  WorkProductOutputRef, ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductMetadata, WorkProductInputResolution } from "mike/shared/work-products.mjs";

const closed = (value: unknown, keys: string[], optional: string[] = []) => {
  const item = record(value);
  return item && Object.keys(item).every((key) => keys.includes(key) || optional.includes(key)) &&
    keys.every((key) => Object.hasOwn(item, key)) ? item : null;
};
const text = (value: unknown, max = 500) => typeof value === "string" &&
  value.length > 0 && value.length <= max;
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const list = (value: unknown, max: number, valid: (item: unknown) => boolean) =>
  Array.isArray(value) && value.length <= max && value.every(valid);

function decodeWorkProductInput(value: unknown): WorkProductInput | null {
  const item = record(value);
  if (item?.kind === "local-file") {
    const seen = closed(item.lastSeen, ["name", "size", "modified"], ["sha256"]);
    if (!closed(item, ["kind", "handleId", "lastSeen"]) || !seen ||
        !text(item.handleId, 200) || !text(seen.name) || !count(seen.size) ||
        !count(seen.modified) || !(seen.sha256 === undefined || digest(seen.sha256))) return null;
    return item as unknown as WorkProductInput;
  }
  if (item?.kind === "document") {
    const version = item.version === "latest" ? "latest" :
      closed(item.version, ["versionId", "sha256"]);
    if (!closed(item, ["kind", "documentId", "version"]) || !text(item.documentId, 200) ||
        !version || version !== "latest" &&
        (!text(version.versionId, 200) || !digest(version.sha256))) return null;
    return item as unknown as WorkProductInput;
  }
  if (item?.kind === "work-product-output" &&
      closed(item, ["kind", "workProductId", "role"]) &&
      text(item.workProductId, 200) && text(item.role, 100)) {
    return item as unknown as WorkProductInput;
  }
  return null;
}

export function decodeWorkProductBindings(value: unknown): Record<string, WorkProductInput> | null {
  const bindings = record(value);
  if (!bindings || Object.keys(bindings).length > 500) return null;
  for (const [role, input] of Object.entries(bindings)) {
    if (!text(role, 200) || !decodeWorkProductInput(input)) return null;
  }
  return bindings as Record<string, WorkProductInput>;
}

export function decodeWorkProductState(value: unknown): WorkProductState | null {
  const state = record(value);
  if (!state || state.bindings !== undefined && !decodeWorkProductBindings(state.bindings)) {
    return null;
  }
  return state as WorkProductState;
}

function resolvedInput(value: unknown) {
  const item = record(value);
  if (item?.kind === "local-file") return closed(item,
    ["kind", "handleId", "filename", "size", "modified", "sha256"]) &&
    text(item.handleId, 200) && text(item.filename) && count(item.size) &&
    count(item.modified) && digest(item.sha256);
  if (item?.kind === "document") return closed(item,
    ["kind", "documentId", "versionId", "filename", "sha256"]) &&
    text(item.documentId, 200) && text(item.versionId, 200) && text(item.filename) &&
    digest(item.sha256);
  if (item?.kind === "work-product-output") return closed(item,
    ["kind", "workProductId", "role", "documentId", "versionId", "filename", "sha256"]) &&
    text(item.workProductId, 200) && text(item.role, 100) && text(item.documentId, 200) &&
    text(item.versionId, 200) && text(item.filename) && digest(item.sha256);
  return false;
}

export function decodeWorkProductBuildReceipt(value: unknown): WorkProductBuildReceipt | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const receipt = closed(value,
    ["schemaVersion", "builtAt", "workProduct", "inputs", "settings", "steps", "output"]);
  const product = closed(receipt?.workProduct, ["id", "kind", "revision"]);
  const settings = closed(receipt?.settings,
    ["profileId", "outputMode", "stateSha256", "settingsSha256", "sourceReceiptIds", "audit"]);
  const audit = closed(settings?.audit, ["effective", "valuesJson"]);
  const effective = audit?.effective === null ? null : closed(audit?.effective, ["from", "to"]);
  const output = closed(receipt?.output,
    ["role", "filename", "mimeType", "pageCount", "sha256"]);
  const inputs = receipt?.inputs, steps = receipt?.steps;
  if (receipt?.schemaVersion !== "beaver.work-product-build.v2" ||
      !text(receipt.builtAt, 50) || Number.isNaN(Date.parse(String(receipt.builtAt))) ||
      !product || !text(product.id, 200) ||
      !WORK_PRODUCT_KINDS.includes(product.kind as WorkProductKind) ||
      !Number.isSafeInteger(product.revision) || Number(product.revision) < 1 ||
      !list(inputs, 500, (value) => {
        const input = closed(value, ["role", "resolved"]);
        return !!input && text(input.role, 200) && !!resolvedInput(input.resolved);
      }) || !settings || !(settings.profileId === null || text(settings.profileId, 200)) ||
      !text(settings.outputMode, 100) || !digest(settings.stateSha256) ||
      !digest(settings.settingsSha256) ||
      !list(settings.sourceReceiptIds, 500, (id) => text(id, 200)) ||
      !audit || !(audit.effective === null || effective &&
        text(effective.from, 50) && (effective.to === null || text(effective.to, 50))) ||
      typeof audit.valuesJson !== "string" || audit.valuesJson.length > 250_000 ||
      !record((() => { try { return JSON.parse(audit.valuesJson); } catch { return null; } })()) ||
      !list(steps, 100, (step) => text(step, 500)) ||
      !output || !text(output.role, 100) || !text(output.filename) ||
      !text(output.mimeType, 200) || !(output.pageCount === null || count(output.pageCount)) ||
      !digest(output.sha256)) return null;
  return receipt as unknown as WorkProductBuildReceipt;
}

export type WorkProduct = Product<WorkProductState, "court-record"> |
  Product<WorkProductState, "authorities">;
export type WorkProductReference = Pick<WorkProduct, "id" | "kind" | "revision">;
export type WorkProductResolution = Omit<Resolution<WorkProductState>, "product"> & {
  product: WorkProduct;
};
export const workProductInputs = (state: WorkProductState) =>
  Object.values(state.bindings ?? {});

export type WorkProductFailure =
  | { status: "missing"; resource: "project" | "document" | "work-product" | "output";
      id: string }
  | { status: "conflict"; revision: number }
  | { status: "cycle"; ids: string[] }
  | { status: "too-many-dependencies" }
  | { status: "invalid-output"; role: string };

export type WorkProductRepository = {
  list(scope: ApplicationScope, options: {
    kind?: WorkProductKind; projectId?: string; limit?: number; metadata?: boolean;
  }): Promise<Array<WorkProduct | WorkProductMetadata>>;
  get(scope: ApplicationScope, id: string): Promise<{
    product: WorkProduct; isOwner: boolean;
  } | null>;
  resolve(scope: ApplicationScope, id: string): Promise<WorkProductResolution |
    WorkProductFailure>;
  create(scope: ApplicationScope, input: {
    kind: WorkProductKind; title: string; projectId: string | null; state: WorkProductState;
  }): Promise<{ status: "created"; product: WorkProduct } | WorkProductFailure>;
  save(scope: ApplicationScope, id: string, input: {
    revision: number; title?: string; projectId?: string | null; state?: WorkProductState;
    outputs?: Record<string, WorkProductOutputRef>;
  }): Promise<{ status: "saved"; product: WorkProduct } | WorkProductFailure>;
  remove(scope: ApplicationScope, id: string): Promise<boolean>;
};
