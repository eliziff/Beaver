import crypto from "node:crypto";
import { cachedContent } from "../contentCache";
import { a2ajLocalBulkPath, a2ajSourceDocCachePath, fetchLocalA2AJDocument, getLocalA2AJSectionMap,
  getLocalA2AJSourceId,
  searchLocalA2AJ } from "../a2ajLocalBulk";
import { citationAuthorityMetricsBatch } from "../caselawCitator";
import { sha256 } from "../hash";
import { classifyLegalMarkdown, deriveOriginalPdfCandidates } from "../legalSourcePresentation";
import { guardedRemoteFetch } from "../remoteUrlSafety";
import {
  lookupSourceDoc,
  lookupSourceDocLabel,
  normalizeSourceDocLocator,
  sliceSourceDocBlocks,
  sourceDocBlockText,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLocatorKind,
  type SourceDocLookup,
} from "../sourceDoc";
import { readCachedSourceDoc } from "../sourceDocCache";
import { summarizeA2AJSourceDoc, type A2AJStructureSummary } from "../sourceDocA2AJ";
import { deriveA2AJSourceDoc } from "../sourceDocStructureHost";
import { objectValue as object, type JsonObject } from "./remoteProvider";
import type { LegalSourcePassage, LegalSourceProvider, LegalSourceReference,
  LegalSourceResolveRequest, LegalSourceSearchHit } from ".";

type DocType = "cases" | "laws";
type Language = "en" | "fr";
export type A2AJLocatorKind = Exclude<SourceDocLocatorKind, "footnote">;

export type A2AJDocument = {
  docType?: DocType; dataset: string;
  citation: string; alternateCitation: string | null;
  name: string | null; date: string | null; url: string | null;
  text: string; language: Language; upstreamLicense: string | null; structure: A2AJStructureSummary;
};

export type A2AJLocatorLookup = {
  status: SourceDocLookup["status"]; citation: string;
  alternateCitation: string | null; name: string | null;
  dataset: string; url: string | null; language: Language;
  requested: { kind: A2AJLocatorKind; locator: string; label: string };
  matches: string[]; block: (SourceDocBlock & { text: string }) | null;
  before: Array<SourceDocBlock & { text: string }>;
  after: Array<SourceDocBlock & { text: string }>;
  structure: A2AJStructureSummary; sourceMethod: "structure_index" | "provider_section";
};

type StructureView = A2AJStructureSummary & {
  blocks: Array<Pick<SourceDocBlock, "kind" | "label" | "start" | "end">>;
};

const BASE_URL = "https://api.a2aj.ca";
const EMPTY_STRUCTURE: A2AJStructureSummary = {
  status: "unavailable",
  source: "flat_text",
  counts: { paragraph: 0, page: 0, section: 0 },
};
const CANADIAN_CITATION =
  /\b(?:\d{4}\s+[A-Z][A-Z0-9]{1,12}\s+\d+|\d+\s+S\.?C\.?R\.?\s+\d+|R\.?S\.?[A-Z]\.?\s+\d{4})\b/iu;
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
const documents = new Map<string, { expires: number; value: A2AJDocument }>();
const sourceDocs = new WeakMap<A2AJDocument, Promise<SourceDoc>>();
const resolvedSourceDocs = new WeakMap<A2AJDocument, SourceDoc>();
const sectionMaps = new WeakMap<A2AJDocument, Record<string, string>>();
const lookupDocs = new WeakMap<A2AJLocatorLookup, SourceDoc>();

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
    structure: EMPTY_STRUCTURE,
  };
  const mapped = sectionMap(record, actualLanguage);
  if (mapped) sectionMaps.set(document, mapped);
  return document;
}

export async function a2ajSourceDoc(document: A2AJDocument) {
  const cached = sourceDocs.get(document);
  if (cached) return cached;
  const sourceId = getLocalA2AJSourceId(document);
  if (sourceId) {
    try {
      const stored = readCachedSourceDoc(
        a2ajSourceDocCachePath(), a2ajLocalBulkPath(), "a2aj", sourceId, document.text,
      );
      if (stored) {
        sourceDocs.set(document, Promise.resolve(stored));
        resolvedSourceDocs.set(document, stored);
        document.text = stored.text;
        document.structure = summarizeA2AJSourceDoc(stored);
        return stored;
      }
    } catch {
      // An API-only or not-yet-enriched provider database takes the same direct path below.
    }
  }
  const providerSections = getLocalA2AJSectionMap(document) ?? sectionMaps.get(document);
  const pending = deriveA2AJSourceDoc({
    citation: document.citation,
    docType: document.docType ?? "cases",
    text: providerSections ? "" : document.text,
    url: document.url,
    alternateCitation: document.alternateCitation,
    dataset: document.dataset,
    name: document.name,
    sectionMap: providerSections,
  });
  sourceDocs.set(document, pending);
  const compiled = await pending;
  resolvedSourceDocs.set(document, compiled);
  document.text = compiled.text;
  document.structure = summarizeA2AJSourceDoc(compiled);
  return compiled;
}

function locator(value: string) {
  const stripped = value.trim()
    .replace(/^(?:(?:sections?)\s+|ss?\.?(?=\s)\s*)/iu, "")
    .replace(/^sec(?=[\p{L}\p{N}])/iu, "").trim();
  return stripped && (normalizeSourceDocLocator("section", stripped) || `sec${stripped}`);
}

async function scopedDocument(document: A2AJDocument, requested: string, text: string) {
  const label = locator(requested).replace(/^sec/iu, "");
  if (!label || !text.trim()) return null;
  const doc = await deriveA2AJSourceDoc({
    citation: document.citation, docType: "laws", text, id: document.citation,
    url: document.url, alternateCitation: document.alternateCitation,
    dataset: document.dataset, name: document.name, sectionMap: { [label]: text },
  }, { kind: "excerpt", excerptOf: document.citation });
  return compiledDocument(document, doc);
}

function compiledDocument(document: A2AJDocument, doc: SourceDoc) {
  const result = { ...document, docType: "laws" as const, text: doc.text,
    structure: summarizeA2AJSourceDoc(doc) };
  sourceDocs.set(result, Promise.resolve(doc));
  resolvedSourceDocs.set(result, doc);
  return result;
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
  let result = args.section?.trim() ? null : fetchLocalA2AJDocument({
    citation, docType, language, dataset: args.dataset, maxChars: Number.MAX_SAFE_INTEGER,
  });
  if (!result) {
    const payload = await request("/fetch", {
      citation, doc_type: docType, output_language: language, section: args.section?.trim(),
    }, args.signal);
    result = (Array.isArray(payload.results) ? payload.results : [])
      .map((item) => mapDocument(item, language, docType))
      .find((item): item is A2AJDocument => !!item && (!args.dataset?.trim() ||
        item.dataset.toLowerCase() === args.dataset.trim().toLowerCase())) ?? null;
    if (result && args.section?.trim()) result = await scopedDocument(result, args.section, result.text);
  }
  if (!result) return null;
  await a2ajSourceDoc(result);
  documents.set(key, {
    expires: Date.now() + (docType === "cases" ? 24 * 60 * 60_000 : 60 * 60_000),
    value: result,
  });
  if (documents.size > 32) documents.delete(documents.keys().next().value!);
  return result;
}

function lookupResult(
  document: A2AJDocument,
  requested: { kind: A2AJLocatorKind; locator: string },
  result: SourceDocLookup,
  method: A2AJLocatorLookup["sourceMethod"],
  artifact: SourceDoc,
) {
  const lookup: A2AJLocatorLookup = {
    status: result.status,
    citation: document.citation,
    alternateCitation: document.alternateCitation,
    name: document.name,
    dataset: document.dataset,
    url: document.url,
    language: document.language,
    requested: { ...requested, label: result.requestedLabel },
    matches: result.matches,
    block: result.block,
    before: result.before,
    after: result.after,
    structure: summarizeA2AJSourceDoc(artifact),
    sourceMethod: method,
  };
  lookupDocs.set(lookup, artifact);
  return lookup;
}

function isProviderSection(doc: SourceDoc, label: string) {
  let block = doc.blocks.find((candidate) => candidate.label === label);
  const seen = new Set<string>();
  while (block && !seen.has(block.label)) {
    if (block.origin === "native") return true;
    seen.add(block.label);
    block = block.parentLabel
      ? doc.blocks.find((candidate) => candidate.label === block!.parentLabel)
      : undefined;
  }
  return false;
}

async function lookup(args: {
  citation: string; docType?: DocType; language?: Language; dataset?: string;
  kind: A2AJLocatorKind; locator: string; endLocator?: string;
  contextBlocks?: number; signal?: AbortSignal;
}) {
  const requested = args.locator.trim();
  if (!requested) throw new Error("locator is required");
  if (args.endLocator?.trim() && args.kind !== "paragraph") {
    throw new Error("end_locator is supported only for paragraph ranges");
  }
  const docType = args.docType ?? "cases";
  const found = await document({ ...args, docType });
  if (!found) return null;
  const compiled = await a2ajSourceDoc(found);
  const end = args.endLocator?.trim();
  if (end) {
    const blocks = sliceSourceDocBlocks(compiled, "paragraph", requested, end);
    const first = blocks[0];
    const last = blocks.at(-1);
    const label = `${normalizeSourceDocLocator("paragraph", requested)}-${normalizeSourceDocLocator("paragraph", end)}`;
    if (!first || !last) return lookupResult(found,
      { kind: "paragraph", locator: `${requested}-${end}` },
      { status: "not_found", requestedLabel: label, matches: [], block: null, before: [], after: [] },
      "structure_index", compiled);
    const paragraphs = compiled.blocks.filter((block) => block.kind === "paragraph");
    const context = Math.min(Math.max(Math.trunc(args.contextBlocks ?? 0), 0), 2);
    const materialize = (block: SourceDocBlock) => ({ ...block, text: sourceDocBlockText(compiled, block) });
    return lookupResult(found, { kind: "paragraph", locator: `${requested}-${end}` }, {
      status: "found", requestedLabel: label, matches: blocks.map((block) => block.label),
      block: { ...first, label, aliases: undefined, end: last.end,
        text: compiled.text.slice(first.start, last.end).trim() },
      before: paragraphs.slice(Math.max(0, paragraphs.indexOf(first) - context), paragraphs.indexOf(first)).map(materialize),
      after: paragraphs.slice(paragraphs.indexOf(last) + 1, paragraphs.indexOf(last) + 1 + context).map(materialize),
    }, "structure_index", compiled);
  }
  const result = args.kind === "section" && docType === "laws"
    ? lookupSourceDocLabel(compiled, "section", locator(requested), args.contextBlocks)
    : lookupSourceDoc(compiled, args.kind, requested, args.contextBlocks);
  const providerSection = args.kind === "section" && docType === "laws" &&
    result.matches.some((label) => isProviderSection(compiled, label));
  if (result.status === "ambiguous") return lookupResult(found,
    { kind: args.kind, locator: requested }, result,
    providerSection ? "provider_section" : "structure_index", compiled);
  if (args.kind === "section" && docType === "laws" && result.status !== "found") {
    const label = locator(requested);
    const native = label && await document({ ...args, docType, section: label.replace(/^sec/iu, "") });
    if (native) {
      const nativeDoc = await a2ajSourceDoc(native);
      const nativeLookup = lookupSourceDocLabel(nativeDoc, "section", label);
      if (nativeLookup.status === "found") return lookupResult(found,
        { kind: "section", locator: requested }, nativeLookup,
        "provider_section", nativeDoc);
    }
  }
  return lookupResult(found, { kind: args.kind, locator: requested }, result,
    providerSection ? "provider_section" : "structure_index", compiled);
}

function lookupBlocks(lookup: A2AJLocatorLookup) {
  if (lookup.status !== "found" || !lookup.block) return [];
  const doc = lookupDocs.get(lookup);
  const visible = [
    { role: "selected" as const, block: lookup.block },
    ...lookup.before.map((block) => ({ role: "context" as const, block })),
    ...lookup.after.map((block) => ({ role: "context" as const, block })),
  ];
  const seen = new Set<string>();
  return visible.flatMap(({ role, block }) => {
    const contained = doc?.blocks.filter((candidate) => candidate.kind === block.kind &&
      candidate.start >= block.start && candidate.end <= block.end) ?? [];
    const units = block.kind === "section" && contained.length > 1
      ? contained.filter((candidate) => !contained.some((child) => child !== candidate &&
          child.start >= candidate.start && child.end <= candidate.end &&
          (child.start > candidate.start || child.end < candidate.end)))
      : contained.length ? contained : [block];
    return units.flatMap((unit) => {
      const key = `${unit.kind}:${unit.start}:${unit.end}`;
      if (seen.has(key) || unit.kind === "footnote") return [];
      seen.add(key);
      const text = doc ? sourceDocBlockText(doc, unit) : block.text;
      if (!text.trim()) return [];
      const child: A2AJLocatorLookup = {
        ...lookup,
        requested: { kind: unit.kind as A2AJLocatorKind, locator: unit.label, label: unit.label },
        matches: [unit.label], block: { ...unit, text }, before: [], after: [],
      };
      if (doc) lookupDocs.set(child, doc);
      return [{ role, lookup: child }];
    });
  });
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

function readerSegments(text: string, structure: StructureView, docType: DocType) {
  const kind = docType === "laws" ? "section" : "paragraph";
  const starts = [...new Set([0, ...structure.blocks.filter((block) =>
    block.start >= 0 && block.start < text.length &&
    (block.kind === kind || block.kind === "page")).map((block) => block.start), text.length])]
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
    const compiled = await a2ajSourceDoc(found);
    const text = compiled.text.slice(0, max);
    const structure: StructureView = {
      ...summarizeA2AJSourceDoc(compiled),
      blocks: compiled.blocks.filter((block) => block.start < text.length)
        .map(({ kind, label, start, end }) => ({ kind, label, start, end: Math.min(end, text.length) })),
    };
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
      text, structure,
      presentation: { source: "a2aj_markdown" as const, segments: readerSegments(text, structure, docType) },
      truncated: compiled.text.length > max,
    };
    const digest = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("base64url");
    return { payload, etag: `"${digest}"` };
  }
  return null;
}

export type A2AJViewerPayload = NonNullable<Awaited<ReturnType<typeof viewer>>>["payload"];

function reference(document: A2AJDocument, kind: "case" | "legislation") {
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

const provider: LegalSourceProvider<SourceDoc | string, unknown> = {
  id: "a2aj",
  canResolve: (request: LegalSourceResolveRequest) => request.kind === "legislation" ||
    (request.kind === "case" && CANADIAN_CITATION.test(request.text)),
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
    if (!request.locator) {
      const found = await document({ citation, docType, language: request.source.language,
        dataset: request.source.collection ?? undefined, signal: request.signal });
      if (!found) return [];
      const artifact = await a2ajSourceDoc(found);
      return [{ source: reference(found, request.source.kind as "case" | "legislation"),
        locator: { requested: null, label: "document" }, role: "document",
        text: artifact.text, textSha256: artifact.revision,
        documentSha256: artifact.revision, revision: artifact.revision,
        blockArtifact: artifact, documentArtifact: artifact, native: found }];
    }
    if (request.locator.kind === "footnote") return [];
    const found = await lookup({ citation, docType, language: request.source.language,
      dataset: request.source.collection ?? undefined, kind: request.locator.kind,
      locator: request.locator.value, endLocator: request.locator.endValue,
      contextBlocks: request.contextBlocks, signal: request.signal });
    const artifact = found && lookupDocs.get(found);
    if (!found || !artifact) return [];
    return lookupBlocks(found).map(({ role, lookup }): LegalSourcePassage<SourceDoc | string, unknown> => ({
      source: { ...request.source, id: found.citation, citation: found.citation,
        alternateCitation: found.alternateCitation, title: found.name,
        collection: found.dataset, language: found.language, url: found.url },
      locator: { requested: request.locator!, label: lookup.block!.label,
        anchor: lookup.block!.anchor, pageScoped: lookup.block!.kind === "page" },
      role, text: lookup.block!.text, textSha256: sha256(lookup.block!.text),
      documentSha256: artifact.revision, revision: artifact.revision,
      blockArtifact: lookup.block!.text, documentArtifact: artifact,
      native: { lookup, block: lookup.block! },
    }));
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

function artifact(value: A2AJDocument): SourceDoc | null;
function artifact(value: A2AJLocatorLookup): SourceDoc | null;
function artifact(value: A2AJDocument | A2AJLocatorLookup) {
  return "requested" in value ? lookupDocs.get(value) ?? null : resolvedSourceDocs.get(value) ?? null;
}

export const a2ajLegalSourceProvider = Object.assign(provider, {
  jurisdictions: JURISDICTIONS,
  document,
  source: artifact,
  lookup,
  lookupBlocks,
  viewer,
  coverage,
  clearCache() { documents.clear(); },
});
