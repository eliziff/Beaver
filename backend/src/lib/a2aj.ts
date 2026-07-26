import {
  buildA2AJStructure,
  lookupA2AJStructure,
  normalizeA2AJLocator,
  type A2AJLocatorKind,
  type A2AJStructure,
} from "./a2ajStructure";
import {
  fetchLocalA2AJDocument,
  getLocalA2AJStructure,
  searchLocalA2AJ,
} from "./a2ajLocalBulk";

const A2AJ_BASE_URL = "https://api.a2aj.ca";
const A2AJ_TIMEOUT_MS = 15_000;
const MAX_CACHED_DOCUMENTS = 32;

type JsonRecord = Record<string, unknown>;

export type A2AJStructureSummary = {
  status: "usable" | "unavailable";
  source: "flat_text" | "section_map";
  counts: Record<A2AJLocatorKind, number>;
};

export type A2AJDocument = {
  dataset: string;
  citation: string;
  alternateCitation: string | null;
  name: string | null;
  date: string | null;
  url: string | null;
  text: string;
  language: "en" | "fr";
  upstreamLicense: string | null;
  structure: A2AJStructureSummary;
};

export type A2AJSearchResult = {
  dataset: string;
  citation: string;
  alternateCitation: string | null;
  name: string | null;
  date: string | null;
  url: string | null;
  snippet: string | null;
};

export type A2AJLocatorLookup = {
  status: "found" | "not_found" | "unavailable" | "ambiguous";
  citation: string;
  alternateCitation: string | null;
  name: string | null;
  dataset: string;
  url: string | null;
  language: "en" | "fr";
  requested: { kind: A2AJLocatorKind; locator: string; label: string };
  matches: string[];
  block: ReturnType<typeof lookupA2AJStructure>["block"];
  before: ReturnType<typeof lookupA2AJStructure>["before"];
  after: ReturnType<typeof lookupA2AJStructure>["after"];
  structure: A2AJStructureSummary;
  sourceMethod: "structure_index" | "api_section";
};

const rawRecords = new WeakMap<A2AJDocument, JsonRecord>();
const structureIndexes = new WeakMap<A2AJDocument, A2AJStructure>();
const lookupDocumentTexts = new WeakMap<A2AJLocatorLookup, string>();
const documentCache = new Map<
  string,
  { expiresAt: number; promise: Promise<A2AJDocument | null> }
>();

const EMPTY_STRUCTURE: A2AJStructureSummary = {
  status: "unavailable",
  source: "flat_text",
  counts: { paragraph: 0, page: 0, section: 0 },
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textForLanguage(
  record: JsonRecord,
  field: string,
  language: "en" | "fr",
) {
  return (
    asString(record[`${field}_${language}`]) ??
    asString(record[`${field}_${language === "en" ? "fr" : "en"}`]) ??
    asString(record[field]) ??
    null
  );
}

function documentFromResult(
  value: unknown,
  language: "en" | "fr",
): A2AJDocument | null {
  const record = asRecord(value);
  if (!record) return null;
  const requestedText = asString(record[`unofficial_text_${language}`]);
  const fallbackLanguage = language === "en" ? "fr" : "en";
  const actualLanguage = requestedText ? language : fallbackLanguage;
  const text = textForLanguage(record, "unofficial_text", actualLanguage);
  const citation =
    textForLanguage(record, "citation", actualLanguage) ??
    textForLanguage(record, "citation2", actualLanguage);
  if (!text || !citation) return null;
  const document: A2AJDocument = {
    dataset: asString(record.dataset) ?? "",
    citation,
    alternateCitation: textForLanguage(record, "citation2", actualLanguage),
    name: textForLanguage(record, "name", actualLanguage),
    date: textForLanguage(record, "document_date", actualLanguage),
    url:
      textForLanguage(record, "source_url", actualLanguage) ??
      textForLanguage(record, "url", actualLanguage),
    text,
    language: actualLanguage,
    upstreamLicense: asString(record.upstream_license),
    structure: EMPTY_STRUCTURE,
  };
  rawRecords.set(document, record);
  return document;
}

function searchResultFromResult(
  value: unknown,
  language: "en" | "fr",
): A2AJSearchResult | null {
  const record = asRecord(value);
  if (!record) return null;
  const citation =
    textForLanguage(record, "citation", language) ??
    textForLanguage(record, "citation2", language);
  if (!citation) return null;
  const snippet =
    textForLanguage(record, "snippet", language) ??
    textForLanguage(record, "highlight", language) ??
    textForLanguage(record, "unofficial_text", language);
  return {
    dataset: asString(record.dataset) ?? "",
    citation,
    alternateCitation: textForLanguage(record, "citation2", language),
    name: textForLanguage(record, "name", language),
    date: textForLanguage(record, "document_date", language),
    url:
      textForLanguage(record, "source_url", language) ??
      textForLanguage(record, "url", language),
    snippet: snippet ? snippet.slice(0, 1200) : null,
  };
}

function apiError(status: number, body: unknown): Error {
  const record = asRecord(body);
  const detail = record?.detail;
  const message =
    asString(detail) ??
    (Array.isArray(detail)
      ? detail
          .map((item) => asRecord(item)?.msg)
          .filter((item): item is string => typeof item === "string")
          .join("; ")
      : "") ??
    "";
  return new Error(message || `A2AJ API error (${status})`);
}

async function request(
  path: string,
  params: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const response = await fetch(`${A2AJ_BASE_URL}${path}?${query}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(A2AJ_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw apiError(response.status, body);
  return asRecord(body) ?? {};
}

function sectionMap(
  record: JsonRecord | undefined,
  language: "en" | "fr",
): Record<string, string> | null {
  if (!record) return null;
  let value: unknown =
    record[`unofficial_sections_${language}`] ??
    record[`unofficial_sections_${language === "en" ? "fr" : "en"}`];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const mapped = asRecord(value);
  if (!mapped) return null;
  const entries = Object.entries(mapped)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([label, text]) => [label, text] as const);
  return entries.length ? Object.fromEntries(entries) : null;
}

function structureFor(
  document: A2AJDocument,
  docType: "cases" | "laws",
): A2AJStructure {
  const cached = structureIndexes.get(document);
  if (cached) return cached;
  const structure = buildA2AJStructure({
    text: document.text,
    docType,
    citation: document.citation,
    alternateCitation: document.alternateCitation,
    dataset: document.dataset,
    name: document.name,
    sectionMap: sectionMap(rawRecords.get(document), document.language),
  });
  structureIndexes.set(document, structure);
  document.structure = {
    status: structure.status,
    source: structure.source,
    counts: structure.counts,
  };
  return structure;
}

function cacheKey(args: {
  citation: string;
  docType: "cases" | "laws";
  language: "en" | "fr";
  section?: string;
}) {
  return JSON.stringify([
    args.docType,
    args.language,
    args.citation.trim().toLowerCase(),
    args.section?.trim().toLowerCase() ?? "",
  ]);
}

async function fullA2AJDocument(args: {
  citation: string;
  docType: "cases" | "laws";
  language: "en" | "fr";
  section?: string;
}) {
  const key = cacheKey(args);
  const now = Date.now();
  const cached = documentCache.get(key);
  if (cached && cached.expiresAt > now) {
    documentCache.delete(key);
    documentCache.set(key, cached);
    return cached.promise;
  }
  if (cached) documentCache.delete(key);
  const cachedPromise = (async () => {
    if (!args.section?.trim()) {
      const localDocument = fetchLocalA2AJDocument({
        citation: args.citation,
        docType: args.docType,
        language: args.language,
        maxChars: Number.MAX_SAFE_INTEGER,
      });
      if (localDocument) {
        const localStructure = getLocalA2AJStructure(localDocument);
        if (localStructure) structureIndexes.set(localDocument, localStructure);
        return localDocument;
      }
    }
    const payload = await request("/fetch", {
      citation: args.citation,
      doc_type: args.docType,
      output_language: args.language,
      section: args.section?.trim(),
    });
    const document = (Array.isArray(payload.results) ? payload.results : [])
      .map((item) => documentFromResult(item, args.language))
      .find((item): item is A2AJDocument => !!item);
    if (document) structureFor(document, args.docType);
    return document ?? null;
  })();
  const ttl = args.docType === "cases" ? 24 * 60 * 60_000 : 5 * 60_000;
  documentCache.set(key, { expiresAt: now + ttl, promise: cachedPromise });
  if (documentCache.size > MAX_CACHED_DOCUMENTS) {
    documentCache.delete(documentCache.keys().next().value!);
  }
  cachedPromise.catch(() => documentCache.delete(key));
  return cachedPromise;
}

export function clearA2AJCache() {
  documentCache.clear();
}

export function getA2AJLookupDocumentText(lookup: A2AJLocatorLookup) {
  return lookupDocumentTexts.get(lookup) ?? "";
}

export async function fetchA2AJDocument(args: {
  citation: string;
  docType?: "cases" | "laws";
  language?: "en" | "fr";
  section?: string;
  maxChars?: number;
}): Promise<A2AJDocument | null> {
  const citation = args.citation.trim();
  if (!citation) throw new Error("citation is required");
  const language = args.language === "fr" ? "fr" : "en";
  const document = await fullA2AJDocument({
    citation,
    docType: args.docType ?? "cases",
    language,
    section: args.section,
  });
  if (!document) return null;
  if (document.text.length > (args.maxChars ?? 50_000)) {
    return {
      ...document,
      text: document.text.slice(0, args.maxChars ?? 50_000),
    };
  }
  return { ...document };
}

export async function lookupA2AJLocator(args: {
  citation: string;
  docType?: "cases" | "laws";
  language?: "en" | "fr";
  kind: A2AJLocatorKind;
  locator: string;
  contextBlocks?: number;
}): Promise<A2AJLocatorLookup | null> {
  const citation = args.citation.trim();
  const locator = args.locator.trim();
  if (!citation) throw new Error("citation is required");
  if (!locator) throw new Error("locator is required");
  const docType = args.docType ?? "cases";
  const language = args.language === "fr" ? "fr" : "en";
  const document = await fullA2AJDocument({
    citation,
    docType,
    language,
  });
  if (!document) return null;
  const structure = structureFor(document, docType);
  const result = lookupA2AJStructure(
    structure,
    args.kind,
    locator,
    args.contextBlocks,
  );
  if (
    args.kind === "section" &&
    docType === "laws" &&
    result.status !== "found"
  ) {
    const label = normalizeA2AJLocator("section", locator);
    const section = label.replace(/^sec/iu, "");
    if (section) {
      const native = await fullA2AJDocument({
        citation,
        docType,
        language,
        section,
      });
      if (native?.text.trim()) {
        const lookup: A2AJLocatorLookup = {
          status: "found",
          citation: document.citation,
          alternateCitation: document.alternateCitation,
          name: document.name,
          dataset: document.dataset,
          url: document.url,
          language: document.language,
          requested: { kind: args.kind, locator, label },
          matches: [label],
          block: {
            kind: "section",
            label,
            start: 0,
            end: native.text.length,
            text: native.text.trim(),
          },
          before: [],
          after: [],
          structure: document.structure,
          sourceMethod: "api_section",
        };
        lookupDocumentTexts.set(
          lookup,
          structure.text.includes(native.text.trim())
            ? structure.text
            : native.text,
        );
        return lookup;
      }
    }
  }
  const lookup: A2AJLocatorLookup = {
    status: result.status,
    citation: document.citation,
    alternateCitation: document.alternateCitation,
    name: document.name,
    dataset: document.dataset,
    url: document.url,
    language: document.language,
    requested: {
      kind: args.kind,
      locator,
      label: result.requestedLabel,
    },
    matches: result.matches,
    block: result.block,
    before: result.before,
    after: result.after,
    structure: document.structure,
    sourceMethod: "structure_index",
  };
  lookupDocumentTexts.set(lookup, structure.text);
  return lookup;
}

export async function searchA2AJ(args: {
  query: string;
  docType?: "cases" | "laws";
  searchType?: "full_text" | "name";
  language?: "en" | "fr";
  size?: number;
  dataset?: string;
  startDate?: string;
  endDate?: string;
  sortResults?: "default" | "newest_first" | "oldest_first";
}): Promise<A2AJSearchResult[]> {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  const language = args.language === "fr" ? "fr" : "en";
  const localResults = searchLocalA2AJ({
    ...args,
    query,
    language,
    docType: args.docType ?? "cases",
  });
  if (localResults !== null) return localResults;
  const payload = await request("/search", {
    query,
    doc_type: args.docType ?? "cases",
    search_type: args.searchType ?? "full_text",
    search_language: language,
    size: Math.min(Math.max(Math.floor(args.size ?? 10), 1), 50),
    dataset: args.dataset?.trim(),
    start_date: args.startDate?.trim(),
    end_date: args.endDate?.trim(),
    sort_results: args.sortResults ?? "default",
  });
  return (Array.isArray(payload.results) ? payload.results : [])
    .map((item) => searchResultFromResult(item, language))
    .filter((item): item is A2AJSearchResult => !!item)
    .slice(0, 50);
}
