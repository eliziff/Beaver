import { randomUUID } from "node:crypto";
import type { ApplicationScope } from "./applicationError";
import { contentTypeForDocumentType } from "./documentTypes";
import { canonicalJsonSha256 } from "./hash";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql,
  type RelationalDatabase } from "./relationalDatabase";
import { changes, documentAccess, one, projectAccess, rows,
  type Row } from "./relationalRepositorySupport";
import { decodeWorkProductBuildReceipt, workProductInputs,
  type ResolvedWorkProductInput, type WorkProduct, type WorkProductBuildReceipt,
  type WorkProductFailure, type WorkProductInput, type WorkProductInputResolution,
  type WorkProductOutput, type WorkProductOutputRef, type WorkProductRepository,
  type WorkProductMetadata, type WorkProductResolution, type WorkProductState } from "./workProduct";

const access = (scope: ApplicationScope) => sql`(w.user_id=${scope.userId} OR
  (w.project_id IS NOT NULL AND EXISTS(SELECT 1 FROM projects p
    WHERE p.id=w.project_id AND ${projectAccess(scope)})))`;

const profileMetadata = (row: Row) => {
  const profileId = row.kind === "authorities" ? undefined
    : typeof row.profile_id === "string" ? row.profile_id
      : decode<Record<string, unknown>>(row.state_json, {}).profileId;
  return typeof profileId === "string" ? { profileId } : {};
};
const metadata = (row: Row): WorkProductMetadata => ({
  id: String(row.id),
  kind: row.kind === "authorities" ? row.kind : "court-record",
  title: String(row.title),
  projectId: typeof row.project_id === "string" ? row.project_id : null,
  revision: Number(row.revision),
  outputs: decode<Record<string, WorkProductOutput>>(row.outputs_json, {}),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  ...profileMetadata(row),
});
const product = (row: Row): WorkProduct => ({ ...metadata(row),
  state: decode<WorkProductState>(row.state_json, {}),
} as WorkProduct);

async function find(scope: ApplicationScope, id: string, db: RelationalDatabase) {
  const row = await one(sql`SELECT w.*,
    CASE WHEN w.user_id=${scope.userId} THEN 1 ELSE 0 END is_owner
    FROM work_products w WHERE w.id=${id} AND ${access(scope)}`, db);
  return row ? { product: product(row), isOwner: Boolean(row.is_owner) } : null;
}

const projectAvailable = async (scope: ApplicationScope, id: string | null,
  db: RelationalDatabase) => !id || !!await one(sql`SELECT 1 ok FROM projects p WHERE p.id=${id}
    AND ${projectAccess(scope)}`, db);

async function validateBindings(scope: ApplicationScope, state: WorkProductState,
  projectId: string | null, db: RelationalDatabase): Promise<WorkProductFailure | null> {
  const bindings = workProductInputs(state);
  const documents = bindings.filter((item) => item.kind === "document");
  const documentIds = [...new Set(documents.map(({ documentId }) => documentId))];
  if (documentIds.length) {
    const found = new Set((await rows<{ id: string }>(sql`SELECT d.id FROM documents d
      WHERE d.id IN(${sql.join(documentIds)}) AND ${documentAccess(scope)}
        AND (d.project_id IS NULL OR d.project_id=${projectId})`, db))
      .map(({ id }) => id));
    const missing = documentIds.find((id) => !found.has(id));
    if (missing) return { status: "missing", resource: "document", id: missing };
    const pinned = documents.filter((item) => item.version !== "latest");
    if (pinned.length) {
      const versionIds = pinned.map(({ version }) => version === "latest" ? "" : version.versionId);
      const versions = await rows<{ document_id: string; version_id: string;
        source_sha256: string }>(sql`SELECT d.id document_id,v.id version_id,v.source_sha256
        FROM documents d JOIN document_versions v ON v.document_id=d.id
        WHERE v.id IN(${sql.join(versionIds)}) AND ${documentAccess(scope)}`, db);
      const foundVersions = new Map(versions.map((row) =>
        [`${row.document_id}:${row.version_id}`, row.source_sha256]));
      const invalid = pinned.find(({ documentId, version }) => version !== "latest" &&
        foundVersions.get(`${documentId}:${version.versionId}`) !== version.sha256);
      if (invalid) return { status: "missing", resource: "document", id: invalid.documentId };
    }
  }
  const nested = [...new Set(bindings.flatMap((item) => item.kind === "work-product-output"
    ? [item.workProductId] : []))];
  if (nested.length) {
    const found = new Set((await rows<{ id: string }>(sql`SELECT w.id FROM work_products w
      WHERE w.id IN(${sql.join(nested)}) AND ${access(scope)}
        AND COALESCE(w.project_id,'')=${projectId ?? ""}`, db)).map(({ id }) => id));
    const missing = nested.find((id) => !found.has(id));
    if (missing) return { status: "missing", resource: "work-product", id: missing };
  }
  return null;
}

async function cycle(scope: ApplicationScope, rootId: string, state: WorkProductState,
  db: RelationalDatabase): Promise<WorkProductFailure | null> {
  const direct = workProductInputs(state).flatMap((item) => item.kind === "work-product-output"
    ? [item.workProductId] : []);
  const seen = new Set<string>();
  async function visit(id: string, path: string[]): Promise<string[] | null> {
    if (id === rootId) return [...path, id];
    if (seen.has(id)) return null;
    seen.add(id);
    if (seen.size > 1_000) return [];
    const row = await one<{ state_json: unknown }>(sql`SELECT w.state_json FROM work_products w
      WHERE w.id=${id} AND ${access(scope)}`, db);
    if (!row) return null;
    for (const next of workProductInputs(decode<WorkProductState>(row.state_json, {}))
      .flatMap((item) => item.kind === "work-product-output" ? [item.workProductId] : [])) {
      const found = await visit(next, [...path, id]);
      if (found) return found;
    }
    return null;
  }
  for (const id of direct) {
    const found = await visit(id, [rootId]);
    if (found) return found.length
      ? { status: "cycle", ids: found }
      : { status: "too-many-dependencies" };
  }
  return null;
}

async function validate(scope: ApplicationScope, id: string, state: WorkProductState,
  projectId: string | null, db: RelationalDatabase): Promise<WorkProductFailure | null> {
  return !await projectAvailable(scope, projectId, db)
    ? { status: "missing", resource: "project", id: projectId! }
    : await validateBindings(scope, state, projectId, db) ?? await cycle(scope, id, state, db);
}

type VersionRow = { document_id: string; version_id: string; filename: string;
  file_type: string; page_count: number | null; source_sha256: string; provenance: unknown };

async function version(scope: ApplicationScope, documentId: string, versionId: string | null,
  db: RelationalDatabase) {
  return one<VersionRow>(sql`SELECT d.id document_id,v.id version_id,v.filename,v.file_type,
    v.page_count,v.source_sha256,v.provenance FROM documents d JOIN document_versions v
      ON v.document_id=d.id AND v.id=COALESCE(${versionId},d.current_version_id)
    WHERE d.id=${documentId} AND ${documentAccess(scope)}`, db);
}

async function builtOutput(scope: ApplicationScope, role: string, ref: WorkProductOutputRef,
  db: RelationalDatabase) {
  const row = await version(scope, ref.documentId, ref.versionId, db);
  const provenance = row && decode<Record<string, unknown> | null>(row.provenance, null);
  const receipt = provenance?.actor === "work-product" && provenance.action === "built"
    ? decodeWorkProductBuildReceipt(provenance.receipt) : null;
  if (!row || !receipt || receipt.output.role !== role ||
      receipt.output.filename !== row.filename || receipt.output.sha256 !== row.source_sha256 ||
      receipt.output.mimeType !== contentTypeForDocumentType(row.file_type) ||
      row.page_count !== null && receipt.output.pageCount !== Number(row.page_count)) return null;
  return { output: { documentId: row.document_id, versionId: row.version_id,
    sha256: row.source_sha256, filename: row.filename,
    mimeType: contentTypeForDocumentType(row.file_type), pageCount: receipt.output.pageCount },
  receipt };
}

async function exactOutput(scope: ApplicationScope, role: string, expected: WorkProductOutput,
  db: RelationalDatabase) {
  const built = await builtOutput(scope, role, expected, db);
  return built && Object.entries(expected).every(([key, value]) =>
    built.output[key as keyof WorkProductOutput] === value) ? built : null;
}

const sameResolved = (left: ResolvedWorkProductInput, right: ResolvedWorkProductInput) =>
  JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

function receiptInputs(receipt: WorkProductBuildReceipt) {
  const result = new Map(receipt.inputs.map(({ role, resolved }) => [role, resolved]));
  return result.size === receipt.inputs.length ? result : null;
}

const currentInput = (value: WorkProductInputResolution) =>
  value.status === "ready" || value.status === "review" ? value.resolved
    : value.status === "changed" ? value.current : null;

const missingInput = (input: WorkProductInput,
  reason: "deleted" | "unavailable", resource: "document" | "work-product" | "output", id: string):
  WorkProductInputResolution => ({ status: "missing", input, reason, resource, id });

function matchesBuild(receipt: WorkProductBuildReceipt, product: WorkProduct,
  inputs: Record<string, WorkProductInputResolution>, revision: number) {
  if (receipt.workProduct.id !== product.id || receipt.workProduct.kind !== product.kind ||
      receipt.workProduct.revision !== revision ||
      receipt.settings.stateSha256 !== canonicalJsonSha256(product.state)) return false;
  const expected = receiptInputs(receipt), bindings = Object.keys(product.state.bindings ?? {});
  return !!expected && expected.size === bindings.length && bindings.every((role) => {
    const status = inputs[role], resolved = status && currentInput(status);
    return expected.has(role) && !!resolved && status.status !== "review" &&
      sameResolved(expected.get(role)!, resolved);
  });
}

function withPrevious(input: WorkProductInput, current: ResolvedWorkProductInput,
  previous?: ResolvedWorkProductInput): WorkProductInputResolution {
  return previous && !sameResolved(previous, current)
    ? { status: "changed", input, previous, current }
    : { status: "ready", input, resolved: current };
}

async function resolveProduct(scope: ApplicationScope, product: WorkProduct,
  db: RelationalDatabase, memo: Map<string, WorkProductResolution>, path: string[]):
  Promise<WorkProductResolution | WorkProductFailure> {
  if (path.includes(product.id)) return { status: "cycle", ids: [...path, product.id] };
  const cached = memo.get(product.id);
  if (cached) return cached;
  const verifiedOutputs = await Promise.all(Object.entries(product.outputs).map(
    ([role, output]) => exactOutput(scope, role, output, db),
  ));
  const receipts = verifiedOutputs.flatMap((value) => value ? [value.receipt] : [])
    .filter((receipt) => receipt.workProduct.id === product.id &&
      receipt.workProduct.kind === product.kind)
    .sort((left, right) => right.builtAt.localeCompare(left.builtAt));
  const previous = receipts[0] ? receiptInputs(receipts[0]) : null;
  const inputs: Record<string, WorkProductInputResolution> = {}, dependencies = new Set<string>();
  for (const [role, input] of Object.entries(product.state.bindings ?? {})) {
    if (input.kind === "local-file") {
      inputs[role] = missingInput(input, "unavailable", "document", input.handleId);
      continue;
    }
    if (input.kind === "document") {
      const row = await version(scope, input.documentId,
        input.version === "latest" ? null : input.version.versionId, db);
      if (!row || input.version !== "latest" && row.source_sha256 !== input.version.sha256) {
        inputs[role] = missingInput(input, "deleted", "document", input.documentId);
        continue;
      }
      inputs[role] = withPrevious(input, { kind: "document", documentId: row.document_id,
        versionId: row.version_id, filename: row.filename, sha256: row.source_sha256 },
      previous?.get(role));
      continue;
    }
    const child = await find(scope, input.workProductId, db);
    if (!child) {
      inputs[role] = missingInput(input, "deleted", "work-product", input.workProductId);
      continue;
    }
    const nested = await resolveProduct(scope, child.product, db, memo, [...path, product.id]);
    if (!("product" in nested)) return nested;
    for (const id of [...nested.dependencies, child.product.id]) {
      dependencies.add(id);
    }
    if (dependencies.size > 1_000) return { status: "too-many-dependencies" };
    const output = child.product.outputs[input.role];
    const exact = output && await exactOutput(scope, input.role, output, db);
    if (!exact) {
      inputs[role] = missingInput(input, "unavailable", "output",
        `${input.workProductId}:${input.role}`);
      continue;
    }
    const resolved: ResolvedWorkProductInput = { kind: "work-product-output",
      workProductId: input.workProductId, role: input.role,
      documentId: exact.output.documentId, versionId: exact.output.versionId,
      filename: exact.output.filename, sha256: exact.output.sha256 };
    inputs[role] = nested.freshness === "current"
      ? withPrevious(input, resolved, previous?.get(role))
      : { status: "review", input, reason: "nested-draft-stale",
        workProductId: input.workProductId, resolved };
  }
  const freshness = verifiedOutputs.length === 0 ? "unbuilt" :
    verifiedOutputs.every((value) => value && matchesBuild(
      value.receipt, product, inputs, product.revision - 1,
    )) ? "current" : "stale";
  const result: WorkProductResolution = { product, freshness, inputs,
    dependencies: [...dependencies] };
  memo.set(product.id, result);
  return result;
}

async function outputs(scope: ApplicationScope, product: WorkProduct,
  refs: Record<string, WorkProductOutputRef>, db: RelationalDatabase):
  Promise<{ outputs: Record<string, WorkProductOutput> } | WorkProductFailure> {
  const resolution = await resolveProduct(scope, product, db, new Map(), []);
  if (!("product" in resolution)) return resolution;
  const result: Record<string, WorkProductOutput> = {}, documentIds = new Set<string>();
  for (const [role, ref] of Object.entries(refs)) {
    if (documentIds.has(ref.documentId)) return { status: "invalid-output", role };
    documentIds.add(ref.documentId);
    const built = await builtOutput(scope, role, ref, db), current = product.outputs[role];
    const changed = !current || current.documentId !== ref.documentId ||
      current.versionId !== ref.versionId;
    const priorAvailable = current && current.documentId !== ref.documentId &&
      await exactOutput(scope, role, current, db);
    if (!built || priorAvailable || changed &&
          !matchesBuild(built.receipt, product, resolution.inputs, product.revision)) {
      return { status: "invalid-output", role };
    }
    result[role] = built.output;
  }
  return { outputs: result };
}

export const workProductRepository: WorkProductRepository = {
  async list(scope, options) {
    const result = await rows(sql`SELECT ${options.metadata ? sql.raw(
      "w.id,w.kind,w.title,w.project_id,w.revision,w.outputs_json,w.created_at,w.updated_at,w.state_json->>'profileId' profile_id") : sql.raw("w.*")}
      FROM work_products w WHERE ${access(scope)}
      ${options.kind ? sql`AND w.kind=${options.kind}` : sql.raw("")}
      ${options.projectId ? sql`AND w.project_id=${options.projectId}` : sql.raw("")}
      ORDER BY w.updated_at DESC,w.id DESC
      ${options.limit === undefined ? sql.raw("") : sql`LIMIT ${options.limit}`}`);
    return result.map(options.metadata ? metadata : product);
  },
  async get(scope, id) {
    return find(scope, id, await relationalDatabase());
  },
  async resolve(scope, id) {
    const db = await relationalDatabase(), found = await find(scope, id, db);
    return found ? resolveProduct(scope, found.product, db, new Map(), [])
      : { status: "missing", resource: "work-product", id };
  },
  async create(scope, input) {
    const db = await relationalDatabase(), id = randomUUID(), created = new Date().toISOString();
    return db.transaction(async (tx) => {
      const invalid = await validate(scope, id, input.state, input.projectId, tx);
      if (invalid) return invalid;
      await changes(sql`INSERT INTO work_products(id,user_id,project_id,kind,title,state_json,
        outputs_json,revision,created_at,updated_at) VALUES(${id},${scope.userId},
        ${input.projectId},${input.kind},${input.title},${encode(input.state)},${encode({})},
        1,${created},${created})`, tx);
      return { status: "created", product: (await find(scope, id, tx))!.product };
    });
  },
  async save(scope, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      // ponytail: one graph-write lock keeps cycle checks atomic; split it only if draft writes contend.
      if (tx.engine === "postgres") await tx.query(sql.raw(
        "LOCK TABLE work_products IN SHARE ROW EXCLUSIVE MODE",
      ));
      const current = await find(scope, id, tx);
      if (!current) return { status: "missing", resource: "work-product", id };
      if (current.product.revision !== input.revision) {
        return { status: "conflict", revision: current.product.revision };
      }
      const projectId = input.projectId === undefined
        ? current.product.projectId : input.projectId;
      if (projectId !== current.product.projectId && !current.isOwner) {
        return { status: "missing", resource: "work-product", id };
      }
      const state = input.state ?? current.product.state;
      const invalid = await validate(scope, id, state, projectId, tx);
      if (invalid) return invalid;
      const next = { ...current.product, projectId,
        title: input.title ?? current.product.title, state } as WorkProduct;
      const resolved = input.outputs === undefined
        ? { outputs: current.product.outputs }
        : await outputs(scope, next, input.outputs, tx);
      if ("status" in resolved) return resolved;
      const updated = new Date().toISOString();
      const changed = await changes(sql`UPDATE work_products SET
        project_id=${projectId},title=${next.title},
        state_json=${encode(state)},outputs_json=${encode(resolved.outputs)},
        revision=revision+1,updated_at=${updated}
        WHERE id=${id} AND revision=${input.revision}`, tx);
      if (!changed) {
        const latest = await find(scope, id, tx);
        return latest ? { status: "conflict", revision: latest.product.revision }
          : { status: "missing", resource: "work-product", id };
      }
      return { status: "saved", product: (await find(scope, id, tx))!.product };
    });
  },
  async remove(scope, id) {
    return await changes(sql`DELETE FROM work_products WHERE id=${id}
      AND user_id=${scope.userId}`) > 0;
  },
};
