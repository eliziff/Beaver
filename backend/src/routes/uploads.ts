import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { applicationScope } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { requiredFile, singleFileUpload } from "../lib/upload";
import type { createUploadApplication } from "../lib/uploadApplication";

export function createUploadsRouter(application: ReturnType<typeof createUploadApplication>) {
  const router = Router(), id = (value: unknown) => z.string().uuid().parse(value);
  router.use(requireAuth);
  router.get("/", asyncRoute(async (_req, res) => { res.json(await application.list(applicationScope(res))); }));
  router.get("/:id", asyncRoute(async (req, res) => { res.json(await application.get(applicationScope(res), id(req.params.id))); }));
  router.use(requireMfaIfEnrolled);
  router.post("/", asyncRoute(async (req, res) => { res.status(201).json(await application.start(applicationScope(res), req.body)); }));
  router.post("/:id/transfer", asyncRoute(async (req, res) => { res.json(await application.transfer(applicationScope(res), id(req.params.id))); }));
  router.post("/:id/content", asyncRoute(async (req, res, next) => {
    await application.get(applicationScope(res), id(req.params.id)); next();
  }), singleFileUpload("file"), asyncRoute(async (req, res) => {
    const file = requiredFile(req);
    await application.receive(applicationScope(res), id(req.params.id), { path: file.path, sizeBytes: file.size });
    res.json({ uploaded: true });
  }));
  router.post("/:id/complete", asyncRoute(async (req, res) => { res.status(202).json(await application.complete(applicationScope(res), id(req.params.id))); }));
  router.delete("/:id", asyncRoute(async (req, res) => { await application.cancel(applicationScope(res), id(req.params.id)); res.sendStatus(204); }));
  return router;
}
