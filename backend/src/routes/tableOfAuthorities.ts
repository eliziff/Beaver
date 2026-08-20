import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import express, { Router, type Request } from "express";
import { z } from "zod";
import type { DocumentStore } from "../lib/documentStore";
import { asyncRoute } from "../lib/asyncRoute";
import { safeErrorLog } from "../lib/safeError";
import { downloadHeaders } from "../lib/storage";
import { requireAuth } from "../middleware/auth";
import {
  requestTableOfAuthorities,
  submitTableOfAuthoritiesDocument,
} from "../lib/tableOfAuthorities";

const PDF_LIMIT = 256 * 1024 * 1024;
const jobInput = z.object({
  document_id: z.string().trim().min(1).max(160),
  version_id: z.string().trim().max(160).optional(),
  split_fallback: z.enum(["off", "auto"]).default("auto"),
  project_id: z.string().trim().max(160).nullable().optional(),
}).strict();

function workspaceTarget(req: Request) {
  const url = new URL(req.originalUrl, "http://beaver.invalid");
  const prefix = "/api/table-of-authorities/workspace";
  const suffix = url.pathname.slice(prefix.length);
  if (!suffix.startsWith("/")) return "";
  return `/api${suffix}${url.search}`;
}

export function createTableOfAuthoritiesRouter(documents: DocumentStore) {
  const router = Router();
  router.use(requireAuth);
  router.use("/workspace", express.json({ limit: "16mb" }));
  router.use(express.json({ limit: "2mb" }));
  router.post("/jobs", asyncRoute(async (req, res) => {
    const input = jobInput.safeParse(req.body);
    if (!input.success) return void res.status(400).json({ detail: "Invalid submission" });
    try {
      const userId = res.locals.userId as string;
      const file = await documents.read(
        { userId }, input.data.document_id, input.data.version_id || null, false,
      );
      if (!file) return void res.status(404).json({ detail: "Library version not found" });
      if (!["docx", "pdf"].includes(file.fileType.toLowerCase())) {
        return void res.status(400).json({
          detail: "Authorities Helper requires a Word or PDF Library version",
        });
      }
      res.status(202).json(await submitTableOfAuthoritiesDocument({
        userId,
        bytes: file.bytes,
        filename: file.filename,
        splitFallback: input.data.split_fallback,
        projectId: input.data.project_id,
      }));
    } catch (error) {
      console.error("[toa] submission failed", safeErrorLog(error));
      res.status(503).json({ detail: "Authorities Helper submission failed" });
    }
  }));
  router.all("/workspace/*", asyncRoute(async (req, res) => {
    const method = req.method as "GET" | "POST" | "PUT" | "DELETE";
    if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
      return void res.sendStatus(405);
    }
    const target = workspaceTarget(req);
    if (!target) return void res.sendStatus(404);
    try {
      const options: { body?: unknown; upload?: Request } = {};
      if (req.is("application/json")) {
        options.body = req.body;
      } else if (method === "POST") {
        const value = req.get("content-length");
        if (value === undefined) return void res.status(411).json({ error: "Content-Length is required." });
        const length = Number(value);
        if (!Number.isSafeInteger(length) || length < 0) {
          return void res.status(400).json({ error: "Invalid Content-Length." });
        }
        if (length > PDF_LIMIT) return void res.status(413).json({ error: "Upload is too large." });
        if (length) options.upload = req;
      }
      const response = await requestTableOfAuthorities(
        res.locals.userId as string, method, target, options,
      );
      if (response.file) {
        res.status(response.status).set(downloadHeaders(
          response.contentType || "application/octet-stream",
          response.name || "download",
        ));
        await pipeline(createReadStream(response.file), res);
      } else if (response.status === 204) {
        res.sendStatus(204);
      } else {
        res.status(response.status).json(response.body);
      }
    } catch (error) {
      console.error("[toa] workspace request failed", safeErrorLog(error));
      if (!res.headersSent) res.status(503).json({ error: "Authorities Helper is unavailable." });
    }
  }));
  return router;
}
