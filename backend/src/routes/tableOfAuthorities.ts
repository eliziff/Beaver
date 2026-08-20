import { existsSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { DocumentStore } from "../lib/documentStore";
import { asyncRoute } from "../lib/asyncRoute";
import { safeErrorLog } from "../lib/safeError";
import { requireAuth } from "../middleware/auth";
import {
  ensureTableOfAuthoritiesRunning,
  submitTableOfAuthoritiesDocument,
  tableOfAuthoritiesLocalFeatureAvailable,
  tableOfAuthoritiesProjectDirectory,
  tableOfAuthoritiesStatus,
  tableOfAuthoritiesUrl,
} from "../lib/tableOfAuthorities";

const jobInput = z.object({
  document_id: z.string().trim().min(1).max(160),
  version_id: z.string().trim().max(160).optional(),
  split_fallback: z.enum(["off", "auto"]).default("auto"),
  project_id: z.string().trim().max(160).nullable().optional(),
}).strict();

export function createTableOfAuthoritiesRouter(documents: DocumentStore) {
  const router = Router();
  router.use(requireAuth);
  router.get("/status", asyncRoute(async (_req, res) => {
    const directory = tableOfAuthoritiesProjectDirectory();
    res.json({
      available: tableOfAuthoritiesLocalFeatureAvailable() &&
        existsSync(path.join(directory, "toa_web.py")),
      running: await tableOfAuthoritiesStatus(), url: tableOfAuthoritiesUrl(),
    });
  }));
  router.post("/launch", asyncRoute(async (_req, res) => {
    if (!tableOfAuthoritiesLocalFeatureAvailable()) return void res.status(403).json({
      detail: "Authorities Helper is available only in local mode.",
    });
    try { res.json({ ok: true, ...(await ensureTableOfAuthoritiesRunning()) }); }
    catch (error) {
      console.error("[toa] launch failed", safeErrorLog(error));
      res.status(503).json({ detail: "Authorities Helper could not be started." });
    }
  }));
  router.post("/jobs", asyncRoute(async (req, res) => {
    if (!tableOfAuthoritiesLocalFeatureAvailable()) return void res.status(403).json({
      detail: "Authorities Helper Library submission is available only in local mode.",
    });
    const input = jobInput.safeParse(req.body);
    if (!input.success) return void res.status(400).json({ detail: "Invalid submission" });
    try {
      const file = await documents.read({ userId: res.locals.userId as string },
        input.data.document_id, input.data.version_id || null, false);
      if (!file) return void res.status(404).json({ detail: "Library version not found" });
      if (!["docx", "pdf"].includes(file.fileType.toLowerCase()))
        return void res.status(400).json({ detail: "Authorities Helper requires a Word or PDF Library version" });
      res.status(202).json(await submitTableOfAuthoritiesDocument({
        bytes: file.bytes, filename: file.filename,
        splitFallback: input.data.split_fallback, projectId: input.data.project_id,
      }));
    } catch (error) {
      console.error("[toa] submission failed", safeErrorLog(error));
      res.status(503).json({ detail: "Authorities Helper submission failed" });
    }
  }));
  return router;
}
