import { WORK_PRODUCT_KINDS, type WorkProductKind, type WorkProductInput, type FileSnapshot,
  type WorkProductState, type WorkProductMetadata, type WorkProductBuildReceipt, type WorkProductOutputRef,
  type ResolvedWorkProductInput,
  type WorkProduct as Product, type WorkProductResolution as Resolution,
} from "mike/shared/work-products.mjs";
import type { CourtRecordDraft } from "mike/shared/court-record-contract.d.ts";
import type { ApplicationScope } from "./applicationError";
import { closed, dictionary, hash, integer, jsonRecord, list, literal, maybe, natural,
  nonempty, nullable, oneOf, tagged, type Check } from "./value";

export { WORK_PRODUCT_KINDS };
export type { WorkProductKind, WorkProductInput, WorkProductState, WorkProductOutput,
  WorkProductOutputRef, ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductMetadata, WorkProductInputResolution } from "mike/shared/work-products.mjs";

/** The bytes a bound local file had when it was last read; an unnamed file is not one. */
export const fileSnapshot = closed<FileSnapshot>({ name: nonempty(500), size: natural,
  modified: natural, sha256: maybe(hash) });
const documentVersion = closed<Exclude<
  Extract<WorkProductInput, { kind: "document" }>["version"], "latest">>({
    versionId: nonempty(200), sha256: hash });
const workProductInput = tagged<WorkProductInput>({
  "local-file": { handleId: nonempty(200), lastSeen: fileSnapshot },
  document: { documentId: nonempty(200),
    version: (value) => value === "latest" || documentVersion(value) },
  "work-product-output": { workProductId: nonempty(200), role: nonempty(100) },
});
const bindings = dictionary<WorkProductInput>(workProductInput, nonempty(200), 500);

export function decodeWorkProductBindings(value: unknown) {
  return bindings(value) ? value : null;
}

const workProductState = (value: unknown): value is WorkProductState => {
  const state = jsonRecord(value);
  return !!state && (state.bindings === undefined || bindings(state.bindings));
};
export function decodeWorkProductState(value: unknown): WorkProductState | null {
  return workProductState(value) ? value : null;
}

const resolvedInput = tagged<ResolvedWorkProductInput>({
  "local-file": { handleId: nonempty(200), filename: nonempty(500), size: natural,
    modified: natural, sha256: hash },
  document: { documentId: nonempty(200), versionId: nonempty(200), filename: nonempty(500),
    sha256: hash },
  "work-product-output": { workProductId: nonempty(200), role: nonempty(100),
    documentId: nonempty(200), versionId: nonempty(200), filename: nonempty(500), sha256: hash },
});

type Receipt = WorkProductBuildReceipt;
const jsonObjectText = (max: number): Check => (value) =>
  typeof value === "string" && value.length <= max &&
  !!jsonRecord((() => { try { return JSON.parse(value); } catch { return null; } })());
const timestamp = (max: number): Check => (value) =>
  nonempty(max)(value) && !Number.isNaN(Date.parse(String(value)));
const receipt = closed<Receipt>({
  schemaVersion: literal("beaver.work-product-build.v2"), builtAt: timestamp(50),
  workProduct: closed<Receipt["workProduct"]>({ id: nonempty(200),
    kind: oneOf(WORK_PRODUCT_KINDS),
    revision: (value) => integer(value) && Number(value) >= 1 }),
  inputs: list(500, closed<Receipt["inputs"][number]>({ role: nonempty(200),
    resolved: resolvedInput })),
  settings: closed<Receipt["settings"]>({ profileId: nullable(nonempty(200)),
    outputMode: nonempty(100), stateSha256: hash, settingsSha256: hash,
    sourceReceiptIds: list(500, nonempty(200)),
    audit: closed<Receipt["settings"]["audit"]>({
      effective: nullable(closed<NonNullable<Receipt["settings"]["audit"]["effective"]>>({
        from: nonempty(50), to: nullable(nonempty(50)) })),
      valuesJson: jsonObjectText(250_000) }) }),
  steps: list(100, nonempty(500)),
  output: closed<Receipt["output"]>({ role: nonempty(100), filename: nonempty(500),
    mimeType: nonempty(200), pageCount: nullable(natural), sha256: hash }),
});

export function decodeWorkProductBuildReceipt(value: unknown): WorkProductBuildReceipt | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return receipt(value) ? value : null;
}

export type WorkProduct = Product<CourtRecordDraft, "court-record"> |
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
