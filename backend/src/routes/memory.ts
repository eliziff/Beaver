import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { applicationScope } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import type { createMemoryApplication, MemoryTarget } from "../lib/memoryApplication";

const revision = z.number().int().nonnegative();
const edit = z.object({ revision, content: z.string().max(16 * 1024).optional(), enabled: z.boolean().optional() })
  .strict().refine((value) => value.content !== undefined || value.enabled !== undefined, "No changes supplied");
export function createMemoryRouter(application: ReturnType<typeof createMemoryApplication>) {
  const router = Router();
  router.use(requireAuth);
  for (const scope of ["app", "project"] as const) {
    const path = scope === "app" ? "/app" : "/projects/:id";
    const target = (userId: string, id: unknown): MemoryTarget => ({ scope,
      ownerId: scope === "app" ? userId : z.string().uuid().parse(id) });
    router.get(path, asyncRoute(async (req, res) => {
      const actor = applicationScope(res);
      res.json(await application.get(actor, target(actor.userId, req.params.id)));
    }));
    router.patch(path, requireMfaIfEnrolled, asyncRoute(async (req, res) => {
      const actor = applicationScope(res);
      res.json(await application.update(actor, target(actor.userId, req.params.id), edit.parse(req.body)));
    }));
    router.post(`${path}/clear`, requireMfaIfEnrolled, asyncRoute(async (req, res) => {
      const actor = applicationScope(res), input = z.object({ revision }).strict().parse(req.body);
      res.json(await application.update(actor, target(actor.userId, req.params.id), { ...input, clear: true }));
    }));
  }
  return router;
}
