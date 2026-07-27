import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  resolveA2AJViewerDocument,
  searchA2AJ,
} from "../lib/a2aj";
import {
  fetchJournalArticle,
  resolveJournalViewerDocument,
  searchJournalArticles,
} from "../lib/journalArticles";
import {
  deleteLocalLegalSource,
  getLocalLegalSource,
  listLocalLegalSources,
  saveLocalLegalSource,
} from "../lib/localDocumentStore";

export const legalLibraryRouter = Router();

legalLibraryRouter.use(requireAuth);

function text(value: unknown, name: string, maximum = 500) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${name} is required`);
  if (result.length > maximum) throw new Error(`${name} is too long`);
  return result;
}

function optionalText(value: unknown, maximum = 200) {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length > maximum) throw new Error("value is too long");
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
  throw new Error("doc_type must be cases, laws, or articles");
}

function language(value: unknown) {
  if (value === "fr") return "fr" as const;
  if (value === "en" || value === undefined || value === "") {
    return "en" as const;
  }
  throw new Error("language must be en or fr");
}

function userId(res: Response) {
  return String(res.locals.userId);
}

function notModified(req: Request, etag: string) {
  const supplied = req.headers["if-none-match"];
  if (!supplied) return false;
  return supplied
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag);
}

async function sendViewer(
  req: Request,
  res: Response,
  pointer: {
    citation: string;
    provider?: "a2aj" | "journal";
    docType: "cases" | "laws" | "articles" | "auto";
    language: "en" | "fr";
    dataset?: string | null;
    sourceId?: string | null;
  },
) {
  const started = performance.now();
  const resolved =
    pointer.provider === "journal" || pointer.docType === "articles"
      ? resolveJournalViewerDocument(pointer.sourceId ?? pointer.citation)
      : await resolveA2AJViewerDocument({
          citation: pointer.citation,
          docType: pointer.docType,
          language: pointer.language,
          dataset: pointer.dataset ?? undefined,
        });
  res.set("Server-Timing", `legal-source;dur=${(performance.now() - started).toFixed(1)}`);
  if (!resolved) {
    res.status(404).json({ detail: "Legal source not found" });
    return;
  }
  res.set({
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: resolved.etag,
    Vary: "Authorization",
  });
  if (notModified(req, resolved.etag)) {
    res.status(304).end();
    return;
  }
  res.json(resolved.payload);
}

legalLibraryRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ references: await listLocalLegalSources(userId(res)) });
  } catch (error) {
    next(error);
  }
});

legalLibraryRouter.get("/search", async (req, res) => {
  try {
    const wanted = Number.parseInt(String(req.query.size ?? "12"), 10);
    const selectedDocType = docType(req.query.doc_type);
    if (selectedDocType === "articles") {
      const results = searchJournalArticles(
        text(req.query.query, "query"),
        Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), 25) : 12,
      );
      res.json({
        results: results.map((result) => ({
          provider: result.provider,
          doc_type: "articles" as const,
          source_id: String(result.articleId),
          dataset: result.dataset,
          citation: result.citation,
          alternateCitation: null,
          name: result.name,
          date: result.date,
          url: result.url,
          snippet: result.snippet,
        })),
      });
      return;
    }
    const results = await searchA2AJ({
      query: text(req.query.query, "query"),
      docType: selectedDocType,
      searchType: req.query.search_type === "name" ? "name" : "full_text",
      language: language(req.query.language),
      size: Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), 25) : 12,
      dataset: optionalText(req.query.dataset),
    });
    res.json({
      results: results.map((result) => ({
        ...result,
        provider: "a2aj" as const,
        doc_type: selectedDocType,
      })),
    });
  } catch (error) {
    res.status(400).json({
      detail: error instanceof Error ? error.message : "Search failed",
    });
  }
});

legalLibraryRouter.post("/", async (req, res) => {
  try {
    const requestedDocType = docType(req.body?.doc_type);
    if (requestedDocType === "articles") {
      const article = fetchJournalArticle(
        text(req.body?.source_id ?? req.body?.citation, "source_id"),
      );
      if (!article) {
        res.status(404).json({ detail: "Journal article not found" });
        return;
      }
      res.status(201).json(
        await saveLocalLegalSource({
          userId: userId(res),
          provider: "journal",
          docType: "articles",
          citation: article.citation,
          language: "en",
          dataset: article.dataset,
          sourceId: article.identity,
        }),
      );
      return;
    }
    const resolved = await resolveA2AJViewerDocument({
      citation: text(req.body?.citation, "citation"),
      docType: requestedDocType,
      language: language(req.body?.language),
      dataset: optionalText(req.body?.dataset),
    });
    if (!resolved) {
      res.status(404).json({ detail: "Legal source not found" });
      return;
    }
    const reference = resolved.payload.reference;
    res.status(201).json(
      await saveLocalLegalSource({
        userId: userId(res),
      provider: "a2aj",
        docType: reference.docType,
        citation: reference.citation,
        language: reference.language,
        dataset: reference.dataset,
      }),
    );
  } catch (error) {
    res.status(400).json({
      detail: error instanceof Error ? error.message : "Could not save source",
    });
  }
});

legalLibraryRouter.get("/document", async (req, res) => {
  try {
    await sendViewer(req, res, {
      citation: text(req.query.citation, "citation"),
      provider: req.query.provider === "journal" ? "journal" : "a2aj",
      docType: docType(req.query.doc_type, true),
      language: language(req.query.language),
      dataset: optionalText(req.query.dataset),
      sourceId: optionalText(req.query.source_id),
    });
  } catch (error) {
    res.status(400).json({
      detail: error instanceof Error ? error.message : "Could not load source",
    });
  }
});

legalLibraryRouter.get("/:referenceId/document", async (req, res) => {
  try {
    const pointer = await getLocalLegalSource(
      userId(res),
      req.params.referenceId,
    );
    if (!pointer) {
      res.status(404).json({ detail: "Library reference not found" });
      return;
    }
    await sendViewer(req, res, pointer);
  } catch (error) {
    res.status(502).json({
      detail: error instanceof Error ? error.message : "Could not load source",
    });
  }
});

legalLibraryRouter.delete("/:referenceId", async (req, res, next) => {
  try {
    const deleted = await deleteLocalLegalSource(
      userId(res),
      req.params.referenceId,
    );
    if (!deleted) {
      res.status(404).json({ detail: "Library reference not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
