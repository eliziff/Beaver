import { z } from "zod";
import { sha256, canonicalJsonSha256, deterministicUuid } from "./hash";
import { documentFileType, validateDocumentFile, isPlainTextDocumentType } from "./documentTypes";
import { resourceReference } from "./resourceReferences";
import type { WorkflowStore } from "./chat/types";
import bundledAssets from "./systemWorkflowAssets.json";
import type { ObjectStorage } from "./storage";
import { SYSTEM_WORKFLOWS, SYSTEM_WORKFLOW_SNAPSHOT, WORKFLOW_AUDIENCES, WORKFLOW_CATEGORIES, assistantWorkflows,
  type SystemWorkflow } from "./systemWorkflows";

const id = z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/u);
const text = z.string().max(1_000_000);
const variant = z.object({ id, label: text, description: text.nullable().optional(),
  result: text.nullable(), execution: z.enum(["assistant", "tabular"]), skill_md: text.nullable(),
  columns_config: z.array(z.object({ index: z.number().int().nonnegative(), name: text,
    format: text.optional(), prompt: text, tags: z.array(text).optional() }).strict()).max(200).nullable(),
}).strict();
const workflowSchema = z.object({ id, user_id: z.null(), is_system: z.literal(true),
  created_at: z.string().datetime(), metadata: z.object({ title: text, description: text,
    category: z.enum(WORKFLOW_CATEGORIES), audiences: z.array(z.enum(WORKFLOW_AUDIENCES)).min(1),
    contributors: z.array(z.object({ name: text, organisation: text.nullable(), role: text.nullable(),
      linkedin: text.nullable() }).strict()), language: text, version: text, jurisdictions: z.array(text),
  }).strict(), launcher: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("instructions"), variants: z.array(variant).min(1) }).strict(),
    z.object({ kind: z.literal("quote_check"), variants: z.array(variant).min(1) }).strict(),
    z.object({ kind: z.literal("authorities") }).strict(),
    z.object({ kind: z.literal("court_records") }).strict(),
    z.object({ kind: z.literal("fix_supras") }).strict(),
  ]),
}).strict();
const assetSchema = z.object({ workflowId: id, variantId: id.optional(),
  filename: z.string().min(1).max(255).regex(/^[^\\/\u0000-\u001f\u007f]+$/u)
    .refine((value) => value !== "." && value !== ".."),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  contentType: z.string().min(1).max(150).regex(/^[\w.+-]+\/[\w.+-]+$/u),
}).strict();
const snapshotSchema = z.object({ schemaVersion: z.literal(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  workflows: z.array(workflowSchema).min(1).max(10_000),
  assets: z.array(assetSchema).max(1_000),
}).strict();

export type WorkflowCatalogSnapshot = z.infer<typeof snapshotSchema>;
export type WorkflowCatalogRepository = {
  read(): Promise<WorkflowCatalogSnapshot | null>;
  replace(snapshot: WorkflowCatalogSnapshot, contentHash: string): Promise<void>;
};
const assetKey = (hash: string) => `workflow-catalog/${hash}`;

export function validateWorkflowCatalog(input: unknown): WorkflowCatalogSnapshot {
  const snapshot = snapshotSchema.parse(input);
  const ids = new Set<string>(), variants = new Set<string>(), assets = new Set<string>();
  for (const workflow of snapshot.workflows) {
    if (ids.has(workflow.id)) throw new Error(`Duplicate workflow: ${workflow.id}`);
    ids.add(workflow.id);
    if (!("variants" in workflow.launcher)) continue;
    for (const item of workflow.launcher.variants) {
      if (variants.has(item.id)) throw new Error(`Duplicate workflow variant: ${item.id}`);
      variants.add(item.id);
      if (item.execution === "assistant" && !item.skill_md?.trim())
        throw new Error(`Workflow ${item.id} has no instructions`);
      if (item.execution === "tabular" && !item.columns_config?.length)
        throw new Error(`Workflow ${item.id} has no columns`);
      const names = new Set<string>();
      item.columns_config?.forEach((column, index) => {
        if (column.index !== index || !column.name.trim() || !column.prompt.trim() || names.has(column.name))
          throw new Error(`Invalid columns in workflow ${item.id}`);
        names.add(column.name);
      });
    }
  }
  for (const asset of snapshot.assets) {
    if (!documentFileType(asset.filename).ok) throw new Error(`Unsupported workflow reference: ${asset.filename}`);
    const key = `${asset.workflowId}\0${asset.filename}`;
    if (!ids.has(asset.workflowId) || assets.has(key)) throw new Error("Invalid workflow asset binding");
    const owner = snapshot.workflows.find((workflow) => workflow.id === asset.workflowId)!;
    if (asset.variantId && (!("variants" in owner.launcher) ||
        !owner.launcher.variants.some((variant) => variant.id === asset.variantId)))
      throw new Error("Invalid workflow asset variant binding");
    assets.add(key);
  }
  // Catalogue updates cannot remove native application launchers or change
  // their identity. These are capabilities, not downloadable instructions.
  for (const builtin of SYSTEM_WORKFLOWS.filter((w) => w.launcher.kind !== "instructions")) {
    const candidate = snapshot.workflows.find((w) => w.id === builtin.id);
    if (!candidate || candidate.launcher.kind !== builtin.launcher.kind)
      throw new Error(`Catalogue must retain the ${builtin.id} launcher`);
  }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 16 * 1024 * 1024)
    throw new Error("Workflow catalogue exceeds 16 MiB");
  return snapshot;
}

export function createWorkflowCatalog(repository: WorkflowCatalogRepository, objects: ObjectStorage) {
  const current = async () => await repository.read() ?? validateWorkflowCatalog(SYSTEM_WORKFLOW_SNAPSHOT);
  const workflows = async (): Promise<SystemWorkflow[]> =>
    (await current())?.workflows ?? SYSTEM_WORKFLOWS;
  const catalog = {
    current, workflows,
    async assistants(): Promise<WorkflowStore> {
      const snapshot = await current();
      return new Map(assistantWorkflows(snapshot?.workflows ?? SYSTEM_WORKFLOWS).map((workflow) => [
        workflow.variant_id, { workflow_id: workflow.id, title: workflow.title, skill_md: workflow.skill_md,
          references: (snapshot?.assets ?? []).filter((asset) => asset.workflowId === workflow.id &&
            (!asset.variantId || asset.variantId === workflow.variant_id))
            .map((asset) => ({ filename: asset.filename,
              resource: resourceReference.workflowReference(workflow.variant_id, asset.filename),
              async read() {
                const stored = await catalog.asset(workflow.id, asset.filename, snapshot);
                if (!stored) throw new Error("Workflow reference unavailable");
                const type = documentFileType(asset.filename);
                if (!type.ok) throw new Error(type.error);
                if (isPlainTextDocumentType(type.fileType)) return stored.bytes.toString("utf8");
                const { documentProjectionService } = await import("./documentProjectionService");
                const { structureNative } = await import("./structureNative");
                const document = await documentProjectionService.read({
                  documentId: deterministicUuid(`workflow-reference:${asset.sha256}`),
                  versionId: deterministicUuid(`workflow-reference-version:${asset.sha256}`),
                  sourceSha256: asset.sha256, fileType: type.fileType,
                  readBytes: async () => stored.bytes,
                });
                return structureNative().documentText(document);
              },
            })),
        },
      ]));
    },
    async install(input: unknown, readAsset: (hash: string) => Promise<Buffer>) {
      const snapshot = validateWorkflowCatalog(input);
      if (snapshot.assets.reduce((size, asset) => size + asset.sizeBytes, 0) > 512 * 1024 * 1024)
        throw new Error("Workflow assets exceed 512 MiB");
      for (const asset of snapshot.assets) {
        const bytes = await readAsset(asset.sha256);
        if (bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.sha256)
          throw new Error(`Workflow asset integrity check failed: ${asset.filename}`);
        const validation = validateDocumentFile(asset.filename, bytes);
        if (!validation.ok) throw new Error(`Invalid workflow reference ${asset.filename}: ${validation.error}`);
        await objects.put(assetKey(asset.sha256), bytes, asset.contentType,
          { expectedSha256: asset.sha256 });
      }
      // Only publish after every asset is durable. Readers see the complete
      // old or new snapshot, including from another backend process.
      await repository.replace(snapshot, canonicalJsonSha256(snapshot));
      return { sourceCommit: snapshot.sourceCommit, workflows: snapshot.workflows.length,
        assets: snapshot.assets.length };
    },
    async asset(workflowId: string, filename: string, snapshot?: WorkflowCatalogSnapshot | null):
      Promise<(WorkflowCatalogSnapshot["assets"][number] & { bytes: Buffer }) | null> {
      const asset = (snapshot ?? await current())?.assets.find((item) =>
        item.workflowId === workflowId && item.filename === filename);
      if (!asset) return null;
      const bundled = (bundledAssets as Record<string, string>)[asset.sha256];
      const bytes = bundled ? Buffer.from(bundled, "base64")
        : await objects.get(assetKey(asset.sha256), { maxBytes: asset.sizeBytes });
      if (!bytes || bytes.length !== asset.sizeBytes || sha256(bytes) !== asset.sha256)
        throw new Error("Stored workflow asset failed integrity verification");
      return { ...asset, bytes };
    },
  };
  return catalog;
}
export type WorkflowCatalog = ReturnType<typeof createWorkflowCatalog>;
