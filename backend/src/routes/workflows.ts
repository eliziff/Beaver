import { Router } from "express";
import { z } from "zod";
import { applicationScope, notFound as missing, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { requireAuth } from "../middleware/auth";
import { pageRequest, pageResponse } from "../lib/pagination";
import { downloadHeaders } from "../lib/storage";
import { tabularDtos } from "../lib/tabular/application";
import {
  SYSTEM_WORKFLOW_IDS,
  SYSTEM_WORKFLOWS,
  type SystemWorkflow,
} from "../lib/systemWorkflows";
import type {
  CreateWorkflowRepository,
  WorkflowCollaboration,
  WorkflowRecord,
  WorkflowUpdate,
} from "../lib/workflowRepository";

type Contributor = {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
};
const DEFAULT_CONTRIBUTOR: Contributor = {
  name: "Beaver", organisation: null, role: null, linkedin: null,
};
const DEFAULT_LANGUAGE = "English";
const DEFAULT_PRACTICE = "General Transactions";
const DEFAULT_JURISDICTIONS = ["General"];
const CONTRIBUTIONS_ENABLED = process.env.WORKFLOW_CONTRIBUTIONS_ENABLED === "true";
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const contributorSchema = z.object({
  name: text(200),
  organisation: z.string().trim().max(200).nullable().default(null),
  role: z.string().trim().max(200).nullable().default(null),
  linkedin: z.string().trim().max(2_000).nullable().default(null),
}).strict();
const metadataSchema = z.object({
  title: text(300),
  type: z.enum(["assistant", "tabular"]),
  language: optionalText(100),
  practice: optionalText(200),
  jurisdictions: z.array(text(100)).max(50).nullable().optional()
    .transform((items) => items?.length ? [...new Set(items)] : null),
}).strict();
const columnsSchema = tabularDtos.create.shape.columns_config;
const createSchema = z.object({
  metadata: metadataSchema,
  skill_md: z.string().max(1_000_000).optional(),
  columns_config: columnsSchema.optional(),
}).strict();
const updateSchema = z.object({
  metadata: metadataSchema.omit({ type: true }).partial().optional(),
  skill_md: z.string().max(1_000_000).optional(),
  columns_config: columnsSchema.optional(),
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
const hideSchema = z.object({ workflow_id: text(300) }).strict();
const idSchema = z.string().uuid();

function contributors(value: unknown): Contributor[] | null {
  const parsed = z.array(contributorSchema).safeParse(value);
  return parsed.success && parsed.data.length ? parsed.data : null;
}
function metadata(workflow: WorkflowRecord) {
  return {
    title: workflow.title,
    description: null,
    type: workflow.type,
    contributors: contributors(workflow.contributors) ?? [DEFAULT_CONTRIBUTOR],
    language: workflow.language ?? DEFAULT_LANGUAGE,
    version: workflow.version,
    practice: workflow.practice ?? DEFAULT_PRACTICE,
    jurisdictions: workflow.jurisdictions ?? DEFAULT_JURISDICTIONS,
  };
}
function present(workflow: WorkflowRecord) {
  const { title: _title, type: _type, contributors: _contributors,
    language: _language, version: _version, practice: _practice,
    jurisdictions: _jurisdictions, prompt_md, ...record } = workflow;
  return { ...record, metadata: metadata(workflow), skill_md: prompt_md, is_system: false };
}
const withAccess = <T extends object>(workflow: T, access: {
  allowEdit: boolean; isOwner: boolean; sharedByName?: string | null;
}) => ({ ...workflow, allow_edit: access.allowEdit, is_owner: access.isOwner,
  shared_by_name: access.sharedByName ?? null });
const system = (workflow: SystemWorkflow) => withAccess(workflow, {
  allowEdit: false, isOwner: false,
});
const cloud = (collaboration: WorkflowCollaboration | undefined) =>
  collaboration ?? reject(501, "Workflow sharing is unavailable in account-free local mode.");
function validateContribution(workflow: WorkflowRecord) {
  if (workflow.type === "assistant" && !workflow.prompt_md?.trim()) {
    reject(400, "Assistant workflows need instructions before they can be opened source.");
  }
  if (workflow.type === "tabular" && !workflow.columns_config?.length) {
    reject(400, "Tabular workflows need at least one column before they can be opened source.");
  }
}

type ArchiveWorkflow = {
  id: string;
  metadata: {
    title: string;
    description: string | null;
    type: "assistant" | "tabular";
    contributors: Contributor[];
    language: string;
    version: string | null;
    practice: string | null;
    jurisdictions: string[] | null;
  };
  skill_md: string | null;
  columns_config: unknown[] | null;
};

function workflowArchive(workflow: ArchiveWorkflow) {
  const slug = workflow.metadata.title.toLowerCase().replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || workflow.id;
  const frontmatter = {
    name: slug,
    display_name: workflow.metadata.title,
    description: workflow.metadata.description ?? `Run the ${workflow.metadata.title} workflow.`,
    type: workflow.metadata.type,
    language: workflow.metadata.language,
    version: workflow.metadata.version ?? "1.0.0",
    practice: workflow.metadata.practice,
    jurisdictions: workflow.metadata.jurisdictions,
    contributors: workflow.metadata.contributors,
  };
  const header = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  const files = [{
    path: `${slug}/SKILL.md`,
    content: `---\n${header}\n---\n\n${workflow.skill_md?.trimEnd() ?? ""}\n`,
  }];
  if (workflow.metadata.type === "tabular") files.push({
    path: `${slug}/table-config.yaml`,
    content: `${JSON.stringify({
      $schema: "../schema/table-config.schema.yaml",
      columns_config: workflow.columns_config ?? [],
    }, null, 2)}\n`,
  });
  return { slug, files };
}

export function createWorkflowsRouter(
  repositoryFor: CreateWorkflowRepository,
  collaboration?: WorkflowCollaboration,
) {
  const router = Router();
  router.use(requireAuth);
  router.get("/system", (req, res) => {
    const type = req.query.type === "assistant" || req.query.type === "tabular"
      ? req.query.type : null;
    res.json(SYSTEM_WORKFLOWS.filter(({ metadata: item }) => !type || item.type === type)
      .map(system));
  });
  router.get("/", asyncRoute(async (req, res) => {
    const type = req.query.type === "assistant" || req.query.type === "tabular"
      ? req.query.type : null;
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const filters = { q, type };
    const { after, limit } = pageRequest<[string, string]>(
      req.query, "workflows", filters, ["string", "string"],
    );
    const page = await repositoryFor(applicationScope(res)).page({ q, type, after, limit });
    res.json(pageResponse("workflows", filters, { ...page,
      items: page.items.filter(({ id }) => !SYSTEM_WORKFLOW_IDS.has(id)).map(present),
    }));
  }));
  router.get("/hidden", asyncRoute(async (_req, res) => {
    res.json(await repositoryFor(applicationScope(res)).hidden());
  }));
  router.post("/hidden", asyncRoute(async (req, res) => {
    const { workflow_id } = hideSchema.parse(req.body);
    await repositoryFor(applicationScope(res)).hide(workflow_id);
    res.status(204).send();
  }));
  router.delete("/hidden/:workflowId", asyncRoute(async (req, res) => {
    await repositoryFor(applicationScope(res)).unhide(req.params.workflowId);
    res.status(204).send();
  }));
  router.post("/", asyncRoute(async (req, res) => {
    const input = createSchema.parse(req.body);
    const workflow = await repositoryFor(applicationScope(res)).create({
      title: input.metadata.title,
      type: input.metadata.type,
      promptMd: input.skill_md ?? null,
      columns: input.columns_config ?? null,
      language: input.metadata.language || DEFAULT_LANGUAGE,
      practice: input.metadata.practice || DEFAULT_PRACTICE,
      jurisdictions: input.metadata.jurisdictions || DEFAULT_JURISDICTIONS,
    });
    res.status(201).json(present(workflow));
  }));
  router.get("/:workflowId/export", asyncRoute(async (req, res) => {
    const builtin = SYSTEM_WORKFLOWS.find(({ id }) => id === req.params.workflowId);
    const workflow: ArchiveWorkflow | null = builtin ?? await repositoryFor(applicationScope(res))
      .get(idSchema.parse(req.params.workflowId)).then((access) => access
        ? present(access.workflow) : null);
    if (!workflow) throw missing("Workflow not found");
    const { slug, files } = workflowArchive(workflow);
    const JSZip = (await import("jszip")).default, archive = new JSZip();
    files.forEach(({ path, content }) => archive.file(path, content));
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
    const builtin = SYSTEM_WORKFLOWS.find(({ id }) => id === req.params.workflowId);
    if (builtin) return void res.json(system(builtin));
    const scope = applicationScope(res);
    const access = await repositoryFor(scope).get(idSchema.parse(req.params.workflowId));
    if (!access) throw missing("Workflow not found");
    res.json({ ...withAccess(present(access.workflow), access),
      open_source_submission: access.isOwner && collaboration
        ? await collaboration.latestSubmission(scope, access.workflow.id) : null });
  }));
  router.patch("/:workflowId", asyncRoute(async (req, res) => {
    const input = updateSchema.parse(req.body), update: WorkflowUpdate = {};
    if (input.metadata?.title !== undefined) update.title = input.metadata.title;
    if (input.metadata?.language !== undefined) update.language = input.metadata.language;
    if (input.metadata?.practice !== undefined) update.practice = input.metadata.practice;
    if (input.metadata?.jurisdictions !== undefined) {
      update.jurisdictions = input.metadata.jurisdictions;
    }
    if (input.skill_md !== undefined) update.promptMd = input.skill_md;
    if (input.columns_config !== undefined) update.columns = input.columns_config;
    const access = await repositoryFor(applicationScope(res))
      .update(idSchema.parse(req.params.workflowId), update);
    if (!access) throw missing("Workflow not found or not editable");
    res.json(withAccess(present(access.workflow), access));
  }));
  router.delete("/:workflowId", asyncRoute(async (req, res) => {
    const builtin = SYSTEM_WORKFLOWS.find(({ id }) => id === req.params.workflowId);
    if (builtin) return void res.json(system(builtin));
    if (!await repositoryFor(applicationScope(res)).remove(
      idSchema.parse(req.params.workflowId))) throw missing("Workflow not found");
    res.status(204).send();
  }));
  return router;
}
