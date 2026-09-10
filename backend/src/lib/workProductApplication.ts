import { ApplicationError, reject, type ApplicationScope } from "./applicationError";
import { decodeAuthoritiesDraft } from "./authoritiesDomain";
import { acceptsWorkProductOutput } from "mike/shared/court-record-work-products.mjs";
import { COURT_PROFILE_BY_ID } from "mike/shared/court-record-profiles.mjs";
import { decodeCourtRecordDraftState } from "./courtRecordContract";
import { createdDocumentRollback, createdVersionRollback, rollbackDocuments,
  type DocumentFile, type DocumentRollback, type DocumentStore } from "./documentStore";
import type { WorkflowFiles } from "./workflowFiles";
import { decodeWorkProductState, workProductInputs,
  type WorkProductBuildReceipt, type WorkProductFailure, type WorkProductKind,
  type WorkProduct, type WorkProductOutputRef, type WorkProductRepository,
  type WorkProductState } from "./workProduct";

function title(value: string) {
  const result = value.trim();
  if (!result || result.length > 300) reject(400, "Draft title is required");
  return result;
}

function state(kind: WorkProductKind, value: unknown): WorkProductState {
  const decoded = decodeWorkProductState(value);
  const name = kind === "court-record" ? "Court Record" : "Authorities";
  if (!decoded) return reject(400, `Invalid ${name} state`);
  const valid = kind === "court-record" ? decodeCourtRecordDraftState(decoded)
    : decodeAuthoritiesDraft(decoded);
  if (!valid) return reject(400, `Invalid ${name} state`);
  if (workProductInputs(valid).some(({ kind: inputKind }) => inputKind === "local-file")) {
    reject(400, "Local file handles belong in the standalone draft store");
  }
  return valid;
}

async function validateCourtRecordOutputs(scope: ApplicationScope, draft: WorkProductState,
  repository: WorkProductRepository) {
  const profile = COURT_PROFILE_BY_ID.get(String(draft.profileId));
  const entries = new Map((draft.entries as Array<{ id: string; kindId: string }>).map(
    ({ id, kindId }) => [id, kindId]));
  const bindings = draft.bindings ?? {};
  const ids = [...new Set(Object.values(bindings).flatMap((input) =>
    input.kind === "work-product-output" ? [input.workProductId] : []))];
  const children = new Map(await Promise.all(ids.map(async (id) =>
    [id, (await repository.get(scope, id))?.product] as const)));
  for (const [entryId, input] of Object.entries(bindings)) {
    if (input.kind !== "work-product-output") continue;
    const child = children.get(input.workProductId);
    const slot = profile?.documentKinds.find(({ id }) => id === entries.get(entryId));
    if (child && (!slot || !acceptsWorkProductOutput(slot, { kind: child.kind,
      profileId: child.kind === "court-record" ? String(child.state.profileId) : undefined,
      role: input.role }))) reject(400, "A saved draft output does not match this Court Record slot");
  }
}

const checked = <T extends WorkProduct>(product: T): T =>
  ({ ...product, state: state(product.kind, product.state) });

const populated = (state: WorkProductState, outputs: Record<string, unknown> = {}) =>
  workProductInputs(state).length > 0 || Object.keys(outputs).length > 0;

function failed(result: WorkProductFailure): never {
  if (result.status === "conflict") throw new ApplicationError(409,
    "This draft changed. Reload it before saving.", {
      current_revision: String(result.revision),
    });
  if (result.status === "cycle") throw new ApplicationError(409,
    "A draft cannot contain itself through another draft.", {
      draft_ids: result.ids.join(","),
    });
  if (result.status === "too-many-dependencies") {
    return reject(400, "This draft contains too many nested drafts");
  }
  if (result.status === "invalid-output") throw new ApplicationError(409,
    "The saved output is not an exact build of this draft.", {
      output_role: result.role,
    });
  const names = { project: "Project", document: "Document",
    "work-product": "Draft", output: "Output" } as const;
  throw new ApplicationError(404, `${names[result.resource]} not found`, {
    resource_id: result.id,
  });
}

export function createWorkProductApplication(repository: WorkProductRepository) {
  const created = (result: Awaited<ReturnType<WorkProductRepository["create"]>>) =>
    result.status === "created" ? result.product : failed(result);
  return Object.freeze({
    async list(scope: ApplicationScope, options: {
      kind?: WorkProductKind; projectId?: string; limit?: number; metadata?: boolean;
    } = {}) {
      const products = await repository.list(scope, {
        ...options, limit: options.limit ?? (options.metadata ? undefined : 50),
      });
      // A draft the current contract can no longer read is left out of the survey rather
      // than failing it: opening that draft still reports the problem on its own.
      return products.map((product) => {
        if (!("state" in product)) return product;
        try { return checked(product); } catch { return undefined; }
      }).filter((product) => product !== undefined);
    },
    async get(scope: ApplicationScope, id: string) {
      const product = (await repository.get(scope, id))?.product ??
        reject(404, "Draft not found");
      return checked(product);
    },
    async resolve(scope: ApplicationScope, id: string) {
      const result = await repository.resolve(scope, id);
      return "product" in result ? { ...result, product: checked(result.product) } : failed(result);
    },
    async create(scope: ApplicationScope, input: {
      kind: WorkProductKind; title: string; projectId?: string | null; state?: unknown;
    }) {
      const name = title(input.title), projectId = input.projectId ?? null;
      const initial = input.state === undefined
        ? reject(400, "Draft state is required")
        : state(input.kind, input.state);
      if (input.kind === "court-record") {
        await validateCourtRecordOutputs(scope, initial, repository);
      }
      return created(await repository.create(scope, {
        kind: input.kind, title: name, projectId, state: initial,
      }));
    },
    async save(scope: ApplicationScope, id: string, input: {
      revision: number; title?: string; projectId?: string | null; state?: unknown;
      outputs?: Record<string, WorkProductOutputRef>;
    }) {
      const found = await repository.get(scope, id);
      if (!found) throw new ApplicationError(404, "Draft not found");
      const nextState = input.state === undefined ? found.product.state
        : state(found.product.kind, input.state);
      if (input.projectId !== undefined && input.projectId !== found.product.projectId &&
          populated(nextState, input.outputs ?? found.product.outputs)) {
        reject(409, "Remove this draft's inputs and outputs before moving it to another matter");
      }
      if (found.product.kind === "court-record") {
        await validateCourtRecordOutputs(scope, nextState, repository);
      }
      const result = await repository.save(scope, id, {
        ...input,
        title: input.title === undefined ? undefined : title(input.title),
        state: input.state === undefined ? undefined : nextState,
      });
      return result.status === "saved" ? result.product : failed(result);
    },
    async duplicate(scope: ApplicationScope, id: string, input: {
      title?: string; projectId?: string | null;
    } = {}) {
      const source = checked((await repository.get(scope, id))?.product ??
        reject(404, "Draft not found"));
      const copyState = source.state;
      const projectId = input.projectId === undefined ? source.projectId : input.projectId;
      if (projectId !== source.projectId && populated(copyState)) {
        reject(409, "Remove this draft's inputs before copying it to another matter");
      }
      return created(await repository.create(scope, {
        kind: source.kind,
        title: title(input.title ?? `${source.title.slice(0, 295)} copy`),
        projectId,
        state: copyState,
      }));
    },
    async remove(scope: ApplicationScope, id: string) {
      if (!await repository.remove(scope, id)) reject(404, "Draft not found");
    },
  });
}

export type WorkProductApplication = ReturnType<typeof createWorkProductApplication>;

export async function saveWorkProductBuild(
  { documents, files, workProducts }: { documents: DocumentStore; files: WorkflowFiles;
    workProducts: Pick<WorkProductApplication, "save"> },
  scope: ApplicationScope, product: WorkProduct,
  artifacts: Array<{ role: string; file: DocumentFile; receipt: WorkProductBuildReceipt }>,
  options: { state?: WorkProductState; signal?: AbortSignal } = {},
) {
  const outputs: Record<string, WorkProductOutputRef> = {};
  const rollback: DocumentRollback[] = [];
  try {
    for (const { role, file, receipt } of artifacts) {
      options.signal?.throwIfAborted();
      const expectedSha256 = file.expectedSha256 ?? receipt.output.sha256;
      const output = { ...file, expectedSha256,
        provenance: { schemaVersion: 1 as const, actor: "work-product" as const,
          action: "built" as const, receipt } };
      const existing = product.outputs[role];
      const version = existing ? await documents.addVersion(scope, existing.documentId, {
        ...output, expectedCurrentVersionId: existing.versionId,
        expectedCurrentSha256: existing.sha256,
      }) : null;
      if (version) {
        rollback.push(createdVersionRollback(existing!.documentId, version));
        if (version.source_sha256 !== expectedSha256)
          throw new Error("Saved output hash does not match its build");
        outputs[role] = { documentId: existing!.documentId, versionId: version.id };
      } else {
        if (existing && await documents.metadata(scope, existing.documentId))
          throw new ApplicationError(409, "An output changed while the new build was being saved");
        const created = await files.create(scope,
          product.kind === "court-record" ? "court-records" : "authorities", output,
          { projectId: product.projectId });
        rollback.push(createdDocumentRollback(created));
        if (!created.current_version_id || created.source_sha256 !== expectedSha256)
          throw new Error("Saved output hash does not match its build");
        outputs[role] = { documentId: created.id, versionId: created.current_version_id };
      }
    }
    options.signal?.throwIfAborted();
    const saved = await workProducts.save(scope, product.id, { revision: product.revision,
      outputs, ...(options.state === undefined ? {} : { state: options.state }) });
    if (saved.kind !== product.kind) throw new ApplicationError(409, "Draft state is invalid");
    return saved;
  } catch (error) {
    return rollbackDocuments(documents, scope, rollback, error,
      "Build outputs could not be saved or rolled back");
  }
}
