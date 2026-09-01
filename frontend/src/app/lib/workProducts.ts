export type WorkProductKind = "court-record" | "authorities" | "research-set";

export type WorkProductInput =
  | { kind: "local-file"; handleId: string; lastSeen: FileSnapshot }
  | { kind: "document"; documentId: string; version: "latest" | { versionId: string; sha256: string } }
  | { kind: "work-product-output"; workProductId: string; role: string };

export type FileSnapshot = {
  name: string;
  size: number;
  modified: number;
  sha256?: string;
};

export type WorkProductOutput = {
  documentId: string;
  versionId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  pageCount: number | null;
};
export type WorkProductOutputRef = Pick<WorkProductOutput, "documentId" | "versionId">;

export type ResolvedWorkProductInput =
  | { kind: "local-file"; handleId: string; filename: string; size: number;
      modified: number; sha256: string }
  | { kind: "document"; documentId: string; versionId: string; filename: string;
      sha256: string }
  | { kind: "work-product-output"; workProductId: string; role: string;
      documentId: string; versionId: string; filename: string; sha256: string };

export type WorkProductBuildReceipt = {
  schemaVersion: "beaver.work-product-build.v2";
  builtAt: string;
  workProduct: { id: string; kind: WorkProductKind; revision: number };
  inputs: Array<{ role: string; resolved: ResolvedWorkProductInput }>;
  settings: { profileId: string | null; outputMode: string; stateSha256: string;
    settingsSha256: string; sourceReceiptIds: string[]; audit: {
      effective: { from: string; to: string | null } | null;
      valuesJson: string;
    } };
  steps: string[];
  output: { role: string; filename: string; mimeType: string;
    pageCount: number | null; sha256: string };
};

export type WorkProduct<State = unknown> = {
  id: string;
  kind: WorkProductKind;
  title: string;
  projectId: string | null;
  revision: number;
  state: State;
  outputs: Record<string, WorkProductOutput>;
  createdAt: string;
  updatedAt: string;
};
export type WorkProductContext = Pick<WorkProduct,
  "id" | "kind" | "revision" | "projectId">;
export type WorkProductMetadata = Omit<WorkProduct, "state" | "outputs">;

export type WorkProductCreate<State> = Pick<WorkProduct<State>, "kind" | "title" | "state"> & {
  projectId?: string | null;
};

export type WorkProductPatch<State> = Partial<Pick<WorkProduct<State>, "title" | "projectId" | "state">> & {
  outputs?: Record<string, WorkProductOutputRef>;
  revision: number;
};

export type WorkProductInputResolution =
  | { status: "ready"; input: WorkProductInput; resolved: ResolvedWorkProductInput }
  | { status: "changed"; input: WorkProductInput; previous: ResolvedWorkProductInput;
      current: ResolvedWorkProductInput }
  | { status: "missing"; input: WorkProductInput; reason: "deleted" | "unavailable";
      resource: "document" | "work-product" | "output"; id: string }
  | { status: "review"; input: WorkProductInput; reason: "nested-draft-stale";
      workProductId: string; resolved: ResolvedWorkProductInput };

export type WorkProductResolution<State = unknown> = {
  product: WorkProduct<State>;
  freshness: "unbuilt" | "current" | "stale";
  inputs: Record<string, WorkProductInputResolution>;
  dependencies: string[];
};

export interface WorkProductStore {
  list<State>(kind: WorkProductKind, projectId?: string): Promise<WorkProduct<State>[]>;
  get<State>(id: string): Promise<WorkProduct<State>>;
  create<State>(input: WorkProductCreate<State>): Promise<WorkProduct<State>>;
  update<State>(id: string, patch: WorkProductPatch<State>): Promise<WorkProduct<State>>;
  duplicate<State>(id: string, input?: { title?: string; projectId?: string | null }):
    Promise<WorkProduct<State>>;
  remove(id: string): Promise<void>;
}

export type InputResolution =
  | { status: "ready" | "changed"; file: File; input: WorkProductInput }
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
