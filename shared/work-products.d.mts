export const WORK_PRODUCT_KINDS: readonly ["court-record", "authorities"];
export type WorkProductKind = typeof WORK_PRODUCT_KINDS[number];

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

export type WorkProductState = Record<string, unknown> & {
  bindings?: Record<string, WorkProductInput>;
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

export type WorkProduct<State = unknown, Kind extends WorkProductKind = WorkProductKind> = {
  id: string;
  kind: Kind;
  title: string;
  projectId: string | null;
  revision: number;
  state: State;
  outputs: Record<string, WorkProductOutput>;
  createdAt: string;
  updatedAt: string;
};
export type WorkProductMetadata = Omit<WorkProduct, "state"> & { profileId?: string };

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
