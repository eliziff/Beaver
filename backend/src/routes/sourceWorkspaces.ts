import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { applicationScope, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { pageRequest, pageResponse } from "../lib/pagination";
import { requestAbortController } from "../lib/httpStreaming";
import { researchFileActionSchema } from "../lib/researchFile";
import { researchCaptureRuleSchema } from "../lib/researchFileQuery";
import { researchSelectionSchema } from "../lib/researchSelection";
import { researchFindingReferenceSchema } from "../lib/researchFindingReference";
import { tabularColumnSchema } from "../lib/tabular/application";
import type { SourceWorkspaceApplication } from "../lib/sourceWorkspaceApplication";

const id = z.string().trim().min(1).max(200), revision = z.number().int().nonnegative();
const page = { offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50) };
const tableInput = z.object({ selection: researchSelectionSchema.optional(), tableId: id.optional(),
  chatId: id.optional(), messageIds: z.array(id).min(1).max(100).optional(),
  rows: z.enum(["sources", "passages"]).optional(), labelId: id.optional(),
  title: z.string().trim().min(1).max(300).optional(), request: z.string().trim().min(1).max(4_000).optional(),
  basis: z.string().regex(/^[a-f0-9]{64}$/u).optional(), replaceTableId: id.optional(), expectedVersion: id.optional(),
  columns: z.array(tabularColumnSchema.extend({
    fieldIds: z.array(id).max(100) })).max(100).optional(),
  findingRefs: z.array(researchFindingReferenceSchema).min(1).max(10_000).optional() }).strict();
const placement = { title: z.string().trim().min(1).max(200).optional(),
  projectId: id.nullish(), folderId: id.nullish() };
const query = z.object({ version_id: id, working_revision: revision,
  text: z.string().trim().min(1).max(10_000).optional(),
  syntax: z.enum(["literal", "terms"]), target: z.enum(["sources", "passages"]),
  sourceIds: z.array(id).max(10_000).optional(), labelIds: z.array(id).max(1_000).optional(),
  evidenceIds: researchSelectionSchema.shape.evidenceIds, members: researchSelectionSchema.shape.members,
  unlabelled: z.boolean().optional(), rules: z.array(researchCaptureRuleSchema).max(50).optional(),
  conflict: z.enum(["prompt", "first", "longer", "shorter", "append"]).optional(),
  after: z.string().max(4096).optional(), limit: z.number().int().min(1).max(5_000).optional(),
}).strict().refine((input) => Boolean(input.text) !== Boolean(input.rules?.length),
  "Supply either text or capture rules");

export function createSourceWorkspacesRouter(app: SourceWorkspaceApplication) {
  const router = Router(), scope = applicationScope;
  router.use(requireAuth);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  router.post("/", asyncRoute(async (req, res) => {
    const input = z.object({ ...placement, title: placement.title.unwrap() }).strict().parse(req.body);
    res.status(201).json(await app.create(scope(res), input, { executor: "human" }));
  }));
  router.post("/ensure", asyncRoute(async (req, res) => {
    const input = z.object({ ...placement, chatId: id.optional(), tableId: id.optional() }).strict()
      .refine(({ chatId, tableId }) => Boolean(chatId) !== Boolean(tableId), "Choose a chat or table").parse(req.body);
    res.json(await app.ensure(scope(res), input, { executor: "human" }));
  }));
  router.get("/:id", asyncRoute(async (req, res) => {
    res.json(await app.get(scope(res), id.parse(req.params.id)) ?? reject(404, "Sources workspace not found"));
  }));
  router.get("/:id/items", asyncRoute(async (req, res) => {
    const documentId = id.parse(req.params.id), input = z.object({ kind: z.enum(["passages", "evidence", "queries", "history"]),
      source_id: id.optional() }).parse(req.query), first = await app.revision(scope(res), documentId,
      { kind: input.kind, sourceId: input.source_id }),
      filters = { document_id: documentId, content_revision: first.contentRevision,
        kind: input.kind, source_id: input.source_id ?? null },
      { after, limit } = pageRequest<[number]>(req.query as Record<string, unknown>, "research-items", filters, ["number"]),
      result = await app.items(scope(res), documentId, { kind: input.kind, sourceId: input.source_id,
        offset: after?.[0] ?? 0, limit });
    if (result.contentRevision !== first.contentRevision) reject(409, "The workspace changed. Reload its items.");
    res.json({ ...pageResponse("research-items", filters, { items: result.items,
      nextAfter: result.nextOffset === null ? null : [result.nextOffset] }), total: result.total });
  }));
  router.get("/:id/citation", asyncRoute(async (req, res) => {
    const input = z.object({ source_id: id, evidence_id: id.optional() }).strict().parse(req.query);
    res.json(await app.citation(scope(res), id.parse(req.params.id), input.source_id, input.evidence_id));
  }));
  router.post("/:id/actions", asyncRoute(async (req, res) => {
    const input = z.object({ version_id: id, working_revision: revision, action: researchFileActionSchema }).strict().parse(req.body),
      { file, ...result } = await app.update(scope(res), id.parse(req.params.id), {
        versionId: input.version_id, workingRevision: input.working_revision, action: input.action },
      { operation: { executor: "human" } });
    res.json({ ...file, ...result });
  }));
  router.post("/:id/query", asyncRoute(async (req, res) => {
    const { version_id, working_revision, ...input } = query.parse(req.body),
      result = await app.query(scope(res), id.parse(req.params.id), { ...input,
        versionId: version_id, workingRevision: working_revision },
      { signal: requestAbortController(req, res).signal, operation: { executor: "human" } });
    res.json({ file: result.file, receipt: result.receipt, coverage: result.coverage });
  }));
  router.get("/:id/views", asyncRoute(async (req, res) => {
    res.json(await app.views(scope(res), id.parse(req.params.id)));
  }));
  router.get("/:id/findings", asyncRoute(async (req, res) => {
    const { source_ids, ...input } = z.object({ ...page,
      source_ids: z.string().max(20_000).optional() }).strict().parse(req.query);
    res.json(await app.findings(scope(res), id.parse(req.params.id), { ...input,
      ...(source_ids ? { sourceIds: source_ids.split(",") } : {}) }));
  }));
  router.post("/:id/bind", asyncRoute(async (req, res) => {
    const input = z.object({ chatId: id.optional(), tableId: id.optional(), selection: researchSelectionSchema.optional() }).strict()
      .refine(({ chatId, tableId }) => Boolean(chatId) !== Boolean(tableId), "Choose a chat or table").parse(req.body);
    res.json(await app.bind(scope(res), id.parse(req.params.id), input, { executor: "human" }));
  }));
  router.post("/:id/table-plan", asyncRoute(async (req, res) => {
    res.json(await app.tablePlan(scope(res), id.parse(req.params.id), tableInput.parse(req.body ?? {}),
      requestAbortController(req, res).signal));
  }));
  router.post("/:id/table", asyncRoute(async (req, res) => {
    res.json(await app.table(scope(res), id.parse(req.params.id), tableInput.parse(req.body ?? {}), { executor: "human" }));
  }));
  router.post("/:id/findings", asyncRoute(async (req, res) => {
    const { selection, ...input } = z.object({ ...page, chatId: id.optional(), messageIds: z.array(id).max(100).optional(),
      references: z.array(researchFindingReferenceSchema).max(10_000).optional(),
      selection: researchSelectionSchema.optional(), sourceIds: z.array(id).max(500).optional() }).strict().parse(req.body);
    const documentId = id.parse(req.params.id), selected = selection ? await app.selection(scope(res), documentId, selection) : undefined;
    res.json(await app.findings(scope(res), documentId, { ...input, subjects: selected?.subjects }));
  }));
  router.post("/:id/save-highlights", asyncRoute(async (req, res) => {
    const input = z.object({ references: z.array(researchFindingReferenceSchema).min(1).max(500),
      evidenceIds: z.array(id).min(1).max(10_000), typeId: id.optional(), versionId: id, workingRevision: revision }).strict().parse(req.body);
    res.json(await app.saveHighlights(scope(res), id.parse(req.params.id), input, { executor: "human" }));
  }));
  const columnInput = z.object({ reviewId: id, columnIndex: z.number().int().min(0).max(10_000),
    rowIds: z.array(z.string().min(1).max(4_000)).max(500).optional(), parentId: id.optional(),
    basis: z.string().regex(/^[a-f0-9]{64}$/u).optional(), request: z.string().trim().min(1).max(4_000).optional(),
    mapping: z.array(z.object({ value: z.string().max(40_000), label: z.string().trim().min(1).max(200).nullable() }).strict()).max(200).optional() }).strict();
  router.post("/:id/column-label-plan", asyncRoute(async (req, res) => {
    res.json(await app.columnLabelPlan(scope(res), id.parse(req.params.id), columnInput.parse(req.body), requestAbortController(req, res).signal));
  }));
  router.post("/:id/column-labels", asyncRoute(async (req, res) => {
    res.json(await app.columnLabels(scope(res), id.parse(req.params.id), columnInput.parse(req.body), { executor: "human" }));
  }));
  return router;
}
