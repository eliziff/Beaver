import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { trimmedText } from "../lib/value";
import type { LegalSourceApplication } from "../lib/legalSourceApplication";
import { searchFts5 } from "../lib/searchQuery";

function text(value: unknown, name: string, maximum = 500) {
  const result = trimmedText(value);
  if (!result) reject(400, `${name} is required`);
  if (result.length > maximum) reject(400, `${name} is too long`);
  return result;
}

function optionalText(value: unknown, maximum = 200) {
  const result = trimmedText(value);
  if (result.length > maximum) reject(400, "value is too long");
  return result || undefined;
}

function docType(
  value: unknown,
  allowAuto: true,
): "cases" | "laws" | "articles" | "auto";
function docType(value: unknown, allowAuto?: false): "cases" | "laws" | "articles";
function docType(value: unknown, allowAuto = false) {
  if (value === "laws") return "laws" as const;
  if (value === "articles") return "articles" as const;
  if (value === "cases" || value === undefined || value === "") {
    return "cases" as const;
  }
  if (allowAuto && value === "auto") return "auto" as const;
  return reject(400, "doc_type must be cases, laws, or articles");
}

function language(value: unknown) {
  if (value === "fr") return "fr" as const;
  if (value === "en" || value === undefined || value === "") {
    return "en" as const;
  }
  return reject(400, "language must be en or fr");
}

function userId(res: Response) {
  return String(res.locals.userId);
}

function sendViewer(req: Request, res: Response,
  resolved: Awaited<ReturnType<LegalSourceApplication["viewer"]>>, started: number) {
  res.set({ "Server-Timing": `legal-source;dur=${(performance.now() - started).toFixed(1)}`,
    "Cache-Control": "private, max-age=0, must-revalidate", ETag: resolved.etag, Vary: "Authorization" });
  if (req.headers["if-none-match"]?.split(",").map((value) => value.trim())
    .some((value) => value === "*" || value === resolved.etag)) res.status(304).end();
  else res.json(resolved.payload);
}

export function createLegalLibraryRouter(application: LegalSourceApplication) {
const router = Router();
router.use(requireAuth);
router.get("/", asyncRoute(async (_req, res) => {
  res.json({ references: await application.list(userId(res)) });
}));
router.get("/coverage", asyncRoute(async (_req, res) => {
  const coverage = await application.coverage();
  res.set("Cache-Control", "private, max-age=3600");
  res.json({ coverage });
}));

router.get("/search", asyncRoute(async (req, res) => {
  const selected = req.query.doc_type === "hansard"
    ? "hansard"
    : docType(req.query.doc_type);
  const query: Parameters<LegalSourceApplication["searchLibrary"]>[0] = {
    docType: selected,
    size: Number.parseInt(String(req.query.size ?? "12"), 10),
    text: searchFts5(text(req.query.query, "query")),
    syntax: "fts5" as const,
    searchType: req.query.search_type === "name" ? "name" as const : "full_text" as const,
    language: language(req.query.language),
    collection: optionalText(req.query.dataset),
    author: optionalText(req.query.author),
    journal: optionalText(req.query.journal),
    speaker: optionalText(req.query.speaker),
    dateFrom: optionalText(req.query.start_date, 10),
    dateTo: optionalText(req.query.end_date, 10),
    sort: req.query.sort_results === "newest_first"
      ? "newest" as const
      : req.query.sort_results === "oldest_first" ? "oldest" as const : "relevance" as const,
  };
  res.json(await application.searchLibrary(query));
}));
router.post("/", asyncRoute(async (req, res) => {
  const selected = docType(req.body?.doc_type);
  const citation = text(selected === "articles" ? req.body?.source_id ?? req.body?.citation
    : req.body?.citation, selected === "articles" ? "source_id" : "citation");
  res.status(201).json(await application.save(userId(res), { docType: selected, citation,
    language: language(req.body?.language), dataset: optionalText(req.body?.dataset) }));
}));
router.get("/document", asyncRoute(async (req, res) => {
  const started = performance.now();
  sendViewer(req, res, await application.viewer(userId(res), {
    citation: text(req.query.citation, "citation"),
    provider: req.query.provider === "journal" ? "journal" : "a2aj",
    docType: docType(req.query.doc_type, true),
    language: language(req.query.language),
    dataset: optionalText(req.query.dataset),
    sourceId: optionalText(req.query.source_id),
  }), started);
}));

router.get("/:referenceId/pdf-status", asyncRoute(async (req, res) => {
  res.json(await application.pdfStatus(userId(res), req.params.referenceId));
}));
router.get("/:referenceId/document", asyncRoute(async (req, res) => {
  const started = performance.now();
  sendViewer(req, res, await application.savedViewer(userId(res), req.params.referenceId), started);
}));
router.delete("/:referenceId", asyncRoute(async (req, res) => {
  await application.delete(userId(res), req.params.referenceId);
  res.status(204).end();
}));
return router;
}
