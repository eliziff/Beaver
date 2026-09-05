import { Router } from "express";
import { z } from "zod";
import { applicationScope } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import type { WorkProductApplication } from "../lib/workProductApplication";
import { WORK_PRODUCT_KINDS } from "../lib/workProduct";
import { requireAuth } from "../middleware/auth";

const id = z.string().uuid();
const label = (max: number) => z.string().trim().min(1).max(max);
const outputRefs = z.record(z.object({ documentId: label(200), versionId: label(200) }).strict())
  .refine((value) => Object.keys(value).length <= 100 && Object.keys(value).every((key) =>
    key.length > 0 && key.length <= 100), "Too many or invalid output roles");
const project = id.nullable().optional();
const create = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("court-record"), title: label(300),
    project_id: project, state: z.unknown() }).strict(),
  z.object({ kind: z.literal("authorities"), title: label(300),
    project_id: project, state: z.unknown() }).strict(),
]);
const update = z.object({ revision: z.number().int().positive(), title: label(300).optional(),
  project_id: project, state: z.unknown().optional(), outputs: outputRefs.optional() }).strict()
  .refine((value) => ["title", "project_id", "state", "outputs"]
    .some((key) => Object.hasOwn(value, key)), "No draft changes supplied");
const duplicate = z.object({ title: label(300).optional(), project_id: project }).strict();
const query = z.object({ kind: z.enum(WORK_PRODUCT_KINDS).optional(),
  project_id: id.optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  metadata: z.literal("true").optional() }).strict();

export function createWorkProductsRouter(application: WorkProductApplication) {
  const router = Router();
  router.use(requireAuth);
  router.get("/", asyncRoute(async (req, res) => {
    const values = query.parse(req.query);
    res.json(await application.list(applicationScope(res), {
      kind: values.kind, projectId: values.project_id, limit: values.limit,
      metadata: values.metadata === "true",
    }));
  }));
  router.post("/", asyncRoute(async (req, res) => {
    const values = create.parse(req.body);
    const scope = applicationScope(res);
    res.status(201).json(await application.create(scope, {
      kind: values.kind, title: values.title, projectId: values.project_id,
      state: values.state,
    }));
  }));
  router.get("/:id/resolution", asyncRoute(async (req, res) => {
    res.json(await application.resolve(applicationScope(res), id.parse(req.params.id)));
  }));
  router.get("/:id", asyncRoute(async (req, res) => {
    res.json(await application.get(applicationScope(res), id.parse(req.params.id)));
  }));
  router.patch("/:id", asyncRoute(async (req, res) => {
    const values = update.parse(req.body);
    res.json(await application.save(applicationScope(res), id.parse(req.params.id), {
      revision: values.revision, title: values.title, projectId: values.project_id,
      state: values.state, outputs: values.outputs,
    }));
  }));
  router.post("/:id/duplicate", asyncRoute(async (req, res) => {
    const values = duplicate.parse(req.body ?? {});
    res.status(201).json(await application.duplicate(applicationScope(res),
      id.parse(req.params.id), { title: values.title, projectId: values.project_id }));
  }));
  router.delete("/:id", asyncRoute(async (req, res) => {
    await application.remove(applicationScope(res), id.parse(req.params.id));
    res.status(204).send();
  }));
  return router;
}
