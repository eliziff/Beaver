import { cachedContent } from "../contentCache";
import { retriedRemoteFetch } from "../remoteUrlSafety";
import { lookupsLeaveComputer, searchJurisdiction } from ".";
import type { LegalSourceProvider, LegalSourceReference } from ".";
import { structureNative, type NativeDocument } from "../structureNative";
import { searchLucene } from "../searchQuery";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import { isJsonRecord, jsonRecord, nonemptyString as asString, trimmedText } from "../value";
import { courtlistenerLocalBulkAvailable, getLocalCourtlistenerCase,
  lookupLocalCourtlistenerCitation, searchLocalCourtlistenerCases,
  type LocalCourtlistenerCluster } from "../courtlistenerLocalBulk";

const COURTLISTENER_BASE = "https://www.courtlistener.com/api/rest/v4";
const COURTLISTENER_WEB_BASE = "https://www.courtlistener.com";
const COURTLISTENER_STORAGE_BASE = "https://storage.courtlistener.com";
type JsonRecord = Record<string, unknown>;

/** The API key CourtListener's lookups are made with: the caller's, else the environment's. */
const courtlistenerToken = (apiToken?: string | null) =>
  apiToken?.trim() || process.env.COURTLISTENER_API_TOKEN?.trim() || null;

/** CourtListener's answer, or null where it publishes nothing at that address (404). */
async function courtlistenerFetch<T>(
  pathOrUrl: string,
  init?: RequestInit,
  apiToken?: string | null,
): Promise<T | null> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${COURTLISTENER_BASE}${pathOrUrl}`;
  const method = init?.method ?? "GET";
  const perform = async () => {
    const token = courtlistenerToken(apiToken);
    const response = await retriedRemoteFetch(
      url,
      { ...init, headers: { Accept: "application/json", ...token ? { Authorization: `Token ${token}` } : {},
        ...(init?.headers ?? {}) } },
      { label: "CourtListener request",
        allowedHosts: ["www.courtlistener.com", "storage.courtlistener.com"],
        defaultPortOnly: true, allowIpLiterals: false, timeoutMs: 15_000,
        response: { label: "CourtListener response", maxBytes: 64 * 1024 * 1024,
          contentTypes: ["application/json", "application/*+json"] } },
    );
    if (response.status === 404) return null;
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
    scope: "shared", kind: "courtlistener-api", key: url, version: 1,
    ttlMs: 24 * 60 * 60 * 1_000, produce: perform,
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

/** Already absolute, or joined to the CourtListener host the path belongs to. */
const absoluteUrl = (base: string, rooted: boolean) => (path: unknown): string | null => {
  const value = asString(path);
  if (!value) return null;
  if (value.startsWith("http")) return value;
  return rooted ? `${base}/${value.replace(/^\/+/, "")}` : `${base}${value}`;
};
const absoluteWebUrl = absoluteUrl(COURTLISTENER_WEB_BASE, false);
const absoluteStorageUrl = absoluteUrl(COURTLISTENER_STORAGE_BASE, true);

function citationLabel(citation: unknown): string | null {
  if (typeof citation === "string") return citation;
  const record = jsonRecord(citation);
  if (!record) return null;
  const part = (value: unknown) => asString(value) ?? String(value ?? "").trim();
  return [part(record.volume), asString(record.reporter), part(record.page)]
    .filter(Boolean).join(" ") || null;
}

function opinionIdentifier(opinion: JsonRecord) {
  return asNumber(opinion.opinionId) ?? asNumber(opinion.id) ?? asNumber(opinion.opinion_id);
}

/** Each rendition CourtListener stores, under the file name the structure parser reads it by, with its field names. */
const RENDITIONS: Array<[string, ...string[]]> = [
  ["html_with_citations.html", "htmlWithCitations", "html_with_citations"],
  ["xml_harvard.xml", "xmlHarvard", "xml_harvard"],
  ["html_columbia.html", "htmlColumbia", "html_columbia"],
  ["html_lawbox.html", "htmlLawbox", "html_lawbox"],
  ["html_anon_2020.html", "htmlAnon2020", "html_anon_2020"],
  ["html.html", "html"],
  ["plain_text.txt", "plainText", "plain_text"],
];

type OpinionCitation = { volume: string; reporter: string; page: string; kind: string };

/** The case's printings as CourtListener's API lists them. */
function apiCitations(cluster: JsonRecord): OpinionCitation[] {
  return (Array.isArray(cluster.citations) ? cluster.citations : []).flatMap((value) => {
    const row = jsonRecord(value);
    const part = (field: unknown) => String(field ?? "").trim();
    return row && part(row.volume) && part(row.reporter) && part(row.page)
      ? [{ volume: part(row.volume), reporter: part(row.reporter), page: part(row.page), kind: part(row.type) }] : [];
  });
}

/** An API opinion record or a local-bulk opinion row, read whole by the structure parser with its case's citations and fields. */
async function compactOpinion(opinion: JsonRecord, cluster: JsonRecord = {}, citations: OpinionCitation[] = []) {
  const compacted = {
    opinionId: opinionIdentifier(opinion),
    type: asString(opinion.type),
    author: firstString(opinion, "author_str", "authorStr", "author") ??
      asString((opinion.author as JsonRecord | undefined)?.name),
    url: absoluteWebUrl(opinion.absolute_url ?? opinion.url),
    pdfUrl: absoluteStorageUrl(opinion.storagePath ?? opinion.local_path),
  };
  const renditions = RENDITIONS.flatMap(([file, ...fields]) => {
    const text = firstString(opinion, ...fields);
    return text ? [[file, text] as [string, string]] : [];
  });
  if (!renditions.length) return compacted;
  const native = await structureNative().deriveDocumentStructure({
    kind: "opinion",
    record: {
      id: compacted.opinionId === null ? "" : String(compacted.opinionId),
      opinion_type: compacted.type,
      author: compacted.author,
      page_count: asNumber(opinion.page_count) ?? asNumber(opinion.pageCount),
      renditions,
      citations,
      cluster: Object.entries(cluster).flatMap(([field, value]) => typeof value === "string" && value ? [[field, value] as [string, string]] : []),
    },
    url: compacted.url,
  });
  return { ...compacted, native };
}

function uniqueOpinionPdfUrl(opinions: Array<{ pdfUrl: string | null }>) {
  const urls = [...new Set(opinions.map(({ pdfUrl }) => pdfUrl).filter(Boolean))];
  return urls.length === 1 ? urls[0]! : null;
}

function opinionDocument(opinion: object) {
  return (opinion as JsonRecord).native as NativeDocument | undefined;
}

function hasNativeOpinionStructure(opinion: object) {
  const document = opinionDocument(opinion);
  return document ? structureNative().documentHasOrigin(document, "native") : false;
}

async function fetchCaseOpinionsFromCourtlistenerOpinionsEndpoint(args: {
  clusterId: number;
  opinionId?: number;
  apiToken?: string | null;
  signal?: AbortSignal;
}) {
  const MAX_OPINION_PAGES = 10;
  const cluster = await courtlistenerFetch<JsonRecord>(
    `/clusters/${args.clusterId}/`, { signal: args.signal }, args.apiToken);
  if (!cluster) throw new Error(`CourtListener has no cluster ${args.clusterId}.`);
  const citations = apiCitations(cluster);
  const opinions: Awaited<ReturnType<typeof compactOpinion>>[] = [];
  let nextUrl: string | null = `/opinions/?cluster=${args.clusterId}`;
  let pages = 0;

  while (nextUrl && pages < MAX_OPINION_PAGES) {
    pages += 1;
    const data = await courtlistenerFetch<JsonRecord>(
      nextUrl, { signal: args.signal }, args.apiToken);
    const results = Array.isArray(data?.results) ? data.results : [];
    const pageOpinions = results.filter(isJsonRecord);
    for (const opinion of pageOpinions.filter((opinion) =>
      args.opinionId === undefined || opinionIdentifier(opinion) === args.opinionId)) {
      opinions.push(await compactOpinion(opinion, cluster, citations));
    }
    if (args.opinionId !== undefined && opinions.length) break;
    nextUrl = asString(data?.next);
  }

  return {
    id: args.clusterId,
    url: absoluteWebUrl(cluster.absolute_url) ?? opinions[0]?.url ??
      `${COURTLISTENER_WEB_BASE}/opinion/${args.clusterId}/`,
    pdfUrl: absoluteStorageUrl(cluster.filepath_pdf_harvard) ??
      absoluteStorageUrl(cluster.filepath_pdf_scan) ?? uniqueOpinionPdfUrl(opinions),
    opinions,
    source: "api",
  };
}

function parseCitationParts(value: string) {
  const match = structureNative().providerCitationsInText(value)
    .find(({ family }) => family === "reporter");
  if (!match?.volume || !match.reporter || !match.page) return null;
  return {
    volume: match.volume,
    reporter: match.reporter.replace(/\s+/g, " ").trim(),
    page: match.page,
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
    citations,
    url: cluster.slug
      ? `${COURTLISTENER_WEB_BASE}/opinion/${cluster.id}/${cluster.slug}/`
      : `${COURTLISTENER_WEB_BASE}/opinion/${cluster.id}/`,
    pdfUrl: absoluteStorageUrl(cluster.filepathPdfHarvard) ?? uniqueOpinionPdfUrl(opinions),
  };
}

function uniqueCitationCluster(ids: unknown[]): number | null {
  const matches = [...new Set(ids.filter((id): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0))];
  return matches.length === 1 ? matches[0] : null;
}

/** Resolve one request; report/link rendering is not part of this boundary. */
async function citationCluster(
  citation: string,
  apiToken?: string | null,
  signal?: AbortSignal,
): Promise<number | null> {
  let text = trimmedText(citation);
  if (!text) return null;
  const localAvailable = courtlistenerLocalBulkAvailable();
  if (localAvailable) {
    const parts = parseCitationParts(text);
    if (parts) {
      text = [parts.volume, parts.reporter, parts.page].filter(Boolean).join(" ");
      const matches = lookupLocalCourtlistenerCitation(parts) ?? [];
      // An ambiguous local hit is authoritative too: do not ask the API to choose.
      if (matches.length) return uniqueCitationCluster(matches.map(({ id }) => id));
    }
    if (courtlistenerToken(apiToken) === null) return null;
  }
  // CourtListener is not asked while lookups stay on this computer.
  if (!lookupsLeaveComputer()) return null;
  const results = await courtlistenerFetch<unknown>(
    "/citation-lookup/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text: text.slice(0, 64000) }),
      signal,
    },
    apiToken,
  );
  return uniqueCitationCluster((Array.isArray(results) ? results : []).flatMap((value) => {
    const row = jsonRecord(value);
    if (!Array.isArray(row?.clusters)) return [];
    return row.clusters.flatMap((value) => {
      const cluster = jsonRecord(value);
      return asString(cluster?.absolute_url) ? [cluster?.id] : [];
    });
  }));
}

async function getBulkCourtlistenerCaseOpinions(clusterId: number, opinionId?: number) {
  const local = getLocalCourtlistenerCase(clusterId);
  if (!local) return null;
  // The local store keeps the case's names and date, under CourtListener's own field names, and its citations as printed.
  const cluster = { case_name: local.cluster.caseName, case_name_full: local.cluster.caseNameFull,
    case_name_short: local.cluster.caseNameShort, date_filed: local.cluster.dateFiled };
  const citations = local.citations.flatMap((cite) => {
    const parts = parseCitationParts(cite);
    return parts ? [{ ...parts, kind: "" }] : [];
  });
  const opinions = await Promise.all(
    local.opinions
      .filter((opinion) => opinionId === undefined || opinion.id === opinionId)
      .map((opinion) => compactOpinion(opinion as unknown as JsonRecord, cluster, citations)),
  );
  return {
    ...compactLocalBulkCluster(local.cluster, local.citations, opinions),
    opinions,
    source: "bulk-local",
  };
}

async function searchCases(args: {
  query?: string;
  court?: string;
  filedAfter?: string;
  filedBefore?: string;
  limit?: number;
  apiToken?: string | null;
  signal?: AbortSignal;
}) {
  const query = args.query?.trim();
  if (!query) return { error: "query is required." };
  const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 10)));
  const local = args.court?.trim() ? null : searchLocalCourtlistenerCases({
    query, limit,
    filedAfter: args.filedAfter, filedBefore: args.filedBefore,
  });
  if (local?.length || (local !== null && courtlistenerToken(args.apiToken) === null)) {
    return {
      query,
      source: "bulk-local",
      results: (local ?? []).map((cluster) => {
        const { id: clusterId, caseName, dateFiled, url } = compactLocalBulkCluster(cluster);
        return { clusterId, caseName, citation: null, court: null, dateFiled, snippet: null, url };
      }),
    };
  }
  const params = new URLSearchParams({ type: "o", q: searchLucene(query) });
  if (args.court?.trim()) params.set("court", args.court.trim());
  if (args.filedAfter?.trim()) params.set("filed_after", args.filedAfter.trim());
  if (args.filedBefore?.trim()) params.set("filed_before", args.filedBefore.trim());

  const data = await courtlistenerFetch<JsonRecord>(
    `/search/?${params}`, { signal: args.signal }, args.apiToken);
  const rawResults = Array.isArray(data?.results) ? data.results : [];
  return {
    query,
    results: rawResults.slice(0, limit).map((raw) => {
      const r = raw as JsonRecord;
      return {
        clusterId: asNumber(r.cluster_id) ?? asNumber((r.cluster as JsonRecord | undefined)?.id),
        caseName: firstString(r, "caseName", "case_name", "caseNameFull"),
        citation: asString(r.citation) ?? (Array.isArray(r.citation)
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
  clusterId: number;
  opinionId?: number;
  apiToken?: string | null;
  signal?: AbortSignal;
}) {
  return await getBulkCourtlistenerCaseOpinions(args.clusterId, args.opinionId) ??
    await fetchCaseOpinionsFromCourtlistenerOpinionsEndpoint({
      clusterId: args.clusterId, opinionId: args.opinionId,
      apiToken: args.apiToken, signal: args.signal,
    });
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
};

function provider(
  options: CourtlistenerProviderOptions = {},
): LegalSourceProvider<CourtlistenerLegalSourceNative> {
  return {
    id: "courtlistener",
    // CourtListener answers a citation lookup only with an API key (401 without one): with neither its bulk copy here
    // nor a key it is not asked, as a page that cannot reach it asks it nothing.
    canResolve: (request) =>
      request.kind === "case" && (courtlistenerLocalBulkAvailable()
        || lookupsLeaveComputer("courtlistener") && courtlistenerToken(options.apiToken) !== null) &&
        structureNative().providerCitationsInText(request.text).some(({ jurisdiction }) => jurisdiction === "us"),
    async resolve(request) {
      const clusterId = await citationCluster(request.text, options.apiToken, request.signal);
      return clusterId
        ? [{ provider: "courtlistener", id: String(clusterId), kind: "case",
            citation: request.text }]
        : [];
    },
    canSearch(request) {
      return request.kinds.includes("case") &&
        !["ca", "canada", "canadian"].includes(searchJurisdiction(request));
    },
    async search(request) {
      const response = await searchCases({
        query: request.text,
        court: request.collection,
        filedAfter: request.dateFrom,
        filedBefore: request.dateTo,
        limit: request.perProviderLimit ?? request.limit,
        apiToken: options.apiToken,
        signal: request.signal,
      });
      const rows = Array.isArray((response as { results?: unknown }).results)
        ? (response as { results: JsonRecord[] }).results
        : [];
      return rows.flatMap((row) => {
        const clusterId = asNumber(row.clusterId);
        return clusterId
          ? [{ provider: "courtlistener", id: String(clusterId), kind: "case" as const,
              title: asString(row.caseName), citation: asString(row.citation),
              date: asString(row.dateFiled), collection: asString(row.court),
              url: asString(row.url), snippet: asString(row.snippet) }]
          : [];
      });
    },
    async readPassage(request) {
      const clusterId = Number(request.source.id);
      if (!Number.isSafeInteger(clusterId) || clusterId <= 0) return [];
      const wantedOpinionId = request.source.part ? Number(request.source.part) : undefined;
      if (wantedOpinionId !== undefined &&
          (!Number.isSafeInteger(wantedOpinionId) || wantedOpinionId <= 0)) return [];
      const caseRecord: JsonRecord = await caseOpinions({
        clusterId, opinionId: wantedOpinionId,
        apiToken: options.apiToken, signal: request.signal,
      });
      const opinions = Array.isArray(caseRecord.opinions)
        ? caseRecord.opinions.filter((opinion): opinion is object =>
            Boolean(opinion) && typeof opinion === "object")
        : [];
      const caseUrl = asString(caseRecord.url);
      return opinions.flatMap((opinion) => {
        const opinionRecord = opinion as JsonRecord;
        const opinionId = opinionIdentifier(opinionRecord);
        if (wantedOpinionId !== undefined && opinionId !== wantedOpinionId) return [];
        const document = opinionDocument(opinion);
        if (!document) return [];
        const url = asString(opinionRecord.url) ?? caseUrl;
        if (!url) return [];
        return nativeDocumentPassages({
          request,
          reference: {
            ...courtlistenerReference(request.source, caseRecord, url),
            ...(opinionId ? { part: String(opinionId) } : {}),
          },
          document,
          native: { case: caseRecord },
        });
      });
    },
  };
}

/**
 * Cluster metadata, PDF, and full opinion text for one US reporter citation.
 * A single cluster is this provider's uniqueness rule: a citation matching
 * several clusters, or none, is refused rather than picked between.
 */
async function caseSource(citation: string, signal?: AbortSignal) {
  const matches = await provider().resolve!({ text: citation, kind: "case", signal });
  const clusterId = matches.length === 1 ? Number(matches[0].id) : Number.NaN;
  if (!Number.isSafeInteger(clusterId) || clusterId <= 0) return null;
  const record = await caseOpinions({ clusterId, signal }) as JsonRecord;
  const opinions = (Array.isArray(record.opinions) ? record.opinions : []) as JsonRecord[];
  return {
    id: String(clusterId), date: asString(record.dateFiled),
    url: asString(record.url), title: asString(record.caseName),
    pdfUrl: asString(record.pdfUrl) ??
      uniqueOpinionPdfUrl(opinions.map((one) => ({ pdfUrl: asString(one.pdfUrl) }))),
    citation: (Array.isArray(record.citations) ? record.citations : [])
      .flatMap((value: unknown) => citationLabel(value) ?? [])[0] ?? citation,
    text: opinions.flatMap((one) => opinionDocument(one) ?? [])
      .map((document) => structureNative().documentText(document)).join("\n\n"),
  };
}

export const courtlistenerLegalSourceProvider = Object.assign(provider(), {
  configured: provider,
  caseSource,
  hasNativeOpinionStructure,
});
