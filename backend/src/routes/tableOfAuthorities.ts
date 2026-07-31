import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getLocalVersionFile } from "../lib/localDocumentStore";
import {
  ensureTableOfAuthoritiesRunning,
  submitTableOfAuthoritiesDocument,
  tableOfAuthoritiesLocalFeatureAvailable,
  tableOfAuthoritiesProjectDirectory,
  tableOfAuthoritiesStatus,
  tableOfAuthoritiesUrl,
} from "../lib/tableOfAuthorities";

export const tableOfAuthoritiesRouter = Router();

tableOfAuthoritiesRouter.get("/status", async (_req, res) => {
  const directory = tableOfAuthoritiesProjectDirectory();
  res.json({
    available:
      tableOfAuthoritiesLocalFeatureAvailable() &&
      existsSync(path.join(directory, "toa_web.py")),
    running: await tableOfAuthoritiesStatus(),
    url: tableOfAuthoritiesUrl(),
  });
});

tableOfAuthoritiesRouter.post("/launch", async (_req, res) => {
  if (!tableOfAuthoritiesLocalFeatureAvailable()) {
    res.status(403).json({
      detail:
        "The standalone Table of Authorities host is available only in local anonymous development mode.",
    });
    return;
  }
  try {
    res.json({ ok: true, ...(await ensureTableOfAuthoritiesRunning()) });
  } catch (error) {
    res.status(503).json({
      detail:
        error instanceof Error
          ? error.message
          : "Table of Authorities could not be started.",
    });
  }
});

tableOfAuthoritiesRouter.post("/jobs", requireAuth, async (req, res) => {
  if (!tableOfAuthoritiesLocalFeatureAvailable()) {
    res.status(403).json({
      detail:
        "Table of Authorities Library submission is available only in local anonymous mode.",
    });
    return;
  }
  const documentId =
    typeof req.body?.document_id === "string"
      ? req.body.document_id.trim()
      : "";
  const versionId =
    typeof req.body?.version_id === "string"
      ? req.body.version_id.trim()
      : "";
  if (!documentId) {
    res.status(400).json({ detail: "document_id is required" });
    return;
  }
  try {
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      documentId,
      versionId || undefined,
    );
    if (!file) {
      res.status(404).json({ detail: "Library version not found" });
      return;
    }
    if (!["docx", "pdf"].includes(file.fileType.toLowerCase())) {
      res
        .status(400)
        .json({
          detail:
            "Table of Authorities requires a Word or PDF Library version",
        });
      return;
    }
    res.status(202).json(
      await submitTableOfAuthoritiesDocument({
        bytes: await readFile(file.path),
        filename: file.version.filename,
        splitFallback: req.body?.split_fallback === "off" ? "off" : "auto",
        projectId:
          typeof req.body?.project_id === "string"
            ? req.body.project_id
            : null,
      }),
    );
  } catch (error) {
    res.status(503).json({
      detail:
        error instanceof Error
          ? error.message
          : "Table of Authorities submission failed",
    });
  }
});
