import { ApplicationError, reject, type ApplicationScope } from "./applicationError";
import { decodeAuthoritiesDraft } from "./authoritiesDomain";
import { decodeCourtRecordDraftState } from "./courtRecordContract";
import { decodeResearchSetState, recordResearchSetAudit, reduceResearchSet,
  type ResearchSetAction, type ResearchSetActor } from "./researchSet";
import { decodeWorkProductState, workProductInputs,
  type WorkProductFailure, type WorkProductKind,
  type WorkProduct, type WorkProductOutputRef, type WorkProductRepository,
  type WorkProductState } from "./workProduct";

function title(value: string) {
  const result = value.trim();
  if (!result || result.length > 300) reject(400, "Draft title is required");
  return result;
}

function state(kind: WorkProductKind, value: unknown): WorkProductState {
  const decoded = decodeWorkProductState(value);
  const name = kind === "court-record" ? "Court Record" : kind === "authorities"
    ? "Authorities" : "research set";
  if (!decoded) return reject(400, `Invalid ${name} state`);
  const valid = kind === "court-record" ? decodeCourtRecordDraftState(decoded)
    : kind === "authorities" ? decodeAuthoritiesDraft(decoded) : decodeResearchSetState(decoded);
  if (!valid) return reject(400, `Invalid ${name} state`);
  if (workProductInputs(valid).some(({ kind: inputKind }) => inputKind === "local-file")) {
    reject(400, "Local file handles belong in the standalone draft store");
  }
  return valid;
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
      const products = await repository.list(scope, { ...options, limit: options.limit ?? 50 });
      return products.map((product) => "state" in product ? checked(product) : product);
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
      if (found.product.kind === "research-set" && input.state !== undefined) {
        reject(400, "Use research actions to edit saved research");
      }
      const nextState = input.state === undefined ? found.product.state
        : state(found.product.kind, input.state);
      if (input.projectId !== undefined && input.projectId !== found.product.projectId &&
          populated(nextState, input.outputs ?? found.product.outputs)) {
        reject(409, "Remove this draft's inputs and outputs before moving it to another matter");
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
      const source = (await repository.get(scope, id))?.product ??
        reject(404, "Draft not found");
      const copyState = source.kind === "research-set"
        ? recordResearchSetAudit(source.state, { kind: "human", id: scope.userId },
          "duplicate", [source.id]) : source.state;
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
    async applyResearchSetAction(scope: ApplicationScope, id: string, input: {
      revision: number; action: ResearchSetAction;
    }, actor: ResearchSetActor = { kind: "human", id: scope.userId }) {
      const found = await repository.get(scope, id);
      if (!found) throw new ApplicationError(404, "Research set not found");
      if (found.product.kind !== "research-set") reject(404, "Research set not found");
      const next: WorkProductState = (() => {
        try { return reduceResearchSet(found.product.state, input.action, actor); }
      catch (error) {
          throw new ApplicationError(400,
            error instanceof Error ? error.message : "Invalid research action");
        }
      })();
      const result = await repository.save(scope, id,
        { revision: input.revision, state: next });
      return result.status === "saved" ? result.product : failed(result);
    },
  });
}

export type WorkProductApplication = ReturnType<typeof createWorkProductApplication>;
