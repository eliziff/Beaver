import { cachedContent } from "../contentCache";
import { guardedRemoteFetch } from "../remoteUrlSafety";
import type {
  LegalSourceProvider,
  LegalSourceReference,
} from ".";
import { sourceDocPassages } from "./sourceDocPassages";
import {
  type SourceDoc,
  type SourceDocLocatorKind,
} from "../sourceDoc";
import {
  lookupLegalSourceDoc,
} from "../sourceDocNativeMarkup";
import { deriveNativeMarkupSourceDoc } from "../sourceDocStructureHost";
import { nonemptyString as asString } from "../value";
import {
  courtlistenerLocalBulkAvailable,
  getLocalCourtlistenerCase,
  lookupLocalCourtlistenerCitation,
  searchLocalCourtlistenerCases,
  type LocalCourtlistenerCluster,
  type LocalCourtlistenerOpinion,
} from "../courtlistenerLocalBulk";

const COURTLISTENER_BASE = "https://www.courtlistener.com/api/rest/v4";
const COURTLISTENER_WEB_BASE = "https://www.courtlistener.com";
const COURTLISTENER_STORAGE_BASE = "https://storage.courtlistener.com";
const US_REPORTER =
  /\b\d{1,4}\s+(?:U\.?\s*S\.?|S\.?\s*Ct\.?|L\.?\s*Ed\.?(?:\s*2d)?|F\.?(?:\s*Supp\.?)?(?:\s*2d|\s*3d|\s*4th)?)\s+\d{1,6}\b/iu;

type JsonRecord = Record<string, unknown>;
const opinionStructures = new WeakMap<object, SourceDoc>();

async function courtlistenerFetch<T>(
  pathOrUrl: string,
  init?: RequestInit,
  apiToken?: string | null,
): Promise<T> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${COURTLISTENER_BASE}${pathOrUrl}`;
  const method = init?.method ?? "GET";
  const perform = async () => {
    const token = apiToken?.trim() || process.env.COURTLISTENER_API_TOKEN?.trim();
    if (!token) throw new Error("COURTLISTENER_API_TOKEN must be set to use CourtListener tools.");
    const response = await guardedRemoteFetch(
      url,
      {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Token ${token}`,
          ...(init?.headers ?? {}),
        },
      },
      {
        label: "CourtListener request",
        allowedHosts: ["www.courtlistener.com", "storage.courtlistener.com"],
        defaultPortOnly: true,
        allowIpLiterals: false,
        timeoutMs: 15_000,
        response: {
          label: "CourtListener response",
          maxBytes: 64 * 1024 * 1024,
          contentTypes: ["application/json", "application/*+json"],
        },
      },
    );
    if (!response.ok) {
      const message = response.status === 429 ? "CourtListener rate limit exceeded."
        : response.status === 401 || response.status === 403
          ? "CourtListener authentication failed." : `CourtListener request failed (${response.status}).`;
      throw new Error(message);
    }
    return response.json() as Promise<T>;
  };
  if (method !== "GET") return perform();
  // Downloaded-authority cache: opinions and clusters are effectively
  // immutable; searches tolerate a bounded staleness ceiling. Also relieves
  // CourtListener rate limits across sessions. The token never enters the
  // key (it rides in headers only).
  return cachedContent({
    scope: "shared",
    kind: "courtlistener-api",
    key: url,
    version: 1,
    ttlMs: 24 * 60 * 60 * 1_000,
    produce: perform,
  });
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function firstString(record: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function absoluteWebUrl(path: unknown): string | null {
  const value = asString(path);
  if (!value) return null;
  return value.startsWith("http") ? value : `${COURTLISTENER_WEB_BASE}${value}`;
}

function absoluteStorageUrl(path: unknown): string | null {
  const value = asString(path);
  if (!value) return null;
  if (value.startsWith("http")) return value;
  return `${COURTLISTENER_STORAGE_BASE}/${value.replace(/^\/+/, "")}`;
}

function citationLabel(citation: unknown): string | null {
  if (typeof citation === "string") return citation;
  if (!citation || typeof citation !== "object") return null;
  const c = citation as JsonRecord;
  const volume = asString(c.volume) ?? String(c.volume ?? "").trim();
  const reporter = asString(c.reporter);
  const page = asString(c.page) ?? String(c.page ?? "").trim();
  return [volume, reporter, page].filter(Boolean).join(" ") || null;
}

const CAP_CITATION_ORDER = new Map(
  ["official", "nominative", "parallel", "vendor"].map((type, index) => [
    type,
    index,
  ]),
);

async function capPageCitations(
  filepath: string | null | undefined,
  signal?: AbortSignal,
) {
  const value = filepath?.trim();
  const archivePrefix = "https://archive.org/download/";
  const path = value?.startsWith(archivePrefix)
    ? value.slice(archivePrefix.length)
    : value?.replace(/^\/+/, "");
  if (!path || path.includes("..") || !/^[\w./-]+\.json$/u.test(path)) return [];
  const url = `https://archive.org/download/${path}`;
  try {
    const data = await cachedContent<JsonRecord>({
      scope: "shared",
      kind: "courtlistener-cap-metadata",
      key: url,
      version: 1,
      produce: async () => {
        const response = await guardedRemoteFetch(
          url,
          { signal },
          {
            label: "CAP metadata request",
            allowedHosts: ["archive.org"],
            defaultPortOnly: true,
            allowIpLiterals: false,
            timeoutMs: 15_000,
            response: {
              label: "CAP metadata response",
              maxBytes: 8 * 1024 * 1024,
              contentTypes: ["application/json", "application/*+json"],
            },
          },
        );
        if (!response.ok) throw new Error(`CAP metadata error (${response.status})`);
        return response.json() as Promise<JsonRecord>;
      },
    });
    return (Array.isArray(data.citations) ? data.citations : [])
      .map((value, index) => ({
        cite: asString((value as JsonRecord)?.cite),
        type: asString((value as JsonRecord)?.type),
        index,
      }))
      .filter(
        (value): value is { cite: string; type: string | null; index: number } =>
          !!value.cite,
      )
      .sort(
        (left, right) =>
          (CAP_CITATION_ORDER.get(left.type ?? "") ?? 99) -
            (CAP_CITATION_ORDER.get(right.type ?? "") ?? 99) ||
          left.index - right.index,
      )
      .map(({ cite }) => cite);
  } catch {
    return [];
  }
}

function compactCluster(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return {
      id: null, caseName: null, dateFiled: null, court: null,
      citations: [], url: null, pdfUrl: null, subOpinions: [],
    };
  }
  const cluster = raw as JsonRecord;
  return {
    id: asNumber(cluster.id),
    caseName: firstString(cluster, "case_name", "caseName", "name"),
    dateFiled: firstString(cluster, "date_filed", "dateFiled"),
    court:
      asString((cluster.docket as JsonRecord | undefined)?.court_id) ??
      asString(cluster.court) ??
      null,
    citations: Array.isArray(cluster.citations)
      ? cluster.citations.map(citationLabel).filter(Boolean)
      : [],
    url: absoluteWebUrl(cluster.absolute_url),
    pdfUrl:
      absoluteStorageUrl(cluster.filepath_pdf_harvard) ??
      absoluteStorageUrl(cluster.filepath_pdf_scan),
    subOpinions: Array.isArray(cluster.sub_opinions)
      ? cluster.sub_opinions
      : [],
  };
}

async function attachOpinionStructure(
  compacted: {
    opinionId: number | null;
    url: string | null;
    text: string | null;
  },
  text: string | null,
  markup: string | null,
  maxChars: number,
  pageCitations: string[],
) {
  if (!text && !markup) return;
  const input = {
    provider: "courtlistener",
    id: compacted.opinionId === null ? "" : String(compacted.opinionId),
    url: compacted.url,
    text: text ?? "",
    markup,
    pageCitations,
  } as const;
  let compiled = await deriveNativeMarkupSourceDoc(input);
  if (!compiled.text && markup) {
    const fallback = stripOpinionMarkup(markup);
    if (fallback) compiled = await deriveNativeMarkupSourceDoc({ ...input, text: fallback });
  }
  compacted.text = truncate(compiled.text, maxChars);
  opinionStructures.set(compacted, compiled);
}

async function compactOpinion(
  opinion: JsonRecord,
  maxChars: number,
  pageCitations: string[] = [],
) {
  // CourtListener uses html_with_citations on its own opinion pages and
  // documents it as the preferred rendition. Compile, display, and search
  // that one string so locator offsets cannot drift across representations.
  const rawMarkup = firstString(
    opinion,
    "htmlWithCitations",
    "html_with_citations",
    "xmlHarvard",
    "xml_harvard",
    "htmlColumbia",
    "html_columbia",
    "htmlLawbox",
    "html_lawbox",
    "htmlAnon2020",
    "html_anon_2020",
    "html",
  );
  const rawText = rawMarkup ?? firstString(opinion, "plainText", "plain_text");
  // Native markup is rendered by the Rust adapter. Preserve the historical
  // stripper only as the fail-closed fallback for empty provider markup.
  const text = rawMarkup ? null : stripOpinionMarkup(rawText);
  const compacted = {
    opinionId:
      asNumber(opinion.opinionId) ??
      asNumber(opinion.id) ??
      asNumber(opinion.opinion_id),
    type: asString(opinion.type),
    author:
      asString(opinion.author_str) ??
      asString(opinion.author) ??
      asString((opinion.author as JsonRecord | undefined)?.name),
    per_curiam: asString(opinion.per_curiam),
    joined_by_str: asString(opinion.joined_by_str),
    url: absoluteWebUrl(opinion.absolute_url ?? opinion.url),
    pdfUrl: absoluteStorageUrl(opinion.storagePath ?? opinion.local_path),
    text: truncate(text, maxChars),
  };
  await attachOpinionStructure(compacted, text, rawMarkup, maxChars, pageCitations);
  return compacted;
}

function uniqueOpinionPdfUrl(opinions: Array<{ pdfUrl: string | null }>) {
  const urls = [...new Set(opinions.map(({ pdfUrl }) => pdfUrl).filter(Boolean))];
  return urls.length === 1 ? urls[0]! : null;
}

function hasNativeOpinionStructure(opinion: object) {
  return opinionStructures.get(opinion)?.blocks.some(
    ({ origin }) => origin === "native",
  ) ?? false;
}

function lookupOpinionLocator(
  opinion: object,
  kind: SourceDocLocatorKind,
  locator: string,
  contextBlocks = 0,
) {
  const structure = opinionStructures.get(opinion);
  return structure
    ? lookupLegalSourceDoc(structure, kind, locator, contextBlocks)
    : null;
}

async function fetchCaseOpinionsFromCourtlistenerOpinionsEndpoint(args: {
  clusterId: number;
  maxChars: number;
  includeFullText?: boolean;
  apiToken?: string | null;
  signal?: AbortSignal;
}) {
  const MAX_OPINION_PAGES = 10;
  const cluster = await courtlistenerFetch<JsonRecord>(
    `/clusters/${args.clusterId}/`,
    { signal: args.signal },
    args.apiToken,
  );
  const pageCitations = await capPageCitations(
    asString(cluster.filepath_json_harvard),
    args.signal,
  );
  const opinions: Awaited<ReturnType<typeof compactOpinion>>[] = [];
  const rawOpinions: JsonRecord[] = [];
  let nextUrl: string | null = `/opinions/?cluster=${args.clusterId}`;
  let pages = 0;
  let remainingChars = args.maxChars;

  while (nextUrl && pages < MAX_OPINION_PAGES && remainingChars > 0) {
    pages += 1;
    const data = await courtlistenerFetch<JsonRecord>(
      nextUrl,
      { signal: args.signal },
      args.apiToken,
    );
    const results = Array.isArray(data.results) ? data.results : [];
    const opinionMaxChars = args.includeFullText
      ? Math.max(500, Math.floor(remainingChars / Math.max(1, results.length)))
      : Math.min(3000, remainingChars);
    const pageOpinions = results.filter(
      (opinion): opinion is JsonRecord =>
        !!opinion && typeof opinion === "object" && !Array.isArray(opinion),
    );
    for (const opinion of pageOpinions) {
      if (remainingChars <= 0) break;
      const compacted = await compactOpinion(
        opinion,
        Math.max(1, Math.min(opinionMaxChars, remainingChars)),
        pageCitations,
      );
      rawOpinions.push(opinion);
      opinions.push(compacted);
      remainingChars -= compacted.text?.length ?? 0;
    }
    nextUrl = asString(data.next);
  }

  return {
    id: args.clusterId,
    url:
      absoluteWebUrl(cluster.absolute_url) ??
      absoluteWebUrl(rawOpinions[0]?.absolute_url) ??
      `${COURTLISTENER_WEB_BASE}/opinion/${args.clusterId}/`,
    pdfUrl:
      absoluteStorageUrl(cluster.filepath_pdf_harvard) ??
      absoluteStorageUrl(cluster.filepath_pdf_scan) ??
      uniqueOpinionPdfUrl(opinions),
    opinions,
    source: "api",
  };
}

function truncate(value: string | null, maxChars: number): string | null {
  if (!value) return null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    );
}

function stripOpinionMarkup(value: string | null): string | null {
  if (!value) return null;
  return decodeHtmlEntities(
    value
      .replace(/<page-number[^>]*>(.*?)<\/page-number>/gis, "$1")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|section|opinion|blockquote|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function parseCitationParts(value: string) {
  const match = value
    .trim()
    .match(/\b(\d{1,4})\s+([A-Za-z][A-Za-z0-9.\s]*?)\s+(\d{1,7})\b/);
  if (!match) return null;
  return {
    volume: match[1],
    reporter: match[2].replace(/\s+/g, " ").trim(),
    page: match[3],
  };
}

function compactLocalBulkCluster(
  cluster: LocalCourtlistenerCluster,
  citations: string[] = [],
  opinions: Array<{ pdfUrl: string | null }> = [],
) {
  return {
    id: cluster.id,
    caseName: cluster.caseName ?? cluster.caseNameFull ?? cluster.caseNameShort,
    dateFiled: cluster.dateFiled,
    court: null,
    citations,
    url: cluster.slug
      ? `${COURTLISTENER_WEB_BASE}/opinion/${cluster.id}/${cluster.slug}/`
      : `${COURTLISTENER_WEB_BASE}/opinion/${cluster.id}/`,
    pdfUrl:
      absoluteStorageUrl(cluster.filepathPdfHarvard) ??
      uniqueOpinionPdfUrl(opinions),
    subOpinions: [],
  };
}

type CitationLookupCluster = ReturnType<typeof compactCluster>;

type CitationLookupRow = {
  citation: string | null;
  status: string;
  message: string | null;
  clusters: CitationLookupCluster[];
};

type CitationLookupPayload = {
  citationsSubmitted?: number;
  citationLinks: {
    clusterId: number | null;
    citation: string | null;
    caseName: string | null;
    court: string | null;
    dateFiled: string | null;
    pdfUrl: string | null;
    url: string | null;
    markdown: string;
  }[];
  results: CitationLookupRow[];
  source?: string;
};

function buildCitationLinks(results: CitationLookupRow[]) {
  return results.flatMap((result) =>
    result.clusters.flatMap((cluster) => {
      if (!cluster.url) return [];
      const label = [cluster.caseName, result.citation]
        .filter(Boolean)
        .join(", ");
      return [
        {
          clusterId: cluster.id,
          citation: result.citation,
          caseName: cluster.caseName,
          court: cluster.court,
          dateFiled: cluster.dateFiled,
          pdfUrl: cluster.pdfUrl,
          url: cluster.url,
          markdown: `[${label || cluster.url}](${cluster.url})`,
        },
      ];
    }),
  );
}

function courtlistenerApiTokenAvailable(apiToken?: string | null) {
  return !!(apiToken?.trim() || process.env.COURTLISTENER_API_TOKEN?.trim());
}

function getBulkCitationLookup(citations: string[]): CitationLookupPayload | null {
  if (!courtlistenerLocalBulkAvailable()) return null;
  const results: CitationLookupRow[] = citations.map((input) => {
    const parts = parseCitationParts(input);
    if (!parts) {
      return {
        citation: input,
        status: "invalid",
        message: "Citation could not be parsed for bulk lookup.",
        clusters: [],
      };
    }
    const citation = [parts.volume, parts.reporter, parts.page].filter(Boolean).join(" ");
    const matches = lookupLocalCourtlistenerCitation(parts) ?? [];
    return {
      citation,
      status: matches.length ? "ok" : "not_found",
      message: matches.length
        ? null
        : "Citation was not found in the local bulk index.",
      clusters: matches.map((cluster) =>
        compactLocalBulkCluster(cluster, citation ? [citation] : []),
      ),
    };
  });
  return {
    citationsSubmitted: citations.length || undefined,
    citationLinks: buildCitationLinks(results),
    results,
    source: "bulk-local",
  };
}

async function fetchCourtlistenerCitationLookup(args: {
  text: string;
  citationsSubmitted?: number;
  apiToken?: string | null;
  signal?: AbortSignal;
}): Promise<CitationLookupPayload> {
  const body = new URLSearchParams({ text: args.text.slice(0, 64000) });
  const results = await courtlistenerFetch<unknown[]>(
    "/citation-lookup/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: args.signal,
    },
    args.apiToken,
  );

  const compactResults: CitationLookupRow[] = (
    Array.isArray(results) ? results : []
  )
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as JsonRecord;
      return {
        citation:
          asString(row.citation) ?? asString(row.normalized_citation) ?? null,
        status: asString(row.status) ?? String(row.status ?? "unknown"),
        message: asString(row.message),
        clusters: Array.isArray(row.clusters)
          ? row.clusters.map(compactCluster)
          : [],
      };
    })
    .filter((row): row is CitationLookupRow => !!row);

  return {
    citationsSubmitted: args.citationsSubmitted,
    citationLinks: buildCitationLinks(compactResults),
    results: compactResults,
  };
}

async function getBulkCourtlistenerCaseOpinions(args: {
  clusterId: number;
  maxChars: number;
}) {
  const local = getLocalCourtlistenerCase(args.clusterId);
  if (local) {
    const pageCitations = await capPageCitations(
      local.cluster.filepathJsonHarvard,
    );
    const opinions = await Promise.all(local.opinions.map((opinion) =>
      compactLocalOpinion(opinion, args.maxChars, pageCitations),
    ));
    return {
      ...compactLocalBulkCluster(local.cluster, local.citations, opinions),
      opinions,
      source: "bulk-local",
    };
  }
  return null;
}

async function compactLocalOpinion(
  opinion: LocalCourtlistenerOpinion,
  maxChars: number,
  pageCitations: string[],
) {
  return compactOpinion(
    {
      id: opinion.id,
      cluster_id: opinion.clusterId,
      type: opinion.type,
      author_str: opinion.authorStr,
      per_curiam: opinion.perCuriam,
      joined_by_str: opinion.joinedByStr,
      page_count: opinion.pageCount,
      download_url: opinion.downloadUrl,
      local_path: opinion.storagePath,
      plain_text: opinion.plainText,
      html: opinion.html,
      html_lawbox: opinion.htmlLawbox,
      html_columbia: opinion.htmlColumbia,
      html_anon_2020: opinion.htmlAnon2020,
      xml_harvard: opinion.xmlHarvard,
      xml_scan: opinion.xmlScan,
      html_with_citations: opinion.htmlWithCitations,
    },
    maxChars,
    pageCitations,
  );
}

async function verifyCitations(args: {
  citations?: string[];
  apiToken?: string | null;
  signal?: AbortSignal;
}) {
  const citations = Array.isArray(args.citations)
    ? args.citations
        .map((c) => (typeof c === "string" ? c.trim() : ""))
        .filter(Boolean)
        .slice(0, 250)
    : [];
  if (!citations.length) {
    return { error: "Provide at least one citation or case name." };
  }

  const bulk = getBulkCitationLookup(citations);
  if (bulk) {
    const apiFallbackInputs =
      citations.length > 0 && courtlistenerApiTokenAvailable(args.apiToken)
        ? bulk.results
            .filter(
              (result) =>
                result.status === "not_found" || result.status === "invalid",
            )
            .map((result) => result.citation)
            .filter((citation): citation is string => !!citation)
        : [];
    if (!apiFallbackInputs.length) return bulk;

    try {
      const apiFallback = await fetchCourtlistenerCitationLookup({
        text: apiFallbackInputs.join("\n"),
        citationsSubmitted: apiFallbackInputs.length,
        apiToken: args.apiToken,
        signal: args.signal,
      });
      const fallbackRows = [...apiFallback.results];
      const mergedResults = bulk.results.flatMap((result) => {
        if (result.status !== "not_found" && result.status !== "invalid") {
          return [result];
        }
        return [fallbackRows.shift() ?? result];
      });
      mergedResults.push(...fallbackRows);
      return {
        citationsSubmitted: bulk.citationsSubmitted,
        citationLinks: buildCitationLinks(mergedResults),
        results: mergedResults,
        source: "bulk+api",
      };
    } catch {
      return bulk;
    }
  }

  return fetchCourtlistenerCitationLookup({
    text: citations.join("\n"),
    citationsSubmitted: citations.length || undefined,
    apiToken: args.apiToken,
    signal: args.signal,
  });
}

async function searchCases(args: {
  query?: string;
  court?: string;
  filedAfter?: string;
  filedBefore?: string;
  limit?: number;
  querySyntax?: "terms" | "fts5";
  apiToken?: string | null;
  signal?: AbortSignal;
}) {
  const query = args.query?.trim();
  if (!query) return { error: "query is required." };
  const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 10)));
  const local =
    args.court?.trim()
      ? null
      : searchLocalCourtlistenerCases({
          query,
          limit,
          syntax: args.querySyntax,
          filedAfter: args.filedAfter,
          filedBefore: args.filedBefore,
        });
  if (
    local?.length ||
    (local !== null && !courtlistenerApiTokenAvailable(args.apiToken))
  ) {
    return {
      query,
      source: "bulk-local",
      results: (local ?? []).map((cluster) => {
        const compact = compactLocalBulkCluster(cluster);
        return {
          clusterId: compact.id,
          caseName: compact.caseName,
          citation: null,
          court: null,
          dateFiled: compact.dateFiled,
          snippet: null,
          url: compact.url,
        };
      }),
    };
  }
  const params = new URLSearchParams({ type: "o", q: query });
  if (args.court?.trim()) params.set("court", args.court.trim());
  if (args.filedAfter?.trim()) params.set("filed_after", args.filedAfter.trim());
  if (args.filedBefore?.trim()) params.set("filed_before", args.filedBefore.trim());

  const data = await courtlistenerFetch<JsonRecord>(
    `/search/?${params}`,
    { signal: args.signal },
    args.apiToken,
  );
  const rawResults = Array.isArray(data.results) ? data.results : [];
  return {
    query,
    results: rawResults.slice(0, limit).map((raw) => {
      const r = raw as JsonRecord;
      return {
        clusterId:
          asNumber(r.cluster_id) ??
          asNumber((r.cluster as JsonRecord | undefined)?.id),
        caseName: firstString(r, "caseName", "case_name", "caseNameFull"),
        citation:
          asString(r.citation) ??
          (Array.isArray(r.citation)
            ? r.citation.map(citationLabel).filter(Boolean).join("; ")
            : null),
        court: firstString(r, "court", "court_id", "court_citation_string"),
        dateFiled: firstString(r, "dateFiled", "date_filed"),
        snippet: asString(r.snippet),
        url: absoluteWebUrl(r.absolute_url),
      };
    }),
  };
}

async function caseOpinions(args: {
  clusterId?: number;
  includeFullText?: boolean;
  maxChars?: number;
  apiToken?: string | null;
  signal?: AbortSignal;
}) {
  if (!args.clusterId || !Number.isFinite(args.clusterId)) {
    return { error: "clusterId is required." };
  }
  const clusterId = Math.floor(args.clusterId);
  const maxChars = Math.max(1000, Math.min(50000, args.maxChars ?? 12000));
  const bulk = await getBulkCourtlistenerCaseOpinions({
    clusterId,
    maxChars,
  });
  if (bulk) return bulk;

  return fetchCaseOpinionsFromCourtlistenerOpinionsEndpoint({
    clusterId,
    maxChars,
    includeFullText: args.includeFullText,
    apiToken: args.apiToken,
    signal: args.signal,
  });
}

async function cases(args: {
  clusterIds?: number[];
  includeFullText?: boolean;
  maxChars?: number;
  apiToken?: string | null;
  signal?: AbortSignal;
}) {
  const clusterIds = Array.from(
    new Set(
      (args.clusterIds ?? [])
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.floor(value)),
    ),
  );
  if (!clusterIds.length) {
    return { error: "clusterIds is required.", cases: [] };
  }

  const cases = await Promise.all(
    clusterIds.map(async (clusterId) => {
      try {
        const result = await caseOpinions({
          clusterId,
          includeFullText: args.includeFullText,
          maxChars: args.maxChars,
          apiToken: args.apiToken,
          signal: args.signal,
        });
        return {
          clusterId,
          ...(result && typeof result === "object"
            ? (result as JsonRecord)
            : { result }),
        };
      } catch (err) {
        return {
          clusterId,
          id: clusterId,
          opinions: [],
          error:
            err instanceof Error ? err.message : "CourtListener case fetch failed.",
        };
      }
    }),
  );

  return { cases };
}

function uniqueCitationCluster(value: unknown) {
  const links = (value as JsonRecord | null)?.citationLinks;
  if (!Array.isArray(links)) return null;
  const ids = [
    ...new Set(
      links.flatMap((raw) => {
        const id = asNumber((raw as JsonRecord | null)?.clusterId);
        return id && Number.isSafeInteger(id) && id > 0 ? [id] : [];
      }),
    ),
  ];
  return ids.length === 1 ? ids[0] : null;
}

function courtlistenerReference(
  source: LegalSourceReference,
  caseRecord: JsonRecord,
  url: string | null,
) {
  return {
    ...source,
    title: firstString(caseRecord, "caseName", "case_name", "caseNameFull") ?? source.title,
    citation: asString(caseRecord.citation) ?? source.citation,
    date: firstString(caseRecord, "dateFiled", "date_filed") ?? source.date,
    url: url ?? source.url,
  } satisfies LegalSourceReference;
}

export type CourtlistenerProviderOptions = {
  apiToken?: string | null;
};

type CourtlistenerLegalSourceNative = {
  case: JsonRecord;
  opinion: object;
  lookup?: ReturnType<typeof lookupOpinionLocator>;
};

function provider(
  options: CourtlistenerProviderOptions = {},
): LegalSourceProvider<SourceDoc | string, CourtlistenerLegalSourceNative> {
  return {
    id: "courtlistener",
    canResolve: (request) =>
      request.kind === "case" && US_REPORTER.test(request.text),
    async resolve(request) {
      const verified = await verifyCitations({
        citations: [request.text],
        apiToken: options.apiToken,
        signal: request.signal,
      });
      const clusterId = uniqueCitationCluster(verified);
      return clusterId
        ? [{
            provider: "courtlistener",
            id: String(clusterId),
            kind: "case",
            citation: request.text,
          }]
        : [];
    },
    canSearch(request) {
      const jurisdiction = request.jurisdiction
        ?.toLocaleLowerCase()
        .replace(/[^a-z]/gu, "");
      return (
        request.kinds.includes("case") &&
        !["ca", "canada", "canadian"].includes(jurisdiction ?? "")
      );
    },
    async search(request) {
      const response = await searchCases({
        query: request.text,
        court: request.court || request.collection,
        filedAfter: request.dateFrom,
        filedBefore: request.dateTo,
        limit: request.perProviderLimit ?? request.limit,
        querySyntax: request.syntax,
        apiToken: options.apiToken,
        signal: request.signal,
      });
      const rows = Array.isArray((response as { results?: unknown }).results)
        ? (response as { results: JsonRecord[] }).results
        : [];
      return rows.flatMap((row) => {
        const clusterId = asNumber(row.clusterId);
        return clusterId
          ? [{
              provider: "courtlistener",
              id: String(clusterId),
              kind: "case" as const,
              title: asString(row.caseName),
              citation: asString(row.citation),
              date: asString(row.dateFiled),
              collection: asString(row.court),
              url: asString(row.url),
              snippet: asString(row.snippet),
            }]
          : [];
      });
    },
    async readPassage(request) {
      const clusterId = Number(request.source.id);
      if (!Number.isSafeInteger(clusterId) || clusterId <= 0) return [];
      const payload = await cases({
        clusterIds: [clusterId],
        includeFullText: true,
        maxChars: 50_000,
        apiToken: options.apiToken,
        signal: request.signal,
      });
      const caseRecord = Array.isArray(payload.cases)
        ? (payload.cases[0] as JsonRecord | undefined)
        : undefined;
      if (!caseRecord) return [];
      const opinions = Array.isArray(caseRecord.opinions)
        ? caseRecord.opinions.filter(
            (opinion): opinion is object =>
              Boolean(opinion) && typeof opinion === "object",
          )
        : [];
      const wantedOpinionId = request.source.part
        ? Number(request.source.part)
        : null;
      const caseUrl = asString(caseRecord.url);
      return opinions.flatMap((opinion) => {
        const opinionRecord = opinion as JsonRecord;
        const opinionId =
          asNumber(opinionRecord.opinionId) ??
          asNumber(opinionRecord.id) ??
          asNumber(opinionRecord.opinion_id);
        if (
          wantedOpinionId !== null &&
          (!Number.isSafeInteger(wantedOpinionId) || opinionId !== wantedOpinionId)
        ) {
          return [];
        }
        const structure = opinionStructures.get(opinion) ?? null;
        if (!structure) return [];
        const url = asString(opinionRecord.url) ?? caseUrl;
        if (!url) return [];
        const source = {
          ...courtlistenerReference(request.source, caseRecord, url),
          ...(opinionId ? { part: String(opinionId) } : {}),
        };
        return sourceDocPassages({
          request,
          reference: source,
          document: structure,
          native: { case: caseRecord, opinion },
          lookup: (kind, value, contextBlocks) =>
            lookupOpinionLocator(
              opinion,
              kind,
              value,
              contextBlocks,
            ),
        });
      });
    },
  };
}

export const courtlistenerLegalSourceProvider = Object.assign(provider(), {
  configured: provider,
  caseOpinions,
  hasNativeOpinionStructure,
});
