import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { ApplicationError, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import {
  a2ajLegalSourceProvider,
  type A2AJViewerPayload,
} from "../lib/legalSources/a2aj";
import { courtlistenerLegalSourceProvider } from "../lib/legalSources/courtlistener";
import { journalLegalSourceProvider } from "../lib/legalSources/journal";
import {
  resolveLegalSource,
  searchLegalSources,
} from "../lib/legalSourceRegistry";
import type {
  LegalSourceKind,
  LegalSourceSearchHit,
} from "../lib/legalSources";
import {
  deleteSqliteLegalSource,
  getSqliteLegalSource,
  listSqliteLegalSources,
  saveSqliteLegalSource,
  type SqliteLegalSourcePdfRendition,
} from "../lib/sqlitePersistence";
import {
  providerPdfRequestReference,
  queueProviderPdfAttachment,
  readProviderPdfAttachmentState,
  type ProviderPdfAttachment,
} from "../lib/providerPdfLibraryBridge";
import { getUserModelSettings } from "../lib/userSettings";

export const legalLibraryRouter = Router();

legalLibraryRouter.use(requireAuth);

function text(value: unknown, name: string, maximum = 500) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) reject(400, `${name} is required`);
  if (result.length > maximum) reject(400, `${name} is too long`);
  return result;
}

function optionalText(value: unknown, maximum = 200) {
  const result = typeof value === "string" ? value.trim() : "";
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

async function providerCall<T>(message: string, operation: () => T): Promise<Awaited<T>> {
  try {
    return await operation() as Awaited<T>;
  } catch {
    throw new ApplicationError(502, message);
  }
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

function a2ajPdfRenditionRequest(
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
    pdfRendition?: SqliteLegalSourcePdfRendition;
  },
) {
  const started = performance.now();
  const request = pointer.provider === "journal" || pointer.docType === "articles"
    ? journalLegalSourceProvider.viewer(pointer.sourceId ?? pointer.citation)
    : a2ajLegalSourceProvider.viewer({
        citation: pointer.citation,
        docType: pointer.docType,
        language: pointer.language,
        dataset: pointer.dataset ?? undefined,
      });
  const resolved = await providerCall("Legal source provider unavailable", () => request);
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
  const pdfRenditionRequest = pointer.pdfRendition
    ? {
        ...pointer.pdfRendition,
        structureSource: resolved.payload.structure.source,
      }
    : resolved.payload.provider === "a2aj"
      ? a2ajPdfRenditionRequest(resolved.payload)
      : null;
  if (pdfRenditionRequest) {
    void queueProviderPdfAttachment(pdfRenditionRequest, userId(res)).catch(() => undefined);
  }
  if (notModified(req, resolved.etag)) {
    res.status(304).end();
    return;
  }
  res.json(resolved.payload);
}

legalLibraryRouter.get("/", asyncRoute(async (_req, res) => {
  res.json({ references: await listSqliteLegalSources(userId(res)) });
}));
legalLibraryRouter.get("/coverage", asyncRoute(async (_req, res) => {
  const [cases, laws] = await providerCall("Legal source coverage unavailable", () =>
    Promise.all([
      a2ajLegalSourceProvider.coverage("cases"),
      a2ajLegalSourceProvider.coverage("laws"),
    ]));
  res.set("Cache-Control", "private, max-age=3600");
  res.json({ coverage: [...cases, ...laws] });
}));

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

legalLibraryRouter.get("/search", asyncRoute(async (req, res) => {
  const selected = req.query.doc_type === "hansard"
    ? "hansard"
    : docType(req.query.doc_type);
  const wanted = Number.parseInt(String(req.query.size ?? "12"), 10);
  const limit = Number.isFinite(wanted)
    ? Math.min(Math.max(wanted, 1), selected === "hansard" ? 20 : 25)
    : selected === "hansard" ? 10 : 12;
  const type = searchType[selected];
  const query = {
    text: text(req.query.query, "query"),
    kinds: [type.kind],
    providers: [type.provider],
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
    limit,
    perProviderLimit: limit,
  };
  const { results } = await providerCall("Legal source search unavailable", () =>
    searchLegalSources(query));
  res.json({ results: results.map(searchResult) });
}));

legalLibraryRouter.post("/", asyncRoute(async (req, res) => {
  const requestedDocType = docType(req.body?.doc_type);
  const expectedProvider = requestedDocType === "articles" ? "journal" : "a2aj";
  const sourceKind: LegalSourceKind = requestedDocType === "articles"
    ? "journal"
    : requestedDocType === "laws" ? "legislation" : "case";
  const resolveInput = {
    text: text(
      requestedDocType === "articles"
        ? req.body?.source_id ?? req.body?.citation
        : req.body?.citation,
      requestedDocType === "articles" ? "source_id" : "citation",
    ),
    kind: sourceKind,
    language: language(req.body?.language),
    collection: optionalText(req.body?.dataset),
  };
  const matched = await providerCall("Legal source provider unavailable", () =>
    resolveLegalSource(resolveInput));
  if (matched.status !== "found" || matched.value.provider !== expectedProvider) {
    res.status(404).json({ detail: "Legal source not found" });
    return;
  }
  const source = matched.value;
  if (requestedDocType === "articles") {
    res.status(201).json(await saveSqliteLegalSource({
      userId: userId(res),
      provider: "journal",
      docType: "articles",
      citation: source.citation ?? source.id,
      language: source.language ?? "en",
      dataset: source.collection ?? null,
      sourceId: source.id,
    }));
    return;
  }
  const resolved = await providerCall("Legal source provider unavailable", () =>
    a2ajLegalSourceProvider.viewer({
      citation: source.citation ?? source.id,
      docType: requestedDocType,
      language: source.language ?? "en",
      dataset: source.collection ?? undefined,
    }));
  if (!resolved) {
    res.status(404).json({ detail: "Legal source not found" });
    return;
  }
  const reference = resolved.payload.reference;
  const pdfRenditionRequest = a2ajPdfRenditionRequest(resolved.payload);
  let pdfRenditionPointer: SqliteLegalSourcePdfRendition | undefined;
  if (pdfRenditionRequest) {
    try {
      pdfRenditionPointer = {
        provider: "a2aj",
        identity: pdfRenditionRequest.identity,
        url: pdfRenditionRequest.url,
        canonicalUrl: pdfRenditionRequest.canonicalUrl!,
        title: pdfRenditionRequest.title,
        version: pdfRenditionRequest.version,
        requestReference: providerPdfRequestReference(pdfRenditionRequest),
      };
    } catch {
      // A bad optional attachment must not prevent saving valid provider text.
    }
  }
  const saved = await saveSqliteLegalSource({
    userId: userId(res),
    provider: "a2aj",
    docType: reference.docType,
    citation: reference.citation,
    language: reference.language,
    dataset: reference.dataset,
    pdfRendition: pdfRenditionPointer,
  });
  if (pdfRenditionPointer) {
    void queueProviderPdfAttachment({
      ...pdfRenditionPointer,
      structureSource: "flat_text",
    }, userId(res)).catch(() => undefined);
  }
  res.status(201).json(saved);
}));

legalLibraryRouter.get("/document", asyncRoute(async (req, res) => {
  await sendViewer(req, res, {
    citation: text(req.query.citation, "citation"),
    provider: req.query.provider === "journal" ? "journal" : "a2aj",
    docType: docType(req.query.doc_type, true),
    language: language(req.query.language),
    dataset: optionalText(req.query.dataset),
    sourceId: optionalText(req.query.source_id),
  });
}));

legalLibraryRouter.get("/courtlistener/:clusterId/opinions", asyncRoute(async (req, res) => {
  const clusterId = Number(req.params.clusterId);
  if (!Number.isSafeInteger(clusterId) || clusterId <= 0) {
    reject(400, "clusterId must be a positive integer");
  }
  const settings = await getUserModelSettings(userId(res));
  const fetched = await providerCall("CourtListener is unavailable", () =>
    courtlistenerLegalSourceProvider.caseOpinions({
      clusterId,
      includeFullText: true,
      maxChars: 50_000,
      apiToken: settings.api_keys.courtlistener,
    }));
  res.json({
    opinions:
      "opinions" in fetched && Array.isArray(fetched.opinions)
        ? fetched.opinions
        : [],
  });
}));

legalLibraryRouter.get("/:referenceId/pdf-status", asyncRoute(async (req, res) => {
  const pointer = await getSqliteLegalSource(
    userId(res),
    req.params.referenceId,
  );
  const pdfRendition = pointer?.pdfRendition;
  if (!pdfRendition) {
    res.status(404).json({ detail: "Provider PDF rendition not found" });
    return;
  }
  res.json(
    await providerCall("Provider PDF status unavailable", () =>
      readProviderPdfAttachmentState({
        ...pdfRendition,
        structureSource: "flat_text",
      }, userId(res))),
  );
}));

legalLibraryRouter.get("/:referenceId/document", asyncRoute(async (req, res) => {
  const pointer = await getSqliteLegalSource(
    userId(res),
    req.params.referenceId,
  );
  if (!pointer) {
    res.status(404).json({ detail: "Library reference not found" });
    return;
  }
  await sendViewer(req, res, pointer);
}));

legalLibraryRouter.delete("/:referenceId", asyncRoute(async (req, res) => {
  const deleted = await deleteSqliteLegalSource(
    userId(res),
    req.params.referenceId,
  );
  if (!deleted) {
    res.status(404).json({ detail: "Library reference not found" });
    return;
  }
  res.status(204).end();
}));
