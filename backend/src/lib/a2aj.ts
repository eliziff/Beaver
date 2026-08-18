import crypto from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  lookupSourceDoc,
  lookupSourceDocLabel,
  normalizeSourceDocLocator,
  sliceSourceDocBlocks,
  sourceDocBlockText,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLocatorKind,
} from "./sourceDoc";
import {
  compileA2AJSourceDoc,
  summarizeA2AJSourceDoc,
  type A2AJStructureSummary,
} from "./sourceDocA2AJ";
import {
  fetchLocalA2AJDocument,
  getLocalA2AJSectionMap,
  getLocalA2AJStructure,
  searchLocalA2AJ,
} from "./a2ajLocalBulk";
import { legalProviderCache } from "./legalDataPath";
import { sha256 } from "./hash";
import { guardedRemoteFetch } from "./remoteUrlSafety";
import {
  a2ajPassageLaneReady,
  searchLocalA2AJPassages,
} from "./a2ajPassageSearch";
import { citationAuthorityMetricsBatch } from "./caselawCitator";
import {
  classifyLegalMarkdown,
  deriveOriginalPdfCandidates,
} from "./legalSourcePresentation";
import type {
  LegalSourcePassage,
  LegalSourceProvider,
  LegalSourceReference,
  LegalSourceResolveRequest,
  LegalSourceSearchHit,
} from "./legalSources";

const A2AJ_BASE_URL = "https://api.a2aj.ca";
const A2AJ_TIMEOUT_MS = 15_000;
const MAX_CACHED_DOCUMENTS = 32;
const A2AJ_HTTP_CACHE_MAX_FILES = 512;
const A2AJ_HTTP_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const A2AJ_FETCH_CACHE_MS = 30 * 24 * 60 * 60_000;
const A2AJ_SEARCH_CACHE_MS = 24 * 60 * 60_000;
const CANADIAN_CITATION =
  /\b(?:\d{4}\s+[A-Z][A-Z0-9]{1,12}\s+\d+|\d+\s+S\.?C\.?R\.?\s+\d+|R\.?S\.?[A-Z]\.?\s+\d{4})\b/iu;

type JsonRecord = Record<string, unknown>;

type PersistentResponse = {
  status?: number;
  json?: unknown;
  body?: unknown;
};

export type A2AJLocatorKind = Exclude<SourceDocLocatorKind, "footnote">;


/** The compiled index as the viewer route serves it: blocks without text. */
type A2AJStructureView = A2AJStructureSummary & {
  blocks: Array<{
    kind: SourceDocLocatorKind;
    label: string;
    start: number;
    end: number;
  }>;
};

export type A2AJDocument = {
  docType?: "cases" | "laws";
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

/**
 * A document as returned to a caller that asked for bounded text. The old
 * fetch sliced silently at 50,000 characters, so a caller could reason over a
 * fragment of the Criminal Code believing it had the whole Act; these two
 * fields say so. Snake case matches the A2AJ wire vocabulary (`start_char`,
 * `end_char`) that surrounds them in the tool result.
 */
export type A2AJFetchedDocument = A2AJDocument & {
  truncated: boolean;
  total_chars: number;
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

export type A2AJCoverageResult = {
  dataset: string;
  description: string;
  descriptionFr: string | null;
  docType: "cases" | "laws";
  jurisdictionCode:
    | "FED"
    | "AB"
    | "BC"
    | "MB"
    | "NB"
    | "NL"
    | "NS"
    | "NT"
    | "NU"
    | "ON"
    | "PE"
    | "QC"
    | "SK"
    | "YT";
  jurisdiction: string;
  sourceKind: "court" | "tribunal" | "legislation" | "regulation";
  earliestDate: string | null;
  latestDate: string | null;
  documentCount: number;
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
  block: (SourceDocBlock & { text: string }) | null;
  before: Array<SourceDocBlock & { text: string }>;
  after: Array<SourceDocBlock & { text: string }>;
  structure: A2AJStructureSummary;
  sourceMethod: "structure_index" | "provider_section";
};

export type A2AJViewerPayload = {
  schemaVersion: "mike.legal-source.v1";
  provider: "a2aj";
  reference: {
    docType: "cases" | "laws";
    citation: string;
    language: "en" | "fr";
    dataset: string | null;
  };
  metadata: {
    title: string;
    citation: string;
    alternateCitation: string | null;
    date: string | null;
    dataset: string;
    url: string | null;
    pdfUrl: string | null;
    language: "en" | "fr";
    upstreamLicense: string | null;
  };
  text: string;
  structure: A2AJStructureView;
  presentation: {
    source: "a2aj_markdown";
    segments: Array<{
      start: number;
      end: number;
      blocks: ReturnType<typeof classifyLegalMarkdown>;
    }>;
  };
  truncated: boolean;
};

const rawRecords = new WeakMap<A2AJDocument, JsonRecord>();
const structureIndexes = new WeakMap<A2AJDocument, SourceDoc>();
const lookupDocuments = new WeakMap<A2AJLocatorLookup, SourceDoc>();
const documentCache = new Map<
  string,
  { expiresAt: number; promise: Promise<A2AJDocument | null> }
>();
const viewerDocumentCache = new Map<
  string,
  {
    expiresAt: number;
    promise: Promise<{
      payload: A2AJViewerPayload;
      etag: string;
    } | null>;
  }
>();
let lastPersistentCachePrune = 0;

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

function safeWebUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function canonicalA2AJSourceUrl(
  record: Record<string, unknown>,
  language: "en" | "fr" = "en",
) {
  return (
    safeWebUrl(textForLanguage(record, "source_url", language)) ??
    safeWebUrl(textForLanguage(record, "url", language))
  );
}

function documentFromResult(
  value: unknown,
  language: "en" | "fr",
  docType: "cases" | "laws",
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
    docType,
    dataset: asString(record.dataset) ?? "",
    citation,
    alternateCitation: textForLanguage(record, "citation2", actualLanguage),
    name: textForLanguage(record, "name", actualLanguage),
    date: textForLanguage(record, "document_date", actualLanguage),
    url: canonicalA2AJSourceUrl(record, actualLanguage),
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
    url: canonicalA2AJSourceUrl(record, language),
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

/**
 * `json.dumps(value, sort_keys=True, ensure_ascii=False)`, byte for byte.
 *
 * NOT cosmetic and NOT replaceable with JSON.stringify: this string is hashed
 * into the shared HTTP cache filename under OPEN_LEGAL_DATA_HOME, and the
 * Table of Authorities app computes the same name in Python (toa_maker.py,
 * `_cache_key`). JSON.stringify omits the `", "` and `": "` separators, so
 * every key would change and the two apps would silently stop sharing the
 * cache they were built to share.
 */
function pythonStyleJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(pythonStyleJson).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}: ${pythonStyleJson(item)}`,
      )
      .join(", ")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestCacheFile(
  endpoint: string,
  params: Record<string, string | number | undefined>,
) {
  const compact = Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
  const identity = pythonStyleJson({ endpoint, params: compact });
  const key = sha256(identity);
  return path.join(legalProviderCache("a2aj"), "http", `${key}.json`);
}

function persistentCacheEnabled() {
  return process.env.NODE_ENV !== "test" || !!process.env.OPEN_LEGAL_DATA_HOME;
}

function requestCacheTtl(endpoint: string) {
  return endpoint === "/search" || endpoint === "/coverage"
    ? A2AJ_SEARCH_CACHE_MS
    : A2AJ_FETCH_CACHE_MS;
}

async function readPersistentResponse(
  endpoint: string,
  params: Record<string, string | number | undefined>,
) {
  if (!persistentCacheEnabled()) return null;
  const filename = requestCacheFile(endpoint, params);
  try {
    const [raw, file] = await Promise.all([
      readFile(filename, "utf8"),
      stat(filename),
    ]);
    if (Date.now() - file.mtimeMs > requestCacheTtl(endpoint)) return null;
    const cached = JSON.parse(raw) as PersistentResponse;
    if (cached.status !== undefined && cached.status !== 200) return null;
    return asRecord(cached.json ?? cached.body);
  } catch {
    return null;
  }
}

async function prunePersistentResponses(directory: string) {
  try {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    const files = await Promise.all(
      entries.map(async (entry) => {
        const filename = path.join(directory, entry.name);
        const details = await stat(filename);
        return {
          filename,
          size: details.size,
          mtimeMs: details.mtimeMs,
        };
      }),
    );
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let bytes = 0;
    for (const [index, file] of files.entries()) {
      bytes += file.size;
      if (
        index >= A2AJ_HTTP_CACHE_MAX_FILES ||
        bytes > A2AJ_HTTP_CACHE_MAX_BYTES ||
        Date.now() - file.mtimeMs > A2AJ_FETCH_CACHE_MS
      ) {
        await rm(file.filename, { force: true });
      }
    }
  } catch {
    // A cache cleanup failure must not make a legal source unavailable.
  }
}

async function writePersistentResponse(
  endpoint: string,
  params: Record<string, string | number | undefined>,
  body: JsonRecord,
) {
  if (!persistentCacheEnabled()) return;
  const filename = requestCacheFile(endpoint, params);
  const directory = path.dirname(filename);
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      temporary,
      JSON.stringify({
        status: 200,
        json: body,
        error: "",
        cached_at: new Date().toISOString(),
      }),
      "utf8",
    );
    await rename(temporary, filename);
    if (Date.now() - lastPersistentCachePrune > 5 * 60_000) {
      lastPersistentCachePrune = Date.now();
      void prunePersistentResponses(directory);
    }
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function request(
  endpoint: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const cached = await readPersistentResponse(endpoint, params);
  if (cached) return cached;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const response = await guardedRemoteFetch(
    `${A2AJ_BASE_URL}${endpoint}?${query}`,
    { headers: { Accept: "application/json" }, signal },
    {
      label: "A2AJ request",
      allowedHosts: ["api.a2aj.ca"],
      defaultPortOnly: true,
      allowIpLiterals: false,
      timeoutMs: A2AJ_TIMEOUT_MS,
      response: {
        label: "A2AJ response",
        maxBytes: 64 * 1024 * 1024,
        contentTypes: ["application/json", "application/*+json"],
      },
    },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw apiError(response.status, body);
  const record = asRecord(body) ?? {};
  await writePersistentResponse(endpoint, params, record);
  return record;
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
): SourceDoc {
  docType = document.docType ?? docType;
  document.docType = docType;
  const cached = structureIndexes.get(document);
  if (cached) return cached;
  const doc = compileA2AJSourceDoc({
    citation: document.citation,
    docType,
    text: document.text,
    url: document.url,
    alternateCitation: document.alternateCitation,
    dataset: document.dataset,
    name: document.name,
  });
  structureIndexes.set(document, doc);
  document.text = doc.text;
  document.structure = summarizeA2AJSourceDoc(doc);
  return doc;
}

export function getA2AJDocumentSourceDoc(document: A2AJDocument) {
  return structureFor(document, document.docType ?? "cases");
}

function documentSectionMap(document: A2AJDocument) {
  return (
    getLocalA2AJSectionMap(document) ??
    sectionMap(rawRecords.get(document), document.language)
  );
}

function sectionLocator(value: string) {
  const stripped = value
    .trim()
    .replace(/^(?:(?:sections?)\s+|ss?\.?(?=\s)\s*)/iu, "")
    .replace(/^sec(?=[\p{L}\p{N}])/iu, "")
    .trim();
  if (!stripped) return "";
  return normalizeSourceDocLocator("section", stripped) || `sec${stripped}`;
}

function providerSectionSource(
  document: A2AJDocument,
  locator: string,
):
  | { status: "found"; doc: SourceDoc; lookup: ReturnType<typeof lookupSourceDocLabel> }
  | { status: "ambiguous"; matches: string[] }
  | null {
  const mapped = documentSectionMap(document);
  if (!mapped) return null;
  const normalized = sectionLocator(locator);
  const requested = normalized.toLowerCase();
  const candidates = Object.entries(mapped)
    .map(([key, text]) => {
      const canonical = sectionLocator(key);
      return { key, text, canonical, label: canonical.toLowerCase() };
    })
    .filter(({ label }) =>
      requested === label || requested.startsWith(`${label}(`),
    );
  const exact = candidates.filter(({ label }) => label === requested);
  const longest = Math.max(
    0,
    ...(exact.length ? exact : candidates).map(({ label }) => label.length),
  );
  const matches = (exact.length ? exact : candidates).filter(
    ({ label }) => label.length === longest,
  );
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      matches: matches.map(({ key }) => `sec${key.trim()}`),
    };
  }
  const match = matches[0];
  if (!match || !match.text.trim() || /^\[blank\]$/iu.test(match.text.trim())) {
    return null;
  }
  const { key, text } = match;
  const requestedLabel =
    match.canonical + normalized.slice(match.canonical.length);
  const doc = compileA2AJSourceDoc({
    citation: document.citation,
    docType: "laws",
    text,
    id: document.citation,
    url: document.url,
    alternateCitation: document.alternateCitation,
    dataset: document.dataset,
    name: document.name,
    sectionMap: { [key]: text },
  });
  const lookup = lookupSourceDocLabel(
    doc,
    "section",
    requestedLabel,
    0,
  );
  return lookup.status === "found" ? { status: "found", doc, lookup } : null;
}

function requestedSectionDocument(
  document: A2AJDocument,
  locator: string,
  text: string,
) {
  const label = sectionLocator(locator).replace(/^sec/iu, "");
  if (!label || !text.trim()) return null;
  const doc = compileA2AJSourceDoc({
    citation: document.citation,
    docType: "laws",
    text,
    id: document.citation,
    url: document.url,
    alternateCitation: document.alternateCitation,
    dataset: document.dataset,
    name: document.name,
    sectionMap: { [label]: text },
  });
  const scoped: A2AJDocument = {
    ...document,
    docType: "laws",
    text: doc.text,
    structure: summarizeA2AJSourceDoc(doc),
  };
  structureIndexes.set(scoped, doc);
  return scoped;
}

function readerSegments(
  text: string,
  structure: A2AJStructureView,
  docType: "cases" | "laws",
) {
  const kind = docType === "laws" ? "section" : "paragraph";
  const starts = [
    ...new Set([
      0,
      ...structure.blocks
        .filter(
          (block) =>
            block.start >= 0 &&
            block.start < text.length &&
            (block.kind === kind || block.kind === "page"),
        )
        .map((block) => block.start),
      text.length,
    ]),
  ].sort((left, right) => left - right);
  return starts.slice(0, -1).flatMap((start, index) => {
    const end = starts[index + 1];
    let source = text.slice(start, end).trim();
    if (docType === "cases" && start === 0) {
      const decisionContent = source.match(/\bDecision Content\b\s*/iu);
      if (decisionContent?.index !== undefined) {
        source = source.slice(
          decisionContent.index + decisionContent[0].length,
        );
        // A2AJ's SCC text uses single newlines as durable front-matter
        // boundaries. Preserve those blocks without changing the evidence text.
        source = source
          .split(/\n/gu)
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n\n");
      }
    }
    const blocks = classifyLegalMarkdown(source);
    return blocks.length ? [{ start, end, blocks }] : [];
  });
}

function cacheKey(args: {
  citation: string;
  docType: "cases" | "laws";
  language: "en" | "fr";
  dataset?: string;
  section?: string;
}) {
  return JSON.stringify([
    args.docType,
    args.language,
    args.dataset?.trim().toLowerCase() ?? "",
    args.citation.trim().toLowerCase(),
    args.section?.trim().toLowerCase() ?? "",
  ]);
}

async function fullA2AJDocument(args: {
  citation: string;
  docType: "cases" | "laws";
  language: "en" | "fr";
  dataset?: string;
  section?: string;
  signal?: AbortSignal;
}) {
  args.signal?.throwIfAborted();
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
    const localDocument = fetchLocalA2AJDocument({
      citation: args.citation,
      docType: args.docType,
      language: args.language,
      dataset: args.dataset,
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    if (localDocument) {
      if (!args.section?.trim()) {
        const localStructure = getLocalA2AJStructure(localDocument);
        if (localStructure) structureIndexes.set(localDocument, localStructure);
        localDocument.docType = args.docType;
        return localDocument;
      }
      const localSection = providerSectionSource(
        localDocument,
        args.section,
      );
      if (localSection?.status === "ambiguous") return null;
      if (localSection?.status === "found") {
        const root = localSection.doc.blocks.find(
          (block) => block.kind === "section" && block.origin === "native",
        );
        return requestedSectionDocument(
          localDocument,
          root?.label ?? args.section,
          localSection.doc.text,
        );
      }
    }
    const payload = await request(
      "/fetch",
      {
        citation: args.citation,
        doc_type: args.docType,
        output_language: args.language,
        section: args.section?.trim(),
      },
      args.signal,
    );
    const document = (Array.isArray(payload.results) ? payload.results : [])
      .map((item) => documentFromResult(item, args.language, args.docType))
      .find(
        (item): item is A2AJDocument =>
          !!item &&
          (!args.dataset?.trim() ||
            item.dataset.toLowerCase() === args.dataset.trim().toLowerCase()),
      );
    if (document && args.section?.trim()) {
      return requestedSectionDocument(document, args.section, document.text);
    }
    if (document) structureFor(document, args.docType);
    return document ?? null;
  })();
  const ttl = args.docType === "cases" ? 24 * 60 * 60_000 : 60 * 60_000;
  documentCache.set(key, { expiresAt: now + ttl, promise: cachedPromise });
  if (documentCache.size > MAX_CACHED_DOCUMENTS) {
    documentCache.delete(documentCache.keys().next().value!);
  }
  cachedPromise.catch(() => documentCache.delete(key));
  return cachedPromise;
}

export function clearA2AJCache() {
  documentCache.clear();
  viewerDocumentCache.clear();
}

export async function resolveA2AJViewerDocument(args: {
  citation: string;
  docType?: "cases" | "laws" | "auto";
  language?: "en" | "fr";
  dataset?: string;
  maxChars?: number;
}): Promise<{ payload: A2AJViewerPayload; etag: string } | null> {
  const citation = args.citation.trim();
  if (!citation) throw new Error("citation is required");
  const language = args.language === "fr" ? "fr" : "en";
  const requestedDocType = args.docType ?? "cases";
  const maxChars = Math.min(
    Math.max(Math.trunc(args.maxChars ?? 5_000_000), 1),
    10_000_000,
  );
  const key = JSON.stringify([
    requestedDocType,
    language,
    args.dataset?.trim().toLowerCase() ?? "",
    citation.toLowerCase(),
    maxChars,
  ]);
  const now = Date.now();
  const cached = viewerDocumentCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  if (cached) viewerDocumentCache.delete(key);

  const promise = (async () => {
    const candidates: Array<"cases" | "laws"> =
      requestedDocType === "auto"
        ? ["cases", "laws"]
        : [requestedDocType];
    for (const docType of candidates) {
      const document = await fullA2AJDocument({
        citation,
        docType,
        language,
        dataset: args.dataset,
      });
      if (!document) continue;
      const compiled = structureFor(document, docType);
      const truncated = compiled.text.length > maxChars;
      const text = compiled.text.slice(0, maxChars);
      const structure: A2AJStructureView = {
        ...summarizeA2AJSourceDoc(compiled),
        blocks: compiled.blocks
          .filter((block) => block.start < text.length)
          .map(({ kind, label, start, end }) => ({
            kind,
            label,
            start,
            end: Math.min(end, text.length),
          })),
      };
      const pdfUrl = document.url
        ? (deriveOriginalPdfCandidates({
            canonicalUrl: document.url,
          })[0]?.url ?? null)
        : null;
      const payload: A2AJViewerPayload = {
        schemaVersion: "mike.legal-source.v1",
        provider: "a2aj",
        reference: {
          docType,
          citation: document.citation,
          language: document.language,
          dataset: document.dataset || null,
        },
        metadata: {
          title: document.name || document.citation,
          citation: document.citation,
          alternateCitation: document.alternateCitation,
          date: document.date,
          dataset: document.dataset,
          url: document.url,
          pdfUrl,
          language: document.language,
          upstreamLicense: document.upstreamLicense,
        },
        text,
        structure,
        presentation: {
          source: "a2aj_markdown",
          segments: readerSegments(text, structure, docType),
        },
        truncated,
      };
      const digest = crypto
        .createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("base64url");
      return { payload, etag: `"${digest}"` };
    }
    return null;
  })();
  viewerDocumentCache.set(key, {
    expiresAt:
      now +
      (requestedDocType === "laws" ? 60 * 60_000 : 24 * 60 * 60_000),
    promise,
  });
  if (viewerDocumentCache.size > MAX_CACHED_DOCUMENTS) {
    viewerDocumentCache.delete(viewerDocumentCache.keys().next().value!);
  }
  promise.catch(() => viewerDocumentCache.delete(key));
  return promise;
}

/**
 * The compiled document a lookup was resolved against - the corpus a pinpoint
 * text fragment must be unique in. One artifact per document, so every quote
 * on that document reuses one token index.
 */
export function getA2AJLookupDocument(lookup: A2AJLocatorLookup) {
  return lookupDocuments.get(lookup) ?? null;
}

export async function fetchA2AJDocument(args: {
  citation: string;
  docType?: "cases" | "laws";
  language?: "en" | "fr";
  dataset?: string;
  section?: string;
  maxChars?: number;
  signal?: AbortSignal;
}): Promise<A2AJFetchedDocument | null> {
  const citation = args.citation.trim();
  if (!citation) throw new Error("citation is required");
  const language = args.language === "fr" ? "fr" : "en";
  const document = await fullA2AJDocument({
    citation,
    docType: args.docType ?? "cases",
    language,
    dataset: args.dataset,
    section: args.section,
    signal: args.signal,
  });
  if (!document) return null;
  const maxChars = args.maxChars ?? 50_000;
  const totalChars = document.text.length;
  const fetched: A2AJFetchedDocument = {
    ...document,
    text: totalChars > maxChars ? document.text.slice(0, maxChars) : document.text,
    truncated: totalChars > maxChars,
    total_chars: totalChars,
  };
  structureIndexes.set(fetched, structureFor(document, args.docType ?? "cases"));
  return fetched;
}

export async function lookupA2AJLocator(args: {
  citation: string;
  docType?: "cases" | "laws";
  language?: "en" | "fr";
  dataset?: string;
  kind: A2AJLocatorKind;
  locator: string;
  endLocator?: string;
  contextBlocks?: number;
  signal?: AbortSignal;
}): Promise<A2AJLocatorLookup | null> {
  const citation = args.citation.trim();
  const locator = args.locator.trim();
  const endLocator = args.endLocator?.trim();
  if (!citation) throw new Error("citation is required");
  if (!locator) throw new Error("locator is required");
  if (endLocator && args.kind !== "paragraph")
    throw new Error("end_locator is supported only for paragraph ranges");
  const docType = args.docType ?? "cases";
  const language = args.language === "fr" ? "fr" : "en";
  const document = await fullA2AJDocument({
    citation,
    docType,
    language,
    dataset: args.dataset,
    signal: args.signal,
  });
  if (!document) return null;
  const compiled = structureFor(document, docType);
  if (endLocator) {
    const range = sliceSourceDocBlocks(
      compiled,
      "paragraph",
      locator,
      endLocator,
    );
    const first = range[0];
    const last = range.at(-1);
    const label = [
      normalizeSourceDocLocator("paragraph", locator),
      normalizeSourceDocLocator("paragraph", endLocator),
    ].join("-");
    if (!first || !last) {
      const lookup: A2AJLocatorLookup = {
        status: "not_found",
        citation: document.citation,
        alternateCitation: document.alternateCitation,
        name: document.name,
        dataset: document.dataset,
        url: document.url,
        language: document.language,
        requested: {
          kind: "paragraph",
          locator: `${locator}-${endLocator}`,
          label,
        },
        matches: [],
        block: null,
        before: [],
        after: [],
        structure: document.structure,
        sourceMethod: "structure_index",
      };
      lookupDocuments.set(lookup, compiled);
      return lookup;
    }
    const paragraphs = compiled.blocks.filter(
      (block) => block.kind === "paragraph",
    );
    const firstIndex = paragraphs.indexOf(first);
    const lastIndex = paragraphs.indexOf(last);
    const context = Math.min(
      Math.max(Math.trunc(args.contextBlocks ?? 0), 0),
      2,
    );
    const materialize = (block: SourceDocBlock) => ({
      ...block,
      text: sourceDocBlockText(compiled, block),
    });
    const block = {
      ...first,
      label,
      aliases: undefined,
      end: last.end,
      text: compiled.text.slice(first.start, last.end).trim(),
    };
    const lookup: A2AJLocatorLookup = {
      status: "found",
      citation: document.citation,
      alternateCitation: document.alternateCitation,
      name: document.name,
      dataset: document.dataset,
      url: document.url,
      language: document.language,
      requested: {
        kind: "paragraph",
        locator: `${locator}-${endLocator}`,
        label,
      },
      matches: range.map(({ label: match }) => match),
      block,
      before: paragraphs
        .slice(Math.max(0, firstIndex - context), firstIndex)
        .map(materialize),
      after: paragraphs
        .slice(lastIndex + 1, lastIndex + 1 + context)
        .map(materialize),
      structure: document.structure,
      sourceMethod: "structure_index",
    };
    lookupDocuments.set(lookup, compiled);
    return lookup;
  }
  if (args.kind === "section" && docType === "laws") {
    const provider = providerSectionSource(document, locator);
    if (provider?.status === "ambiguous") {
      const lookup: A2AJLocatorLookup = {
        status: "ambiguous",
        citation: document.citation,
        alternateCitation: document.alternateCitation,
        name: document.name,
        dataset: document.dataset,
        url: document.url,
        language: document.language,
        requested: {
          kind: args.kind,
          locator,
          label: sectionLocator(locator),
        },
        matches: provider.matches,
        block: null,
        before: [],
        after: [],
        structure: document.structure,
        sourceMethod: "provider_section",
      };
      lookupDocuments.set(lookup, compiled);
      return lookup;
    }
    if (provider?.status === "found") {
      const lookup: A2AJLocatorLookup = {
        status: "found",
        citation: document.citation,
        alternateCitation: document.alternateCitation,
        name: document.name,
        dataset: document.dataset,
        url: document.url,
        language: document.language,
        requested: {
          kind: args.kind,
          locator,
          label: provider.lookup.requestedLabel,
        },
        matches: provider.lookup.matches,
        block: provider.lookup.block,
        before: provider.lookup.before,
        after: provider.lookup.after,
        structure: summarizeA2AJSourceDoc(provider.doc),
        sourceMethod: "provider_section",
      };
      lookupDocuments.set(lookup, provider.doc);
      return lookup;
    }
  }
  const result = lookupSourceDoc(
    compiled,
    args.kind,
    locator,
    args.contextBlocks,
  );
  if (
    args.kind === "section" &&
    docType === "laws" &&
    result.status !== "found"
  ) {
    const label = sectionLocator(locator);
    const section = label.replace(/^sec/iu, "");
    if (section) {
      const native = await fullA2AJDocument({
        citation,
        docType,
        language,
        dataset: args.dataset,
        section,
      });
      if (native?.text.trim()) {
        const providerDoc = getA2AJDocumentSourceDoc(native);
        const providerLookup = lookupSourceDocLabel(
          providerDoc,
          "section",
          label,
        );
        if (providerLookup.status === "found") {
          const lookup: A2AJLocatorLookup = {
            status: "found",
            citation: document.citation,
            alternateCitation: document.alternateCitation,
            name: document.name,
            dataset: document.dataset,
            url: document.url,
            language: document.language,
            requested: { kind: args.kind, locator, label },
            matches: providerLookup.matches,
            block: providerLookup.block,
            before: providerLookup.before,
            after: providerLookup.after,
            structure: summarizeA2AJSourceDoc(providerDoc),
            sourceMethod: "provider_section",
          };
          lookupDocuments.set(lookup, providerDoc);
          return lookup;
        }
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
  lookupDocuments.set(lookup, compiled);
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
  querySyntax?: "terms" | "fts5";
  signal?: AbortSignal;
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
  const payload = await request(
    "/search",
    {
      query,
      doc_type: args.docType ?? "cases",
      search_type: args.searchType ?? "full_text",
      search_language: language,
      size: Math.min(Math.max(Math.floor(args.size ?? 10), 1), 50),
      dataset: args.dataset?.trim(),
      start_date: args.startDate?.trim(),
      end_date: args.endDate?.trim(),
      sort_results: args.sortResults ?? "default",
    },
    args.signal,
  );
  return (Array.isArray(payload.results) ? payload.results : [])
    .map((item) => searchResultFromResult(item, language))
    .filter((item): item is A2AJSearchResult => !!item)
    .slice(0, 50);
}

export const A2AJ_JURISDICTIONS = {
  FED: "Federal",
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
} as const;

type JurisdictionCode = keyof typeof A2AJ_JURISDICTIONS;

const CASE_TRIBUNAL_DATASETS = new Set([
  "CART",
  "CHRT",
  "CIRB",
  "CITT",
  "CT",
  "FPSLREB",
  "OHSTC",
  "OIC",
  "PSDPT",
  "RAD",
  "RLLR",
  "RPD",
  "SCT",
  "SST",
  "TATC",
]);

function jurisdictionCode(dataset: string, docType: "cases" | "laws") {
  if (docType === "laws") {
    const suffix = dataset.toUpperCase().match(/-([A-Z]{2,3})$/u)?.[1];
    if (suffix === "FED") return "FED" as const;
    if (suffix === "YK") return "YT" as const;
    if (suffix && suffix in A2AJ_JURISDICTIONS) return suffix as JurisdictionCode;
    return "FED" as const;
  }
  const prefix = dataset.toUpperCase().slice(0, 2);
  if (prefix === "YK") return "YT" as const;
  return prefix in A2AJ_JURISDICTIONS && prefix !== "FED"
    ? (prefix as Exclude<JurisdictionCode, "FED">)
    : ("FED" as const);
}

function coverageResult(
  value: unknown,
  docType: "cases" | "laws",
): A2AJCoverageResult | null {
  const record = asRecord(value);
  const dataset = asString(record?.dataset)?.toUpperCase();
  if (!record || !dataset) return null;
  const code = jurisdictionCode(dataset, docType);
  const rawCount = record.number_of_documents;
  const documentCount =
    typeof rawCount === "number"
      ? rawCount
      : Number.parseInt(String(rawCount ?? "0"), 10);
  return {
    dataset,
    description:
      asString(record.description_en) ??
      asString(record.description_fr) ??
      dataset,
    descriptionFr: asString(record.description_fr),
    docType,
    jurisdictionCode: code,
    jurisdiction: A2AJ_JURISDICTIONS[code],
    sourceKind:
      docType === "laws"
        ? dataset.startsWith("REGULATIONS-")
          ? "regulation"
          : "legislation"
        : CASE_TRIBUNAL_DATASETS.has(dataset) ||
            /\b(?:board|commissioner|division|reporter|tribunal)\b/iu.test(
              asString(record.description_en) ?? "",
            )
          ? "tribunal"
          : "court",
    earliestDate: asString(record.earliest_document_date),
    latestDate: asString(record.latest_document_date),
    documentCount: Number.isFinite(documentCount) ? documentCount : 0,
  };
}

export async function getA2AJCoverage(
  docType: "cases" | "laws",
): Promise<A2AJCoverageResult[]> {
  const payload = await request("/coverage", { doc_type: docType });
  return (Array.isArray(payload.results) ? payload.results : [])
    .map((item) => coverageResult(item, docType))
    .filter((item): item is A2AJCoverageResult => !!item)
    .sort(
      (left, right) =>
        left.jurisdiction.localeCompare(right.jurisdiction) ||
        left.description.localeCompare(right.description),
    );
}

function a2ajCanResolve(request: LegalSourceResolveRequest) {
  if (request.kind === "legislation") return true;
  return request.kind === "case" && CANADIAN_CITATION.test(request.text);
}

function a2ajReference(document: A2AJDocument, kind: "case" | "legislation") {
  return {
    provider: "a2aj",
    id: document.citation,
    kind,
    title: document.name,
    citation: document.citation,
    alternateCitation: document.alternateCitation,
    date: document.date,
    collection: document.dataset,
    language: document.language,
    url: document.url,
  } satisfies LegalSourceReference;
}

function rankA2AJCaseHits(
  rows: LegalSourceSearchHit[],
  mode: "relevance" | "most_cited" | "most_discussed",
) {
  const metrics = citationAuthorityMetricsBatch(
    rows.map((row) => row.citation ?? ""),
  );
  const authorityOrder = rows
    .map((_, index) => index)
    .filter((index) => (metrics[index]?.citingCases ?? 0) > 0)
    .sort(
      (left, right) =>
        (metrics[right]?.distinctCitingParagraphs ?? 0) -
          (metrics[left]?.distinctCitingParagraphs ?? 0) ||
        (metrics[right]?.citingCases ?? 0) - (metrics[left]?.citingCases ?? 0),
    );
  const authorityRank = new Map(
    authorityOrder.map((index, rank) => [index, rank]),
  );
  const ranked = rows.map((row, textRank) => ({
    row,
    metric: metrics[textRank],
    textRank,
    score:
      1 / (60 + textRank) +
      (authorityRank.has(textRank)
        ? 0.15 / (60 + authorityRank.get(textRank)!)
        : 0),
  }));
  ranked.sort((left, right) => {
    if (mode === "most_cited") {
      return (
        (right.metric?.citingCases ?? 0) - (left.metric?.citingCases ?? 0) ||
        left.textRank - right.textRank
      );
    }
    if (mode === "most_discussed") {
      return (
        (right.metric?.distinctCitingParagraphs ?? 0) -
          (left.metric?.distinctCitingParagraphs ?? 0) ||
        (right.metric?.occurrences ?? 0) -
          (left.metric?.occurrences ?? 0) ||
        left.textRank - right.textRank
      );
    }
    return right.score - left.score || left.textRank - right.textRank;
  });
  return ranked.map(({ row, metric }) => ({
    ...row,
    ...(metric && metric.citingCases > 0
      ? {
          authority: {
            citingCases: metric.citingCases,
            citingParagraphs: metric.distinctCitingParagraphs,
            occurrences: metric.occurrences,
          },
        }
      : {}),
  }));
}

export const a2ajLegalSourceProvider: LegalSourceProvider<
  SourceDoc | string,
  | A2AJDocument
  | {
      lookup: A2AJLocatorLookup;
      block: SourceDocBlock & { text: string };
    }
> = {
  id: "a2aj",
  canResolve: a2ajCanResolve,
  async resolve(request) {
    const kind = request.kind === "legislation" ? "legislation" : "case";
    const docType = kind === "legislation" ? "laws" : "cases";
    const language = request.language === "fr" ? "fr" : "en";
    const document = await fetchA2AJDocument({
      citation: request.text,
      docType,
      language,
      dataset: request.collection,
      maxChars: 300_000,
      signal: request.signal,
    });
    return document ? [a2ajReference(document, kind)] : [];
  },
  async readPassage(request) {
    const docType = request.source.kind === "legislation" ? "laws" : "cases";
    const language = request.source.language === "fr" ? "fr" : "en";
    const citation = request.source.citation || request.source.id;
    if (request.locator) {
      if (request.locator.kind === "footnote") return [];
      const lookup = await lookupA2AJLocator({
        citation,
        docType,
        language,
        dataset: request.source.collection ?? undefined,
        kind: request.locator.kind,
        locator: request.locator.value,
        endLocator: request.locator.endValue,
        contextBlocks: request.contextBlocks ?? 0,
        signal: request.signal,
      });
      if (lookup?.status !== "found" || !lookup.block) return [];
      const documentArtifact = getA2AJLookupDocument(lookup) ?? lookup.block.text;
      const documentSha256 =
        typeof documentArtifact === "string"
          ? sha256(documentArtifact)
          : documentArtifact.revision;
      const source = {
        ...request.source,
        id: lookup.citation,
        citation: lookup.citation,
        alternateCitation: lookup.alternateCitation,
        title: lookup.name,
        collection: lookup.dataset,
        language: lookup.language,
        url: lookup.url,
      };
      const seen = new Set<string>();
      const visible = [
        { block: lookup.block, role: "selected" as const },
        ...lookup.before.map((block) => ({ block, role: "context" as const })),
        ...lookup.after.map((block) => ({ block, role: "context" as const })),
      ];
      const blocks = visible.flatMap(({ block, role }) => {
        const contained =
          typeof documentArtifact === "string"
            ? []
            : documentArtifact.blocks.filter(
                (candidate) =>
                  candidate.kind === block.kind &&
                  candidate.start >= block.start &&
                  candidate.end <= block.end,
              );
        const units =
          block.kind === "section" && contained.length > 1
            ? contained.filter(
                (candidate) =>
                  !contained.some(
                    (child) =>
                      child !== candidate &&
                      child.start >= candidate.start &&
                      child.end <= candidate.end &&
                      (child.start > candidate.start || child.end < candidate.end),
                  ),
              )
            : contained.length
              ? contained
              : [block];
        return units.flatMap((unit) => {
          const key = `${unit.kind}:${unit.start}:${unit.end}`;
          if (seen.has(key) || unit.kind === "footnote") return [];
          seen.add(key);
          return [{
            role,
            block: {
              ...unit,
              text:
                typeof documentArtifact === "string"
                  ? block.text
                  : sourceDocBlockText(documentArtifact, unit),
            },
          }];
        });
      });
      return blocks.map(({ block, role }): LegalSourcePassage<
        SourceDoc | string,
        {
          lookup: A2AJLocatorLookup;
          block: SourceDocBlock & { text: string };
        }
      > => ({
        source,
        locator: {
          requested: request.locator!,
          label: block.label,
          anchor: block.anchor,
          pageScoped: block.kind === "page",
        },
        role,
        text: block.text,
        textSha256: sha256(block.text),
        documentSha256,
        revision: documentSha256,
        blockArtifact: block.text,
        documentArtifact,
        native: { lookup, block },
      }));
    }
    const document = await fetchA2AJDocument({
      citation,
      docType,
      language,
      dataset: request.source.collection ?? undefined,
      maxChars: 300_000,
      signal: request.signal,
    });
    if (!document) return [];
    const source = getA2AJDocumentSourceDoc(document);
    return [{
      source: a2ajReference(document, request.source.kind as "case" | "legislation"),
      locator: { requested: null, label: "document" },
      role: "document",
      text: source.text,
      textSha256: sha256(source.text),
      documentSha256: source.revision,
      revision: source.revision,
      blockArtifact: source,
      documentArtifact: source,
      native: document,
    }];
  },
  canSearch(request) {
    const jurisdiction = request.jurisdiction?.toLocaleLowerCase().replace(/[^a-z]/gu, "");
    return (
      jurisdiction !== "us" &&
      jurisdiction !== "usa" &&
      jurisdiction !== "unitedstates" &&
      jurisdiction !== "unitedstatesofamerica" &&
      request.kinds.some((kind) => kind === "case" || kind === "legislation")
    );
  },
  async search(request) {
    const hits = [];
    for (const sourceType of ["case", "legislation"] as const) {
      if (!request.kinds.includes(sourceType)) continue;
      const docType = sourceType === "case" ? "cases" : "laws";
      if (
        request.searchType !== "name" &&
        request.syntax !== "fts5" &&
        !request.collection &&
        !request.dateFrom &&
        !request.dateTo &&
        (!request.sort || request.sort === "relevance") &&
        a2ajPassageLaneReady({ docType })
      ) {
        try {
          const passages = await searchLocalA2AJPassages({
            query: request.text,
            docType,
            language: request.language,
            size: request.perProviderLimit ?? request.limit,
          });
          if (passages.length) {
            hits.push(
              ...passages.map((row) => ({
                provider: "a2aj",
                id: row.citation,
                kind: sourceType,
                title: row.name,
                citation: row.citation,
                date: row.date,
                collection: row.dataset,
                url: row.url,
                snippet: row.passage.text,
                passageStart: row.passage.start,
                passageEnd: row.passage.end,
              })),
            );
            continue;
          }
        } catch {
          // A missing/stale sidecar degrades to the canonical document lane.
        }
      }
      const rows = await searchA2AJ({
        query: request.text,
        docType,
        searchType: request.searchType,
        language: request.language,
        size: request.perProviderLimit ?? request.limit,
        dataset: request.collection,
        startDate: request.dateFrom,
        endDate: request.dateTo,
        sortResults:
          request.sort === "newest"
            ? "newest_first"
            : request.sort === "oldest"
              ? "oldest_first"
              : "default",
        querySyntax: request.syntax,
        signal: request.signal,
      });
      const mapped: LegalSourceSearchHit[] = rows.map((row) => ({
          provider: "a2aj",
          id: row.citation,
          kind: sourceType,
          title: row.name,
          citation: row.citation,
          alternateCitation: row.alternateCitation,
          date: row.date,
          collection: row.dataset,
          url: row.url,
          snippet: row.snippet,
        }));
      hits.push(
        ...(sourceType === "case" &&
        (request.sort === "relevance" ||
          request.sort === "most_cited" ||
          request.sort === "most_discussed")
          ? rankA2AJCaseHits(mapped, request.sort)
          : mapped),
      );
    }
    return hits;
  },
};
