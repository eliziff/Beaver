import crypto from "node:crypto";
import { cachedContent } from "../contentCache";
import { fetchLocalA2AJDocument, searchLocalA2AJ } from "../a2ajLocalBulk";
import { citationAuthorityMetricsBatch } from "../caselawCitator";
import { classifyLegalMarkdown, deriveOriginalPdfCandidates } from "../legalSourcePresentation";
import { guardedRemoteFetch } from "../remoteUrlSafety";
import {
  providerCitationsInTextNative,
  deriveDocumentNative,
  documentAnchorsNative,
  documentRevisionNative,
  documentTextNative,
  normalizeDocumentLocatorNative,
  type NativeDocument,
  type NativeDocumentBlock,
} from "../structureNative";
import { objectValue as object, type JsonObject } from "./remoteProvider";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import type { LegalSourceProvider, LegalSourceReference,
  LegalSourceResolveRequest, LegalSourceSearchHit } from ".";

type DocType = "cases" | "laws";
type Language = "en" | "fr";
export type A2AJLocatorKind = "paragraph" | "page" | "section";

export type A2AJDocument = {
  docType?: DocType; dataset: string;
  citation: string; alternateCitation: string | null;
  name: string | null; date: string | null; url: string | null;
  text: string; language: Language; upstreamLicense: string | null;
  sectionMap?: Record<string, string>;
};

export type A2AJCompiledDocument = Omit<A2AJDocument, "text" | "sectionMap"> & {
  native: NativeDocument;
};

const BASE_URL = "https://api.a2aj.ca";
const JURISDICTIONS = {
  FED: "Federal", AB: "Alberta", BC: "British Columbia", MB: "Manitoba",
  NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia",
  NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario",
  PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
} as const;
const TRIBUNALS = new Set([
  "CART", "CHRT", "CIRB", "CITT", "CT", "FPSLREB", "OHSTC", "OIC",
  "PSDPT", "RAD", "RLLR", "RPD", "SCT", "SST", "TATC",
]);
const documents = new Map<string, { expires: number; value: A2AJCompiledDocument }>();

async function deriveA2AJDocument(
  input: {
    citation: string; docType: DocType; text: string; id?: string;
    url?: string | null; dataset?: string | null; name?: string | null;
    alternateCitation?: string | null; sectionMap?: Record<string, string> | null;
  },
  scope: { kind: "complete" | "excerpt"; excerptOf?: string } = { kind: "complete" },
) {
  const result = await deriveDocumentNative({
    kind: "a2aj",
    input: {
      citation: input.citation,
      source_kind: input.docType,
      text: input.text,
      ...(input.id ? { id: input.id } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.dataset ? { dataset: input.dataset } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.alternateCitation ? { alternate_citation: input.alternateCitation } : {}),
      ...(input.sectionMap ? { section_map: Object.entries(input.sectionMap) } : {}),
      ...(scope.kind === "excerpt" && scope.excerptOf ? { excerpt_of: scope.excerptOf } : {}),
    },
  });
  return result;
}

const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const languageText = (record: JsonObject, field: string, language: Language) =>
  string(record[`${field}_${language}`]) ??
  string(record[`${field}_${language === "en" ? "fr" : "en"}`]) ??
  string(record[field]);

function webUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function sourceUrl(record: JsonObject, language: Language) {
  return webUrl(languageText(record, "source_url", language)) ??
    webUrl(languageText(record, "url", language));
}

function apiError(status: number, body: unknown) {
  const detail = object(body)?.detail;
  const message = string(detail) ?? (Array.isArray(detail)
    ? detail.map((item) => string(object(item)?.msg)).filter(Boolean).join("; ")
    : "");
  return new Error(message || `A2AJ API error (${status})`);
}

async function request(
  endpoint: "/fetch" | "/search" | "/coverage",
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const url = `${BASE_URL}${endpoint}?${query}`;
  const immutable = endpoint === "/fetch" && params.doc_type === "cases";
  const value = await cachedContent({
    scope: "shared",
    kind: "legal-source-a2aj",
    key: url,
    version: 1,
    ...(immutable ? {} : { ttlMs: 24 * 60 * 60_000 }),
    produce: async () => {
      const response = await guardedRemoteFetch(url, {
        headers: { Accept: "application/json" }, signal,
      }, {
        label: "A2AJ request",
        allowedHosts: ["api.a2aj.ca"],
        defaultPortOnly: true,
        allowIpLiterals: false,
        timeoutMs: 15_000,
        response: {
          label: "A2AJ response",
          maxBytes: 64 * 1024 * 1024,
          contentTypes: ["application/json", "application/*+json"],
        },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw apiError(response.status, body);
      return object(body) ?? {};
    },
  });
  signal?.throwIfAborted();
  return value;
}

function sectionMap(record: JsonObject, language: Language) {
  let value = record[`unofficial_sections_${language}`] ??
    record[`unofficial_sections_${language === "en" ? "fr" : "en"}`];
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const mapped = object(value);
  if (!mapped) return null;
  const entries = Object.entries(mapped).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length ? Object.fromEntries(entries) : null;
}

function mapDocument(value: unknown, language: Language, docType: DocType) {
  const record = object(value);
  if (!record) return null;
  const actualLanguage = string(record[`unofficial_text_${language}`])
    ? language : language === "en" ? "fr" : "en";
  const text = languageText(record, "unofficial_text", actualLanguage);
  const citation = languageText(record, "citation", actualLanguage) ??
    languageText(record, "citation2", actualLanguage);
  if (!text || !citation) return null;
  const document: A2AJDocument = {
    docType,
    dataset: string(record.dataset) ?? "",
    citation,
    alternateCitation: languageText(record, "citation2", actualLanguage),
    name: languageText(record, "name", actualLanguage),
    date: languageText(record, "document_date", actualLanguage),
    url: sourceUrl(record, actualLanguage),
    text,
    language: actualLanguage,
    upstreamLicense: string(record.upstream_license),
    sectionMap: sectionMap(record, actualLanguage) ?? undefined,
  };
  return document;
}

async function compileDocument(document: A2AJDocument): Promise<A2AJCompiledDocument> {
  const native = await deriveA2AJDocument({
    citation: document.citation,
    docType: document.docType ?? "cases",
    text: document.sectionMap ? "" : document.text,
    url: document.url,
    alternateCitation: document.alternateCitation,
    dataset: document.dataset,
    name: document.name,
    sectionMap: document.sectionMap,
  });
  return compiledDocument(document, native);
}

function locator(value: string) {
  return normalizeDocumentLocatorNative("section", value).replace(/^sec/iu, "");
}

async function scopedDocument(document: A2AJDocument, requested: string, text: string) {
  const label = locator(requested);
  if (!label || !text.trim()) return null;
  const compiled = await deriveA2AJDocument({
    citation: document.citation, docType: "laws", text, id: document.citation,
    url: document.url, alternateCitation: document.alternateCitation,
    dataset: document.dataset, name: document.name, sectionMap: { [label]: text },
  }, { kind: "excerpt", excerptOf: document.citation });
  return compiledDocument(document, compiled);
}

function compiledDocument(
  document: A2AJDocument,
  native: NativeDocument,
): A2AJCompiledDocument {
  const { text: _text, sectionMap: _sectionMap, ...metadata } = document;
  return { ...metadata, native };
}

async function document(args: {
  citation: string; docType?: DocType; language?: Language; dataset?: string;
  section?: string; signal?: AbortSignal;
}) {
  const citation = args.citation.trim();
  if (!citation) throw new Error("citation is required");
  args.signal?.throwIfAborted();
  const docType = args.docType ?? "cases";
  const language = args.language === "fr" ? "fr" : "en";
  const key = JSON.stringify([
    docType, language, args.dataset?.trim().toLowerCase() ?? "",
    citation.toLowerCase(), args.section?.trim().toLowerCase() ?? "",
  ]);
  const cached = documents.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (cached) documents.delete(key);
  let source = args.section?.trim() ? null : fetchLocalA2AJDocument({
    citation, docType, language, dataset: args.dataset, maxChars: Number.MAX_SAFE_INTEGER,
  });
  if (!source) {
    const payload = await request("/fetch", {
      citation, doc_type: docType, output_language: language, section: args.section?.trim(),
    }, args.signal);
    source = (Array.isArray(payload.results) ? payload.results : [])
      .map((item) => mapDocument(item, language, docType))
      .find((item): item is A2AJDocument => !!item && (!args.dataset?.trim() ||
        item.dataset.toLowerCase() === args.dataset.trim().toLowerCase())) ?? null;
  }
  if (!source) return null;
  const result = args.section?.trim()
    ? await scopedDocument(source, args.section, source.text)
    : await compileDocument(source);
  if (!result) return null;
  documents.set(key, {
    expires: Date.now() + (docType === "cases" ? 24 * 60 * 60_000 : 60 * 60_000),
    value: result,
  });
  if (documents.size > 32) documents.delete(documents.keys().next().value!);
  return result;
}

function searchResult(value: unknown, language: Language) {
  const record = object(value);
  const citation = record && (languageText(record, "citation", language) ??
    languageText(record, "citation2", language));
  if (!record || !citation) return null;
  const snippet = languageText(record, "snippet", language) ??
    languageText(record, "highlight", language) ??
    languageText(record, "unofficial_text", language);
  return {
    dataset: string(record.dataset) ?? "", citation,
    alternateCitation: languageText(record, "citation2", language),
    name: languageText(record, "name", language),
    date: languageText(record, "document_date", language),
    url: sourceUrl(record, language), snippet: snippet?.slice(0, 1200) ?? null,
  };
}

export type A2AJSearchResult = NonNullable<ReturnType<typeof searchResult>>;

async function search(args: {
  query: string; docType?: DocType; searchType?: "full_text" | "name";
  language?: Language; size?: number; dataset?: string; startDate?: string;
  endDate?: string; sortResults?: "default" | "newest_first" | "oldest_first";
  querySyntax?: "terms" | "fts5"; signal?: AbortSignal;
}) {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  const language = args.language === "fr" ? "fr" : "en";
  const local = searchLocalA2AJ({ ...args, query, language, docType: args.docType ?? "cases" });
  if (local !== null) return local;
  const payload = await request("/search", {
    query, doc_type: args.docType ?? "cases", search_type: args.searchType ?? "full_text",
    search_language: language, size: Math.min(Math.max(Math.floor(args.size ?? 10), 1), 50),
    dataset: args.dataset?.trim(), start_date: args.startDate?.trim(), end_date: args.endDate?.trim(),
    sort_results: args.sortResults ?? "default",
  }, args.signal);
  return (Array.isArray(payload.results) ? payload.results : [])
    .map((item) => searchResult(item, language))
    .filter((item): item is A2AJSearchResult => !!item).slice(0, 50);
}

function jurisdiction(dataset: string, docType: DocType): keyof typeof JURISDICTIONS {
  if (docType === "laws") {
    const suffix = dataset.toUpperCase().match(/-([A-Z]{2,3})$/u)?.[1];
    if (suffix === "YK") return "YT";
    return suffix && suffix in JURISDICTIONS ? suffix as keyof typeof JURISDICTIONS : "FED";
  }
  const prefix = dataset.toUpperCase().slice(0, 2);
  if (prefix === "YK") return "YT";
  return prefix in JURISDICTIONS && prefix !== "FE"
    ? prefix as keyof typeof JURISDICTIONS : "FED";
}

async function coverage(docType: DocType) {
  const payload = await request("/coverage", { doc_type: docType });
  return (Array.isArray(payload.results) ? payload.results : []).flatMap((value) => {
    const record = object(value);
    const dataset = string(record?.dataset)?.toUpperCase();
    if (!record || !dataset) return [];
    const code = jurisdiction(dataset, docType);
    const count = Number.parseInt(String(record.number_of_documents ?? "0"), 10);
    return [{
      dataset,
      description: string(record.description_en) ?? string(record.description_fr) ?? dataset,
      descriptionFr: string(record.description_fr), docType,
      jurisdictionCode: code, jurisdiction: JURISDICTIONS[code],
      sourceKind: docType === "laws"
        ? dataset.startsWith("REGULATIONS-") ? "regulation" as const : "legislation" as const
        : TRIBUNALS.has(dataset) || /\b(?:board|commissioner|division|reporter|tribunal)\b/iu
          .test(string(record.description_en) ?? "") ? "tribunal" as const : "court" as const,
      earliestDate: string(record.earliest_document_date),
      latestDate: string(record.latest_document_date),
      documentCount: Number.isFinite(count) ? count : 0,
    }];
  }).sort((left, right) => left.jurisdiction.localeCompare(right.jurisdiction) ||
    left.description.localeCompare(right.description));
}

export type A2AJCoverageResult = Awaited<ReturnType<typeof coverage>>[number];

function readerSegments(text: string, anchors: Array<{ kind: string; start: number }>,
  docType: DocType) {
  const kind = docType === "laws" ? "section" : "paragraph";
  const starts = [...new Set([0, ...anchors.filter((anchor) =>
    anchor.start >= 0 && anchor.start < text.length &&
    (anchor.kind === kind || anchor.kind === "page")).map((anchor) => anchor.start), text.length])]
    .sort((left, right) => left - right);
  return starts.slice(0, -1).flatMap((start, index) => {
    const end = starts[index + 1];
    let value = text.slice(start, end).trim();
    if (docType === "cases" && start === 0) {
      const marker = value.match(/\bDecision Content\b\s*/iu);
      if (marker?.index !== undefined) value = value.slice(marker.index + marker[0].length)
        .split(/\n/gu).map((line) => line.trim()).filter(Boolean).join("\n\n");
    }
    const blocks = classifyLegalMarkdown(value);
    return blocks.length ? [{ start, end, blocks }] : [];
  });
}

async function viewer(args: {
  citation: string; docType?: DocType | "auto"; language?: Language;
  dataset?: string; maxChars?: number;
}) {
  const max = Math.min(Math.max(Math.trunc(args.maxChars ?? 5_000_000), 1), 10_000_000);
  const types: DocType[] = args.docType === "auto" ? ["cases", "laws"] : [args.docType ?? "cases"];
  for (const docType of types) {
    const found = await document({ ...args, docType });
    if (!found) continue;
    const compiled = found.native;
    const fullText = documentTextNative(compiled);
    const text = fullText.slice(0, max);
    const anchors = documentAnchorsNative(compiled).filter(({ start }) => start < text.length)
      .map((anchor) => ({ ...anchor, end: Math.min(anchor.end, text.length) }));
    const payload = {
      schemaVersion: "mike.legal-source.v1" as const, provider: "a2aj" as const,
      reference: { docType, citation: found.citation, language: found.language,
        dataset: found.dataset || null },
      metadata: {
        title: found.name || found.citation, citation: found.citation,
        alternateCitation: found.alternateCitation, date: found.date, dataset: found.dataset,
        url: found.url, pdfUrl: found.url ? deriveOriginalPdfCandidates({ canonicalUrl: found.url })[0]?.url ?? null : null,
        language: found.language, upstreamLicense: found.upstreamLicense,
      },
      text,
      anchors,
      presentation: { source: "a2aj_markdown" as const, segments: readerSegments(text, anchors, docType) },
      truncated: fullText.length > max,
    };
    const digest = crypto.createHash("sha256").update(JSON.stringify([
      documentRevisionNative(compiled), payload.reference, payload.metadata, max,
    ])).digest("base64url");
    return { payload, etag: `"${digest}"`, native: compiled };
  }
  return null;
}

export type A2AJViewerPayload = NonNullable<Awaited<ReturnType<typeof viewer>>>["payload"];

function reference(document: A2AJDocument | A2AJCompiledDocument,
  kind: "case" | "legislation") {
  return {
    provider: "a2aj", id: document.citation, kind, title: document.name,
    citation: document.citation, alternateCitation: document.alternateCitation,
    date: document.date, collection: document.dataset, language: document.language,
    url: document.url,
  } satisfies LegalSourceReference;
}

function rankCases(rows: LegalSourceSearchHit[], mode: "relevance" | "most_cited" | "most_discussed") {
  const metrics = citationAuthorityMetricsBatch(rows.map((row) => row.citation ?? ""));
  const authority = rows.map((_, index) => index)
    .filter((index) => (metrics[index]?.citingCases ?? 0) > 0)
    .sort((a, b) => (metrics[b]?.distinctCitingParagraphs ?? 0) -
      (metrics[a]?.distinctCitingParagraphs ?? 0) ||
      (metrics[b]?.citingCases ?? 0) - (metrics[a]?.citingCases ?? 0));
  const rank = new Map(authority.map((index, place) => [index, place]));
  return rows.map((row, textRank) => ({ row, metric: metrics[textRank], textRank,
    score: 1 / (60 + textRank) + (rank.has(textRank) ? 0.15 / (60 + rank.get(textRank)!) : 0) }))
    .sort((a, b) => mode === "most_cited"
      ? (b.metric?.citingCases ?? 0) - (a.metric?.citingCases ?? 0) || a.textRank - b.textRank
      : mode === "most_discussed"
        ? (b.metric?.distinctCitingParagraphs ?? 0) - (a.metric?.distinctCitingParagraphs ?? 0) ||
          (b.metric?.occurrences ?? 0) - (a.metric?.occurrences ?? 0) || a.textRank - b.textRank
        : b.score - a.score || a.textRank - b.textRank)
    .map(({ row, metric }) => ({ ...row, ...(metric && metric.citingCases > 0 ? { authority: {
      citingCases: metric.citingCases, citingParagraphs: metric.distinctCitingParagraphs,
      occurrences: metric.occurrences,
    } } : {}) }));
}

const provider: LegalSourceProvider<NativeDocument | NativeDocumentBlock,
  A2AJCompiledDocument> = {
  id: "a2aj",
  canResolve: (request: LegalSourceResolveRequest) => request.kind === "legislation" ||
    (request.kind === "case" && providerCitationsInTextNative(request.text)
      .some(({ jurisdiction }) => jurisdiction === "ca")),
  async resolve(request) {
    const kind = request.kind === "legislation" ? "legislation" : "case";
    const found = await document({ citation: request.text,
      docType: kind === "legislation" ? "laws" : "cases",
      language: request.language, dataset: request.collection, signal: request.signal });
    return found ? [reference(found, kind)] : [];
  },
  async readPassage(request) {
    const docType = request.source.kind === "legislation" ? "laws" : "cases";
    const citation = request.source.citation || request.source.id;
    if (request.locator?.kind === "footnote") return [];
    const load = async (section?: string) => {
      const found = await document({ citation, docType,
        language: request.source.language,
        dataset: request.source.collection ?? undefined, section,
        signal: request.signal });
      if (!found) return [];
      return nativeDocumentPassages({ request,
        reference: reference(found, request.source.kind as "case" | "legislation"),
        document: found.native, native: found });
    };
    const passages = await load();
    if (passages.length || docType !== "laws" ||
        request.locator?.kind !== "section") return passages;
    const label = locator(request.locator.value);
    return label ? load(label) : [];
  },
  canSearch(request) {
    const place = request.jurisdiction?.toLocaleLowerCase().replace(/[^a-z]/gu, "");
    return !["us", "usa", "unitedstates", "unitedstatesofamerica"].includes(place ?? "") &&
      request.kinds.some((kind) => kind === "case" || kind === "legislation");
  },
  async search(request) {
    const hits: LegalSourceSearchHit[] = [];
    for (const kind of ["case", "legislation"] as const) {
      if (!request.kinds.includes(kind)) continue;
      const docType = kind === "case" ? "cases" : "laws";
      const rows = (await search({ query: request.text, docType,
        searchType: request.searchType, language: request.language,
        size: request.perProviderLimit ?? request.limit, dataset: request.collection,
        startDate: request.dateFrom, endDate: request.dateTo,
        sortResults: request.sort === "newest" ? "newest_first" :
          request.sort === "oldest" ? "oldest_first" : "default",
        querySyntax: request.syntax, signal: request.signal }))
        .map((row): LegalSourceSearchHit => ({ provider: "a2aj", id: row.citation, kind,
          title: row.name, citation: row.citation, alternateCitation: row.alternateCitation,
          date: row.date, collection: row.dataset, url: row.url, snippet: row.snippet }));
      hits.push(...(kind === "case" && ["relevance", "most_cited", "most_discussed"].includes(request.sort ?? "")
        ? rankCases(rows, request.sort as "relevance" | "most_cited" | "most_discussed") : rows));
    }
    return hits;
  },
};

const artifact = (value: A2AJCompiledDocument) => value.native;

export const a2ajLegalSourceProvider = Object.assign(provider, {
  jurisdictions: JURISDICTIONS,
  document,
  source: artifact,
  viewer,
  coverage,
  clearCache() { documents.clear(); },
});
