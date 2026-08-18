import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  getA2AJCoverage,
  resolveA2AJViewerDocument,
  type A2AJViewerPayload,
} from "../lib/a2aj";
import { resolveJournalViewerDocument } from "../lib/journalArticles";
import {
  resolveLegalSource,
  searchLegalSources,
} from "../lib/legalSourceRegistry";
import type {
  LegalSourceKind,
  LegalSourceSearchHit,
} from "../lib/legalSources";
import {
  deleteLocalLegalSource,
  getLocalLegalSource,
  listLocalLegalSources,
  saveLocalLegalSource,
  type LocalLegalSourcePdfFallback,
} from "../lib/localDocumentStore";
import {
  providerPdfRequestReference,
  queueProviderPdfAttachment,
  readProviderPdfAttachmentState,
  type ProviderPdfAttachment,
} from "../lib/providerPdfLibraryBridge";

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

function a2ajPdfFallbackRequest(
  payload: A2AJViewerPayload,
): ProviderPdfAttachment | null {
  if (
    payload.structure.source !== "flat_text" ||
    !payload.metadata.pdfUrl ||
    !payload.metadata.url
  ) {
    return null;
  }
  return {
    provider: "a2aj",
    identity: `${payload.reference.dataset || ""}:${payload.reference.citation}`,
    structureSource: "flat_text",
    url: payload.metadata.pdfUrl,
    canonicalUrl: payload.metadata.url,
    title: payload.metadata.title,
  };
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
    pdfFallback?: LocalLegalSourcePdfFallback;
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
  const pdfFallbackRequest = pointer.pdfFallback
    ? {
        ...pointer.pdfFallback,
        structureSource: resolved.payload.structure.source,
      }
    : resolved.payload.provider === "a2aj"
      ? a2ajPdfFallbackRequest(resolved.payload)
      : null;
  if (pdfFallbackRequest) {
    void queueProviderPdfAttachment(pdfFallbackRequest).catch(() => undefined);
  }
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

legalLibraryRouter.get("/coverage", async (_req, res) => {
  try {
    const [cases, laws] = await Promise.all([
      getA2AJCoverage("cases"),
      getA2AJCoverage("laws"),
    ]);
    res.set("Cache-Control", "private, max-age=3600");
    res.json({ coverage: [...cases, ...laws] });
  } catch (error) {
    res.status(502).json({
      detail:
        error instanceof Error ? error.message : "Could not load coverage",
    });
  }
});

const searchType = {
  cases: { kind: "case", provider: "a2aj" },
  laws: { kind: "legislation", provider: "a2aj" },
  articles: { kind: "journal", provider: "journal" },
  hansard: { kind: "hansard", provider: "hansard" },
} as const;

function searchResult(result: LegalSourceSearchHit) {
  const hansard = result.kind === "hansard";
  const doc_type = {
    case: "cases",
    legislation: "laws",
    journal: "articles",
    hansard: "hansard",
  }[result.kind];
  return {
    provider: result.provider,
    doc_type,
    source_id: result.id,
    dataset: result.collection ?? (hansard ? "Hansard" : ""),
    citation: hansard
      ? [result.date, result.speaker].filter(Boolean).join(" — ") || result.id
      : result.citation ?? result.id,
    alternateCitation: result.alternateCitation ?? null,
    name: result.title ?? (hansard ? result.speaker : null) ?? null,
    date: result.date ?? null,
    url: result.url ?? null,
    snippet: result.snippet ?? null,
  };
}

legalLibraryRouter.get("/search", async (req, res) => {
  try {
    const selected = req.query.doc_type === "hansard"
      ? "hansard"
      : docType(req.query.doc_type);
    const wanted = Number.parseInt(String(req.query.size ?? "12"), 10);
    const limit = Number.isFinite(wanted)
      ? Math.min(Math.max(wanted, 1), selected === "hansard" ? 20 : 25)
      : selected === "hansard" ? 10 : 12;
    const type = searchType[selected];
    const { results } = await searchLegalSources({
      text: text(req.query.query, "query"),
      kinds: [type.kind],
      providers: [type.provider],
      searchType: req.query.search_type === "name" ? "name" : "full_text",
      language: language(req.query.language),
      collection: optionalText(req.query.dataset),
      author: optionalText(req.query.author),
      journal: optionalText(req.query.journal),
      speaker: optionalText(req.query.speaker),
      dateFrom: optionalText(req.query.start_date, 10),
      dateTo: optionalText(req.query.end_date, 10),
      sort:
        req.query.sort_results === "newest_first"
          ? "newest"
          : req.query.sort_results === "oldest_first"
            ? "oldest"
            : "relevance",
      limit,
      perProviderLimit: limit,
    });
    res.json({ results: results.map(searchResult) });
  } catch (error) {
    res.status(400).json({
      detail: error instanceof Error ? error.message : "Search failed",
    });
  }
});

legalLibraryRouter.post("/", async (req, res) => {
  try {
    const requestedDocType = docType(req.body?.doc_type);
    const expectedProvider =
      requestedDocType === "articles" ? "journal" : "a2aj";
    const sourceKind: LegalSourceKind =
      requestedDocType === "articles"
        ? "journal"
        : requestedDocType === "laws"
          ? "legislation"
          : "case";
    const matched = await resolveLegalSource({
      text: text(
        requestedDocType === "articles"
          ? req.body?.source_id ?? req.body?.citation
          : req.body?.citation,
        requestedDocType === "articles" ? "source_id" : "citation",
      ),
      kind: sourceKind,
      language: language(req.body?.language),
      collection: optionalText(req.body?.dataset),
    });
    if (
      matched.status !== "found" ||
      matched.value.provider !== expectedProvider
    ) {
      res.status(404).json({ detail: "Legal source not found" });
      return;
    }
    const source = matched.value;
    if (requestedDocType === "articles") {
      res.status(201).json(
        await saveLocalLegalSource({
          userId: userId(res),
          provider: "journal",
          docType: "articles",
          citation: source.citation ?? source.id,
          language: source.language ?? "en",
          dataset: source.collection,
          sourceId: source.id,
        }),
      );
      return;
    }
    const resolved = await resolveA2AJViewerDocument({
      citation: source.citation ?? source.id,
      docType: requestedDocType,
      language: source.language ?? "en",
      dataset: source.collection ?? undefined,
    });
    if (!resolved) {
      res.status(404).json({ detail: "Legal source not found" });
      return;
    }
    const reference = resolved.payload.reference;
    const pdfFallbackRequest = a2ajPdfFallbackRequest(resolved.payload);
    let pdfFallbackPointer: LocalLegalSourcePdfFallback | undefined;
    if (pdfFallbackRequest) {
      try {
        pdfFallbackPointer = {
          provider: "a2aj",
          identity: pdfFallbackRequest.identity,
          url: pdfFallbackRequest.url,
          canonicalUrl: pdfFallbackRequest.canonicalUrl!,
          title: pdfFallbackRequest.title,
          version: pdfFallbackRequest.version,
          requestReference: providerPdfRequestReference(pdfFallbackRequest),
        };
      } catch {
        // A bad optional attachment must not prevent saving valid provider text.
      }
    }
    const saved = await saveLocalLegalSource({
      userId: userId(res),
      provider: "a2aj",
      docType: reference.docType,
      citation: reference.citation,
      language: reference.language,
      dataset: reference.dataset,
      pdfFallback: pdfFallbackPointer,
    });
    if (pdfFallbackPointer) {
      void queueProviderPdfAttachment({
        ...pdfFallbackPointer,
        structureSource: "flat_text",
      }).catch(() => undefined);
    }
    res.status(201).json(saved);
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

legalLibraryRouter.get("/:referenceId/pdf-status", async (req, res) => {
  try {
    const pointer = await getLocalLegalSource(
      userId(res),
      req.params.referenceId,
    );
    if (!pointer?.pdfFallback) {
      res.status(404).json({ detail: "Provider PDF fallback not found" });
      return;
    }
    res.json(
      await readProviderPdfAttachmentState({
        ...pointer.pdfFallback,
        structureSource: "flat_text",
      }),
    );
  } catch (error) {
    res.status(502).json({
      detail:
        error instanceof Error
          ? error.message
          : "Could not read provider PDF status",
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
