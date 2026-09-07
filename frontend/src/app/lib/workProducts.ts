import type { FileSnapshot, WorkProduct, WorkProductKind, WorkProductInput,
  WorkProductOutputRef, WorkProductMetadata } from "../../../../shared/work-products.mjs";

export { WORK_PRODUCT_KINDS } from "../../../../shared/work-products.mjs";
export type { FileSnapshot, WorkProductKind, WorkProductInput, WorkProductOutput,
  WorkProductOutputRef, ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProduct, WorkProductMetadata, WorkProductInputResolution,
  WorkProductResolution } from "../../../../shared/work-products.mjs";

export type WorkProductContext = Pick<WorkProduct,
  "id" | "kind" | "revision" | "projectId">;
export type WorkProductFocus = { itemId: string;
  selection?: { start: number; end: number } };
export type WorkProductRefresh = Pick<WorkProductContext, "id" | "revision"> & {
  sequence: number;
};

export type WorkProductCreate<State> = Pick<WorkProduct<State>, "kind" | "title" | "state"> & {
  projectId?: string | null;
};

export type WorkProductPatch<State> = Partial<Pick<WorkProduct<State>, "title" | "projectId" | "state">> & {
  outputs?: Record<string, WorkProductOutputRef>;
  revision: number;
};

export interface WorkProductStore {
  list<State>(kind: WorkProductKind, projectId?: string): Promise<WorkProduct<State>[]>;
  listMetadata?(kind: WorkProductKind, projectId?: string): Promise<WorkProductMetadata[]>;
  get<State>(id: string): Promise<WorkProduct<State>>;
  create<State>(input: WorkProductCreate<State>): Promise<WorkProduct<State>>;
  update<State>(id: string, patch: WorkProductPatch<State>): Promise<WorkProduct<State>>;
  duplicate<State>(id: string, input?: { title?: string; projectId?: string | null }):
    Promise<WorkProduct<State>>;
  remove(id: string): Promise<void>;
}

export type InputResolution =
  | { status: "ready" | "changed" | "stale"; file: File; input: WorkProductInput }
  | { status: "missing"; reason: "deleted" | "permission" | "unavailable" };

export const workProductInputs = (state: unknown): WorkProductInput[] => {
  const value = (state as { bindings?: unknown } | null)?.bindings;
  return !value || typeof value !== "object" || Array.isArray(value) ? [] :
    Object.values(value).filter((input): input is WorkProductInput =>
      !!input && typeof input === "object" && "kind" in input);
};

export function fileSnapshot(file: File): FileSnapshot {
  return { name: file.name, size: file.size, modified: file.lastModified };
}
