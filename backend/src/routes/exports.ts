import { Router } from "express";
import { z } from "zod";
import { exportSigningIdentity } from "mike/shared/export-integrity.mjs";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { applicationScope, type ApplicationScope } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import type { buildProjectExportManifest } from "../lib/userDataExport";

export function createExportsRouter(project: (scope: ApplicationScope, id: string) => ReturnType<typeof buildProjectExportManifest>) {
  const router = Router();
  router.use(requireAuth);
  router.get("/signing-key", asyncRoute(async (_req, res) => { res.json(exportSigningIdentity()); }));
  router.get("/projects/:id", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const manifest = await project(applicationScope(res), id);
    res.attachment(`beaver-project-${id}-manifest.json`).json(manifest);
  }));
  return router;
}
