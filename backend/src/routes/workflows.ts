import { Router } from "express";
import { z } from "zod";
import { applicationScope, notFound as missing, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { textField } from "../lib/textField";
import { downloadHeaders } from "../lib/storage";
import type { WorkflowCatalog, WorkflowCatalogSnapshot } from "../lib/workflowCatalog";
import {
  SYSTEM_WORKFLOWS,
  WORKFLOW_AUDIENCES,
  WORKFLOW_CATEGORIES,
  workflowVisibleTo,
  type InstructionVariant,
  type SystemWorkflow,
  type WorkflowContributor,
} from "../lib/systemWorkflows";
import { tabularDtos } from "../lib/tabular/application";
import type {
  CreateWorkflowRepository,
  WorkflowCollaboration,
  WorkflowRecord,
  WorkflowUpdate,
} from "../lib/workflowRepository";
import { requireAuth } from "../middleware/auth";
import type { DocumentStore } from "../lib/documentStore";

const DEFAULT_CONTRIBUTOR: WorkflowContributor = {
  name: "Beaver", organisation: null, role: null, linkedin: null,
};
const DEFAULT_LANGUAGE = "English";
const DEFAULT_JURISDICTIONS = ["General"];
const CONTRIBUTIONS_ENABLED = process.env.WORKFLOW_CONTRIBUTIONS_ENABLED === "true";
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const contributorSchema = z.object({
  name: textField(200),
  organisation: z.string().trim().max(200).nullable().default(null),
  role: z.string().trim().max(200).nullable().default(null),
  linkedin: z.string().trim().max(2_000).nullable().default(null),
}).strict();
const audienceSchema = z.enum(WORKFLOW_AUDIENCES);
const metadataSchema = z.object({
  title: textField(300),
  category: z.enum(WORKFLOW_CATEGORIES),
  audiences: z.array(audienceSchema).min(1).max(WORKFLOW_AUDIENCES.length)
    .transform((items) => [...new Set(items)]),
  language: optionalText(100),
  jurisdictions: z.array(textField(100)).max(50).nullable().optional()
    .transform((items) => items?.length ? [...new Set(items)] : null),
}).strict();
const instructionInputSchema = z.object({
  label: textField(200),
  result: optionalText(200),
  execution: z.enum(["assistant", "tabular"]),
  skill_md: z.string().max(1_000_000).nullable().optional(),
  columns_config: tabularDtos.create.shape.columns_config.nullable().optional(),
}).strict();
const launcherInputSchema = z.object({
  kind: z.literal("instructions"),
  variants: z.array(instructionInputSchema).length(1),
}).strict();
const createSchema = z.object({
  metadata: metadataSchema,
  launcher: launcherInputSchema,
}).strict();
const updateSchema = z.object({
  metadata: metadataSchema.partial().optional(),
  launcher: launcherInputSchema.optional(),
}).strict();
const catalogueQuerySchema = z.object({
  audience: z.enum([...WORKFLOW_AUDIENCES, "all"]).default("all"),
  q: z.string().trim().max(300).default(""),
}).strict();
const shareSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(100)
    .transform((emails) => [...new Set(emails)]),
  allow_edit: z.boolean().default(false),
}).strict();
const openSourceSchema = z.object({
  contributor_mode: z.enum(["named", "anonymous"]).default("anonymous"),
  contributor: contributorSchema.optional(),
}).strict();
const idSchema = z.string().uuid();

function contributors(value: unknown): WorkflowContributor[] | null {
  const parsed = z.array(contributorSchema).safeParse(value);
  return parsed.success && parsed.data.length ? parsed.data : null;
}
function metadata(workflow: WorkflowRecord) {
  return {
    title: workflow.title,
    description: null,
    category: workflow.category,
    audiences: workflow.audiences,
    contributors: contributors(workflow.contributors) ?? [DEFAULT_CONTRIBUTOR],
    language: workflow.language ?? DEFAULT_LANGUAGE,
    version: workflow.version,
    jurisdictions: workflow.jurisdictions ?? DEFAULT_JURISDICTIONS,
  };
}
function present(workflow: WorkflowRecord) {
  const { title: _title, execution, variant_label, variant_result,
    contributors: _contributors, language: _language,
    version: _version, category: _category, audiences: _audiences,
    jurisdictions: _jurisdictions, prompt_md, columns_config, ...record } = workflow;
  return { ...record, metadata: metadata(workflow), is_system: false,
    launcher: { kind: "instructions" as const, variants: [{
      id: workflow.id, label: variant_label, result: variant_result, execution,
      skill_md: prompt_md, columns_config,
    }] } };
}
function catalogue<T extends { launcher: { kind: string;
  variants?: readonly { skill_md?: unknown }[] } }>(workflow: T) {
  if (!workflow.launcher.variants) return workflow;
  return { ...workflow, launcher: { ...workflow.launcher,
    variants: workflow.launcher.variants.map(({ skill_md: _skill, ...variant }) => variant) } };
}
const withAccess = <T extends object>(workflow: T, access: {
  allowEdit: boolean; isOwner: boolean; sharedByName?: string | null;
}) => ({ ...workflow, allow_edit: access.allowEdit, is_owner: access.isOwner,
  shared_by_name: access.sharedByName ?? null });
const system = (workflow: SystemWorkflow, snapshot: WorkflowCatalogSnapshot) => withAccess({ ...workflow,
  source_commit: snapshot.sourceCommit,
  references: snapshot.assets.filter((asset) => asset.workflowId === workflow.id)
    .map(({ filename, sha256, sizeBytes, variantId }) => ({ filename, sha256,
      size_bytes: sizeBytes, variant_id: variantId })),
}, {
  allowEdit: false, isOwner: false,
});
const cloud = (collaboration: WorkflowCollaboration | undefined) =>
  collaboration ?? reject(501, "Workflow sharing is unavailable in account-free local mode.");
function validateContribution(workflow: WorkflowRecord) {
  if (workflow.execution === "assistant" && !workflow.prompt_md?.trim()) {
    reject(400, "Instruction workflows need instructions before they can be contributed.");
  }
  if (workflow.execution === "tabular" && !workflow.columns_config?.length) {
    reject(400, "Tabular results need at least one column before they can be contributed.");
  }
}
function variantSlug(variant: Pick<InstructionVariant, "label" | "result">) {
  return [variant.label, variant.result].filter(Boolean).join(" ").toLowerCase()
    .replace(/['"]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}
function archiveSlug(title: string, fallback: string) {
  return title.toLowerCase().replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || fallback;
}
function workflowArchive(workflow: {
  id: string;
  metadata: { title: string; description: string | null; language: string;
    version: string | null; category: string; audiences: readonly string[];
    jurisdictions: readonly string[] | null; contributors: WorkflowContributor[] };
  launcher: { kind: "instructions" | "quote_check"; variants: (Omit<InstructionVariant, "columns_config"> &
    { columns_config: unknown[] | null })[] } |
    { kind: "authorities" } | { kind: "court_records" } | { kind: "fix_supras" };
}) {
  const launcher = workflow.launcher;
  if (launcher.kind !== "instructions" && launcher.kind !== "quote_check") {
    return reject(400, "Workspace workflows are not instruction packages.");
  }
  const slug = archiveSlug(workflow.metadata.title, workflow.id);
  const many = launcher.variants.length > 1;
  const files = launcher.variants.flatMap((variant) => {
    const folder = many ? `${slug}/${variantSlug(variant) || variant.id}` : slug;
    const frontmatter = {
      name: archiveSlug(variant.label, variant.id),
      display_name: many
        ? `${workflow.metadata.title} — ${[variant.label, variant.result].filter(Boolean).join(" — ")}`
        : workflow.metadata.title,
      description: variant.description ?? workflow.metadata.description
        ?? `Run the ${workflow.metadata.title} workflow.`,
      type: variant.execution,
      language: workflow.metadata.language,
      version: workflow.metadata.version ?? "1.0.0",
      category: workflow.metadata.category,
      audiences: workflow.metadata.audiences,
      jurisdictions: workflow.metadata.jurisdictions,
      contributors: workflow.metadata.contributors,
    };
    const header = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    const output = [{ path: `${folder}/SKILL.md`,
      content: `---\n${header}\n---\n\n${variant.skill_md?.trimEnd() ?? ""}\n` }];
    if (variant.execution === "tabular") output.push({
      path: `${folder}/table-config.yaml`,
      content: `${JSON.stringify({
        $schema: "../schema/table-config.schema.yaml",
        columns_config: variant.columns_config ?? [],
      }, null, 2)}\n`,
    });
    return output.map((file) => ({ ...file, variantId: variant.id }));
  });
  return { slug, files };
}

export function createWorkflowsRouter(
  repositoryFor: CreateWorkflowRepository,
  collaboration: WorkflowCollaboration | undefined,
  catalog: WorkflowCatalog,
  documents: DocumentStore,
) {
  const router = Router();
  router.use(requireAuth);
  router.get("/", asyncRoute(async (req, res) => {
    const { audience, q: raw } = catalogueQuerySchema.parse(req.query);
    const q = raw.toLocaleLowerCase();
    const snapshot = await catalog.current(), definitions = snapshot.workflows;
    const builtinIds = new Set(definitions.map(({ id }) => id));
    const builtins = definitions.filter((workflow) =>
      workflowVisibleTo(workflow.metadata.audiences, audience) &&
      (!q || [workflow.metadata.title, workflow.metadata.description,
        workflow.metadata.category,
        ...((workflow.launcher.kind === "instructions" || workflow.launcher.kind === "quote_check")
          ? workflow.launcher.variants.flatMap(({ label, result, description }) =>
            [label, result ?? "", description ?? ""])
          : []),
      ].some((value) => value.toLocaleLowerCase().includes(q))));
    const custom = await repositoryFor(applicationScope(res)).list({ audience, q });
    res.json([...builtins.map((workflow) => system(workflow, snapshot)), ...custom
      .filter(({ id }) => !builtinIds.has(id)).map(present)].map(catalogue));
  }));
  router.post("/", asyncRoute(async (req, res) => {
    const input = createSchema.parse(req.body), variant = input.launcher.variants[0];
    const workflow = await repositoryFor(applicationScope(res)).create({
      title: input.metadata.title,
      execution: variant.execution,
      variantLabel: variant.label,
      variantResult: variant.result ?? null,
      promptMd: variant.skill_md ?? null,
      columns: variant.columns_config ?? null,
      language: input.metadata.language || DEFAULT_LANGUAGE,
      category: input.metadata.category,
      audiences: input.metadata.audiences,
      jurisdictions: input.metadata.jurisdictions || DEFAULT_JURISDICTIONS,
    });
    res.status(201).json(present(workflow));
  }));
  router.get("/:workflowId/references/:filename", asyncRoute(async (req, res) => {
    const snapshot = await catalog.current();
    const reference = snapshot.assets.find((asset) => asset.workflowId === req.params.workflowId &&
      asset.filename === req.params.filename && asset.sha256 === req.query.sha256);
    if (!reference) throw missing("Workflow reference not found or changed");
    const asset = await catalog.asset(reference.workflowId, reference.filename, snapshot);
    if (!asset) throw missing("Workflow reference not found");
    res.set(downloadHeaders(asset.contentType, asset.filename)).send(asset.bytes);
  }));
  router.get("/:workflowId/export", asyncRoute(async (req, res) => {
    const snapshot = await catalog.current();
    const builtin = (snapshot?.workflows ?? SYSTEM_WORKFLOWS).find(({ id }) => id === req.params.workflowId);
    const custom = builtin ? null : await repositoryFor(applicationScope(res))
      .get(idSchema.parse(req.params.workflowId));
    const workflow = builtin ?? (custom ? present(custom.workflow) : null);
    if (!workflow) throw missing("Workflow not found");
    const { slug, files } = workflowArchive(workflow);
    const JSZip = (await import("jszip")).default, archive = new JSZip();
    files.forEach(({ path, content }) => archive.file(path, content));
    if (builtin && snapshot) {
      for (const reference of snapshot.assets.filter((asset) => asset.workflowId === builtin.id)) {
        const asset = await catalog.asset(builtin.id, reference.filename, snapshot);
        if (!asset) throw missing("Workflow reference file not found");
        // Each exported skill is independently usable with its relative references.
        for (const file of files.filter(({ path, variantId }) => path.endsWith("/SKILL.md") &&
          (!reference.variantId || reference.variantId === variantId))) {
          archive.file(`${file.path.slice(0, -"SKILL.md".length)}references/${asset.filename}`, asset.bytes);
        }
      }
      archive.file(`${slug}/provenance.json`, JSON.stringify({ sourceCommit: snapshot.sourceCommit,
        assets: snapshot.assets.filter((asset) => asset.workflowId === builtin.id) }));
    }
    if (custom) {
      const scope = applicationScope(res), references = await repositoryFor(scope).documents(custom.workflow.id);
      if (references.reduce((total, reference) => total + reference.size_bytes, 0) > 64 * 1024 * 1024)
        reject(413, "Workflow references exceed the 64 MB export limit.");
      const links: string[] = [];
      for (const reference of references) {
        const content = await documents.read(scope, reference.id, reference.current_version_id, false);
        if (!content || content.version.source_sha256 !== reference.source_sha256) throw missing("Workflow reference changed. Retry the export.");
        const relative = `references/${reference.id}/${content.filename}`;
        for (const file of files.filter(({ path }) => path.endsWith("/SKILL.md")))
          archive.file(`${file.path.slice(0, -"SKILL.md".length)}${relative}`, content.bytes);
        links.push(`${JSON.stringify(content.filename)}: ${relative}`);
      }
      if (links.length) for (const file of files.filter(({ path }) => path.endsWith("/SKILL.md")))
        archive.file(file.path, `${file.content}\n\nReference documents:\n${links.join("\n")}\n`);
    }
    res.set(downloadHeaders("application/zip", `${slug}.zip`)).send(
      await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
  }));
  router.post("/:workflowId/open-source", asyncRoute(async (req, res) => {
    if (!CONTRIBUTIONS_ENABLED) throw missing("Workflow contributions are disabled");
    const scope = applicationScope(res), workflowId = idSchema.parse(req.params.workflowId);
    const input = openSourceSchema.parse(req.body ?? {});
    const access = await repositoryFor(scope).get(workflowId);
    if (!access?.isOwner) throw missing("Workflow not found or not open-sourceable");
    validateContribution(access.workflow);
    const publicContributors = input.contributor_mode === "named"
      ? [input.contributor ?? { ...DEFAULT_CONTRIBUTOR,
        name: scope.userEmail || DEFAULT_CONTRIBUTOR.name }]
      : [DEFAULT_CONTRIBUTOR];
    const submission = await cloud(collaboration).submit(scope, access.workflow, {
      contributorMode: input.contributor_mode,
      contributor: input.contributor,
      metadata: { ...metadata(access.workflow), contributors: publicContributors },
    });
    res.status(submission.mode === "created" ? 201 : 200).json(submission);
  }));
  router.get("/:workflowId/shares", asyncRoute(async (req, res) => {
    const shares = await cloud(collaboration).shares(
      applicationScope(res), idSchema.parse(req.params.workflowId));
    if (!shares) throw missing("Workflow not found or not editable");
    res.json(shares);
  }));
  router.delete("/:workflowId/shares/:shareId", asyncRoute(async (req, res) => {
    const removed = await cloud(collaboration).removeShare(applicationScope(res),
      idSchema.parse(req.params.workflowId), idSchema.parse(req.params.shareId));
    if (!removed) throw missing("Workflow not found");
    res.status(204).send();
  }));
  router.post("/:workflowId/share", asyncRoute(async (req, res) => {
    const scope = applicationScope(res), input = shareSchema.parse(req.body);
    if (scope.userEmail && input.emails.includes(scope.userEmail.toLowerCase())) {
      reject(400, "You cannot share a workflow with yourself.");
    }
    const result = await cloud(collaboration).share(
      scope, idSchema.parse(req.params.workflowId), input.emails, input.allow_edit);
    if (result === "missing") throw missing("Workflow not found or not editable");
    if (typeof result === "object") {
      reject(400, `${result.missingEmail} does not belong to a Beaver user.`);
    }
    res.status(204).send();
  }));
  router.get("/:workflowId", asyncRoute(async (req, res) => {
    const snapshot = await catalog.current();
    const builtin = snapshot.workflows.find(({ id }) => id === req.params.workflowId);
    if (builtin) return void res.json(system(builtin, snapshot));
    const scope = applicationScope(res);
    const access = await repositoryFor(scope).get(idSchema.parse(req.params.workflowId));
    if (!access) throw missing("Workflow not found");
    res.json({ ...withAccess(present(access.workflow), access),
      documents: await repositoryFor(scope).documents(access.workflow.id),
      open_source_submission: access.isOwner && collaboration
        ? await collaboration.latestSubmission(scope, access.workflow.id) : null });
  }));
  router.patch("/:workflowId", asyncRoute(async (req, res) => {
    if ((await catalog.workflows()).some(({ id }) => id === req.params.workflowId)) reject(403, "System workflows cannot be edited.");
    const input = updateSchema.parse(req.body), update: WorkflowUpdate = {};
    if (input.metadata?.title !== undefined) update.title = input.metadata.title;
    if (input.metadata?.language !== undefined) update.language = input.metadata.language;
    if (input.metadata?.category !== undefined) update.category = input.metadata.category;
    if (input.metadata?.audiences !== undefined) update.audiences = input.metadata.audiences;
    if (input.metadata?.jurisdictions !== undefined) update.jurisdictions = input.metadata.jurisdictions;
    const variant = input.launcher?.variants[0];
    if (variant) {
      update.execution = variant.execution;
      update.variantLabel = variant.label;
      update.variantResult = variant.result ?? null;
      update.promptMd = variant.skill_md ?? null;
      update.columns = variant.columns_config ?? null;
    }
    const access = await repositoryFor(applicationScope(res))
      .update(idSchema.parse(req.params.workflowId), update);
    if (!access) throw missing("Workflow not found or not editable");
    res.json({ ...withAccess(present(access.workflow), access),
      documents: await repositoryFor(applicationScope(res)).documents(access.workflow.id) });
  }));
  router.delete("/:workflowId", asyncRoute(async (req, res) => {
    if ((await catalog.workflows()).some(({ id }) => id === req.params.workflowId)) reject(403, "System workflows cannot be deleted.");
    if (!await repositoryFor(applicationScope(res)).remove(
      idSchema.parse(req.params.workflowId))) throw missing("Workflow not found");
    res.status(204).send();
  }));
  return router;
}
