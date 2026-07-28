import { downloadFile, listFiles } from "./storage";
import { createServerSupabase } from "./supabase";
import type { SourceDoc, SourceDocLocatorKind } from "./sourceDoc";
import {
  compileNativeMarkupSourceDoc,
  lookupLegalSourceDoc,
} from "./sourceDocNativeMarkup";
import {
  courtlistenerLocalBulkAvailable,
  getLocalCourtlistenerCase,
  lookupLocalCourtlistenerCitation,
  searchLocalCourtlistenerCases,
  type LocalCourtlistenerCluster,
  type LocalCourtlistenerOpinion,
} from "./courtlistenerLocalBulk";

const COURTLISTENER_BASE = "https://www.courtlistener.com/api/rest/v4";
const COURTLISTENER_WEB_BASE = "https://www.courtlistener.com";
const COURTLISTENER_STORAGE_BASE = "https://storage.courtlistener.com";
const COURTLISTENER_R2_OPINIONS_PREFIX = "courtlistener/opinions/by-cluster";

type JsonRecord = Record<string, unknown>;
type ServerSupabase = ReturnType<typeof createServerSupabase>;
const opinionDocumentTexts = new WeakMap<object, string>();
const opinionStructures = new WeakMap<object, SourceDoc>();
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

const courtlistenerBulkDataEnabled = () =>
  courtlistenerLocalBulkAvailable() ||
  process.env.COURTLISTENER_BULK_DATA_ENABLED === "true";

function courtlistenerHeaders(apiToken?: string | null): HeadersInit {
  const token = apiToken?.trim() || process.env.COURTLISTENER_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "COURTLISTENER_API_TOKEN must be set to use CourtListener tools.",
    );
  }
  return { Accept: "application/json", Authorization: `Token ${token}` };
}

function parseCourtlistenerError(status: number, detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed) return `CourtListener error (${status})`;
  let message = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      message =
        typeof record.detail === "string" && record.detail.trim()
          ? record.detail.trim()
          : typeof record.message === "string" && record.message.trim()
            ? record.message.trim()
            : trimmed;
    }
  } catch {
    // Non-JSON response bodies are displayed as-is.
  }

  if (status === 429) {
    const wait = message.match(/available in\s+(\d+)\s+seconds?/i)?.[1];
    return wait
      ? `CourtListener rate limit exceeded. Try again in ${wait} seconds.`
      : `CourtListener rate limit exceeded. ${message}`;
  }
  return `CourtListener error (${status}): ${message}`;
}

async function courtlistenerFetch<T>(
  pathOrUrl: string,
  init?: RequestInit,
  apiToken?: string | null,
): Promise<T> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${COURTLISTENER_BASE}${pathOrUrl}`;
  // Absolute URLs come from API payloads (pagination `next`, opinion links).
  // The Authorization token rides on every request, so never follow one off
  // the CourtListener origins - a poisoned link would exfiltrate the token.
  if (
    !url.startsWith(`${COURTLISTENER_WEB_BASE}/`) &&
    !url.startsWith(`${COURTLISTENER_STORAGE_BASE}/`)
  ) {
    throw new Error("Refusing CourtListener request to a foreign origin.");
  }
  const method = init?.method ?? "GET";
  devLog("[courtlistener/api] request", { method, path: pathOrUrl, url });
  const response = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
    headers: {
      ...courtlistenerHeaders(apiToken),
      ...(init?.headers ?? {}),
    },
  });
  devLog("[courtlistener/api] response", {
    method, path: pathOrUrl, status: response.status,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(parseCourtlistenerError(response.status, detail));
  }
  return response.json() as Promise<T>;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

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

function compactCluster(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return {
      id: null, caseName: null, dateFiled: null, court: null,
      citations: [], url: null, subOpinions: [],
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

function attachOpinionStructure(
  compacted: { opinionId: number | null; url: string | null },
  text: string | null,
  markup: string | null,
) {
  if (!text) return;
  opinionDocumentTexts.set(compacted, text);
  opinionStructures.set(
    compacted,
    compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: compacted.opinionId === null ? "" : String(compacted.opinionId),
      url: compacted.url,
      text,
      markup,
    }),
  );
}

function compactOpinion(opinion: JsonRecord, maxChars: number) {
  const rawHtml = firstString(opinion, "html_with_citations", "html", "xml_harvard");
  const rawText = asString(opinion.plain_text) ?? rawHtml;
  const text = stripOpinionMarkup(rawText);
  const html = sanitizeOpinionHtml(rawHtml);
  const compacted = {
    opinionId: asNumber(opinion.id),
    type: asString(opinion.type),
    author:
      asString(opinion.author_str) ??
      asString((opinion.author as JsonRecord | undefined)?.name),
    per_curiam: asString(opinion.per_curiam),
    joined_by_str: asString(opinion.joined_by_str),
    url: absoluteWebUrl(opinion.absolute_url),
    text: truncate(text, maxChars),
    html: truncate(html, maxChars),
  };
  attachOpinionStructure(
    compacted,
    text,
    firstString(opinion, "xml_harvard", "html_with_citations", "html",
      "html_lawbox", "html_columbia", "html_anon_2020"),
  );
  return compacted;
}

export function getCourtlistenerOpinionDocumentText(opinion: object) {
  return opinionDocumentTexts.get(opinion) ?? "";
}

export function getCourtlistenerOpinionStructure(opinion: object) {
  return opinionStructures.get(opinion) ?? null;
}

export function lookupCourtlistenerOpinionLocator(
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
}) {
  const MAX_OPINION_PAGES = 10;
  const opinions: ReturnType<typeof compactOpinion>[] = [];
  const rawOpinions: JsonRecord[] = [];
  let nextUrl: string | null = `/opinions/?cluster=${args.clusterId}`;
  let pages = 0;
  let remainingChars = args.maxChars;

  while (nextUrl && pages < MAX_OPINION_PAGES && remainingChars > 0) {
    pages += 1;
    devLog("[courtlistener/opinions-endpoint] fetching page", {
      clusterId: args.clusterId, path: nextUrl, page: pages,
    });
    const data = await courtlistenerFetch<JsonRecord>(
      nextUrl,
      undefined,
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
      const compacted = compactOpinion(
        opinion,
        Math.max(1, Math.min(opinionMaxChars, remainingChars)),
      );
      rawOpinions.push(opinion);
      opinions.push(compacted);
      remainingChars -=
        (compacted.text?.length ?? 0) + (compacted.html?.length ?? 0);
    }
    nextUrl = asString(data.next);
  }

  return {
    id: args.clusterId,
    url:
      absoluteWebUrl(rawOpinions[0]?.absolute_url) ??
      `${COURTLISTENER_WEB_BASE}/opinion/${args.clusterId}/`,
    opinions,
    source: "api",
  };
}

function truncate(value: string | null, maxChars: number): string | null {
  if (!value) return null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function safeCourtlistenerHref(rawHref: string | null): string | null {
  if (!rawHref) return null;
  const href = decodeHtmlEntities(rawHref.trim());
  if (!href) return null;
  if (href.startsWith("#")) return href;
  if (href.startsWith("/")) return `${COURTLISTENER_WEB_BASE}${href}`;
  if (href.startsWith(COURTLISTENER_WEB_BASE)) return href;
  if (/^https?:\/\//i.test(href)) return null;
  return null;
}

const SAFE_OPINION_HTML_TAGS = new Set(
  "a blockquote br code div em h1 h2 h3 h4 h5 h6 i li ol p pre small span strong sub sup table tbody td th thead tr u ul".split(
    " ",
  ),
);

const SAFE_OPINION_ATTRS = new Set(
  "aria-label class colspan href id rowspan title".split(" "),
);

const VOID_OPINION_TAGS = new Set(["br"]);

function sanitizeOpinionClassList(value: string): string | null {
  const classes = decodeHtmlEntities(value)
    .split(/\s+/)
    .filter((className) => /^[a-z0-9_-]{1,80}$/i.test(className));
  return classes.length ? classes.join(" ") : null;
}

function sanitizeOpinionHtmlAttrs(tagName: string, attrs: string): string {
  const output: string[] = [];
  const attrPattern =
    /([^\s"'<>/=`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = attrPattern.exec(attrs))) {
    const rawName = match[1] ?? "";
    const name = rawName.toLowerCase();
    const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
    if (!SAFE_OPINION_ATTRS.has(name) || name.startsWith("on")) continue;

    if (name === "href") {
      if (tagName !== "a") continue;
      const href = safeCourtlistenerHref(rawValue);
      if (!href) continue;
      output.push(`href="${escapeHtml(href)}"`);
      continue;
    }

    if (name === "class") {
      const classList = sanitizeOpinionClassList(rawValue);
      if (classList) output.push(`class="${escapeHtml(classList)}"`);
      continue;
    }

    if (name === "id") {
      const id = decodeHtmlEntities(rawValue).trim();
      if (/^[a-z0-9_-]{1,120}$/i.test(id)) {
        output.push(`id="${escapeHtml(id)}"`);
      }
      continue;
    }

    if (name === "colspan" || name === "rowspan") {
      const value = Number.parseInt(rawValue, 10);
      if (Number.isFinite(value) && value > 0 && value <= 100) {
        output.push(`${name}="${value}"`);
      }
      continue;
    }

    const value = decodeHtmlEntities(rawValue).trim();
    if (value) output.push(`${name}="${escapeHtml(value.slice(0, 300))}"`);
  }

  if (tagName === "a") {
    output.push('target="_blank"', 'rel="noopener noreferrer"');
  }

  return output.length ? ` ${output.join(" ")}` : "";
}

function sanitizeOpinionHtml(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|iframe|object|embed|form|svg|math)\b[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(
      /<(script|style|iframe|object|embed|form|svg|math)\b[^>]*\/?>/gi,
      "",
    )
    .replace(
      /<page-number\b[^>]*>([\s\S]*?)<\/page-number>/gi,
      (_m, inner) =>
        `<span class="case-page-number">${escapeHtml(stripOpinionMarkup(inner) ?? "")}</span>`,
    );

  const sanitized = normalized.replace(
    /<\/?([a-z0-9-]+)\b([^>]*)>/gi,
    (match, tag, attrs) => {
      const name = String(tag).toLowerCase();
      const closing = match.startsWith("</");
      if (!SAFE_OPINION_HTML_TAGS.has(name)) return "";
      if (closing) {
        return VOID_OPINION_TAGS.has(name) ? "" : `</${name}>`;
      }
      if (VOID_OPINION_TAGS.has(name)) return `<${name}>`;
      return `<${name}${sanitizeOpinionHtmlAttrs(name, String(attrs))}>`;
    },
  );

  return sanitized.replace(/\n{3,}/g, "\n\n").trim();
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

const citationPartsLabel = (parts: ReturnType<typeof parseCitationParts>) =>
  parts
    ? [parts.volume, parts.reporter, parts.page].filter(Boolean).join(" ")
    : null;

function clusterUrl(cluster: JsonRecord): string | null {
  const id = asNumber(cluster.id);
  if (!id) return null;
  const slug = asString(cluster.slug);
  return slug
    ? `${COURTLISTENER_WEB_BASE}/opinion/${id}/${slug}/`
    : `${COURTLISTENER_WEB_BASE}/opinion/${id}/`;
}

function compactBulkCluster(cluster: JsonRecord, citations: string[] = []) {
  return {
    id: asNumber(cluster.id),
    caseName: firstString(cluster, "case_name", "case_name_full", "case_name_short"),
    dateFiled: asString(cluster.date_filed),
    court: null,
    citations,
    url: clusterUrl(cluster),
    pdfUrl: absoluteStorageUrl(cluster.filepath_pdf_harvard),
    subOpinions: [],
  };
}

function compactLocalBulkCluster(
  cluster: LocalCourtlistenerCluster,
  citations: string[] = [],
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
    pdfUrl: absoluteStorageUrl(cluster.filepathPdfHarvard),
    subOpinions: [],
  };
}

type CitationLookupCluster =
  | ReturnType<typeof compactCluster>
  | ReturnType<typeof compactBulkCluster>;

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

async function getBulkCitationLookup(args: {
  db?: ServerSupabase;
  citations: string[];
  allowPartial?: boolean;
}): Promise<CitationLookupPayload | null> {
  const parsed = args.citations.map((citation) => ({
    citation,
    parts: parseCitationParts(citation),
  }));
  devLog("[courtlistener/bulk-citation-lookup] candidates", {
    enabled: courtlistenerBulkDataEnabled(),
    hasDb: !!args.db,
    allowPartial: !!args.allowPartial,
    count: parsed.length,
    candidates: parsed.map((r) => ({ citation: r.citation, parsed: r.parts })),
  });
  if (!parsed.length) return null;
  if (courtlistenerLocalBulkAvailable()) {
    const results: CitationLookupRow[] = parsed.map((row) => {
      const parts = row.parts;
      if (!parts) {
        return {
          citation: row.citation,
          status: "invalid",
          message: "Citation could not be parsed for bulk lookup.",
          clusters: [],
        };
      }
      const citation = citationPartsLabel(parts);
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
      citationsSubmitted: args.citations.length || undefined,
      citationLinks: buildCitationLinks(results),
      results,
      source: "bulk-local",
    };
  }
  if (!args.db || !courtlistenerBulkDataEnabled()) return null;
  if (!args.allowPartial && parsed.some((row) => !row.parts)) {
    devLog("[courtlistener/bulk-citation-lookup] skipped", {
      reason: "unparseable_candidate",
      unparseable: parsed.filter((r) => !r.parts).map((r) => r.citation),
    });
    return null;
  }

  const results: CitationLookupRow[] = [];
  const failRow = (
    citation: string | null,
    status: string,
    message: string,
  ) => {
    results.push({ citation, status, message, clusters: [] });
  };

  for (const row of parsed) {
    const parts = row.parts;
    if (!parts) {
      devLog("[courtlistener/bulk-citation-lookup] skipped candidate", {
        citation: row.citation, reason: "unparseable_candidate",
      });
      if (!args.allowPartial) return null;
      failRow(
        row.citation,
        "invalid",
        "Citation could not be parsed for bulk lookup.",
      );
      continue;
    }
    const verifiedCitation = citationPartsLabel(parts);
    if (!verifiedCitation) {
      if (!args.allowPartial) return null;
      failRow(
        row.citation,
        "invalid",
        "Citation could not be normalized for bulk lookup.",
      );
      continue;
    }
    devLog("[courtlistener/bulk-citation-lookup] citation query", {
      citation: row.citation, ...parts,
    });
    const { data: citationRows, error } = await args.db
      .from("courtlistener_citation_index")
      .select("cluster_id, volume, reporter, page")
      .eq("volume", parts.volume)
      .eq("reporter", parts.reporter)
      .eq("page", parts.page)
      .limit(20);
    devLog("[courtlistener/bulk-citation-lookup] citation query result", {
      citation: row.citation,
      rowCount: citationRows?.length ?? 0,
      error: error?.message ?? null,
    });
    if (error) {
      if (!args.allowPartial) return null;
      failRow(verifiedCitation, "error", error.message);
      continue;
    }
    const clusterIds = [
      ...new Set(
        (citationRows ?? [])
          .map((citationRow) =>
            typeof citationRow.cluster_id === "number"
              ? citationRow.cluster_id
              : Number(citationRow.cluster_id),
          )
          .filter((id) => Number.isFinite(id)),
      ),
    ];
    if (!clusterIds.length) {
      if (!args.allowPartial) return null;
      failRow(
        verifiedCitation,
        "not_found",
        "Citation was not found in the bulk citation index.",
      );
      continue;
    }

    devLog("[courtlistener/bulk-citation-lookup] cluster query", {
      citation: row.citation, clusterIds,
    });
    const { data: clusters, error: clusterError } = await args.db
      .from("courtlistener_opinion_cluster_index")
      .select(
        "id, case_name, case_name_short, case_name_full, slug, date_filed, filepath_pdf_harvard",
      )
      .in("id", clusterIds);
    devLog("[courtlistener/bulk-citation-lookup] cluster query result", {
      citation: row.citation,
      requestedCount: clusterIds.length,
      rowCount: clusters?.length ?? 0,
      error: clusterError?.message ?? null,
    });
    if (clusterError) {
      if (!args.allowPartial) return null;
      failRow(verifiedCitation, "error", clusterError.message);
      continue;
    }
    const clustersById = new Map<
      number,
      ReturnType<typeof compactBulkCluster>
    >();
    for (const cluster of clusters ?? []) {
      const compact = compactBulkCluster(cluster as JsonRecord, [
        verifiedCitation,
      ]);
      if (typeof compact.id === "number") clustersById.set(compact.id, compact);
    }
    const matchedClusters = clusterIds
      .map((clusterId) => clustersById.get(clusterId))
      .filter(
        (cluster): cluster is ReturnType<typeof compactBulkCluster> =>
          !!cluster && !!cluster.caseName,
      );
    if (matchedClusters.length !== clusterIds.length) {
      if (!args.allowPartial) return null;
      results.push({
        citation: verifiedCitation,
        status: matchedClusters.length ? "partial" : "not_found",
        message:
          "Some citation clusters were missing from the bulk cluster index.",
        clusters: matchedClusters,
      });
      continue;
    }

    results.push({
      citation: verifiedCitation,
      status: "ok",
      message: null,
      clusters: matchedClusters,
    });
  }

  return {
    citationsSubmitted: args.citations.length || undefined,
    citationLinks: buildCitationLinks(results),
    results,
    source: "bulk",
  };
}

async function fetchCourtlistenerCitationLookup(args: {
  text: string;
  citationsSubmitted?: number;
  apiToken?: string | null;
}): Promise<CitationLookupPayload> {
  const body = new URLSearchParams({ text: args.text.slice(0, 64000) });
  const results = await courtlistenerFetch<unknown[]>(
    "/citation-lookup/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
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
  db?: ServerSupabase;
  clusterId: number;
  maxChars: number;
}) {
  const local = getLocalCourtlistenerCase(args.clusterId);
  if (local) {
    return {
      ...compactLocalBulkCluster(local.cluster, local.citations),
      opinions: local.opinions.map((opinion) =>
        compactLocalOpinion(opinion, args.maxChars),
      ),
      source: "bulk-local",
    };
  }
  if (!courtlistenerBulkDataEnabled()) {
    devLog("[courtlistener/r2-opinions] bulk data disabled", {
      clusterId: args.clusterId,
    });
    return null;
  }

  const prefix = `${COURTLISTENER_R2_OPINIONS_PREFIX}/${args.clusterId}/`;
  devLog("[courtlistener/r2-opinions] listing", {
    clusterId: args.clusterId, prefix,
  });
  const opinionKeys = (await listFiles(prefix))
    .filter((key) => key.endsWith(".json"))
    .sort();
  devLog("[courtlistener/r2-opinions] listed", {
    clusterId: args.clusterId, count: opinionKeys.length, keys: opinionKeys,
  });
  if (!opinionKeys.length) return null;

  const rawOpinions = (
    await Promise.all(
      opinionKeys.map(async (key) => {
        const bytes = await downloadFile(key);
        if (!bytes) {
          devLog("[courtlistener/r2-opinions] download missing", {
            clusterId: args.clusterId, key,
          });
          return null;
        }
        try {
          return JSON.parse(Buffer.from(bytes).toString("utf8")) as JsonRecord;
        } catch {
          devLog("[courtlistener/r2-opinions] parse failed", {
            clusterId: args.clusterId, key, bytes: bytes.byteLength,
          });
          return null;
        }
      }),
    )
  ).filter((opinion): opinion is JsonRecord => !!opinion);
  devLog("[courtlistener/r2-opinions] parsed", {
    clusterId: args.clusterId, count: rawOpinions.length,
  });
  if (!rawOpinions.length) return null;

  let compactCluster:
    | ReturnType<typeof compactBulkCluster>
    | { id: number; url: string | null } = {
    id: args.clusterId,
    url:
      absoluteWebUrl(rawOpinions[0]?.url) ??
      absoluteWebUrl(rawOpinions[0]?.absolute_url) ??
      `${COURTLISTENER_WEB_BASE}/opinion/${args.clusterId}/`,
  };
  if (args.db) {
    const { data: cluster, error } = await args.db
      .from("courtlistener_opinion_cluster_index")
      .select(
        "id, case_name, case_name_short, case_name_full, slug, date_filed, filepath_pdf_harvard",
      )
      .eq("id", args.clusterId)
      .maybeSingle();
    if (error) {
      devLog("[courtlistener/r2-opinions] cluster metadata query failed", {
        clusterId: args.clusterId, error: error.message,
      });
    } else if (cluster) {
      const { data: citationRows } = await args.db
        .from("courtlistener_citation_index")
        .select("volume, reporter, page")
        .eq("cluster_id", args.clusterId)
        .limit(20);
      const citations = (citationRows ?? [])
        .map((row) =>
          [row.volume, row.reporter, row.page].filter(Boolean).join(" "),
        )
        .filter(Boolean);
      compactCluster = compactBulkCluster(cluster as JsonRecord, citations);
    } else {
      devLog("[courtlistener/r2-opinions] cluster metadata missing", {
        clusterId: args.clusterId,
      });
    }
  }

  return {
    ...compactCluster,
    opinions: rawOpinions
      .filter(
        (opinion): opinion is JsonRecord =>
          !!opinion && typeof opinion === "object" && !Array.isArray(opinion),
      )
      .map((opinion) => {
        const rawHtml = firstString(opinion,
          "htmlWithCitations", "html_with_citations", "html",
          "htmlLawbox", "html_lawbox", "htmlColumbia", "html_columbia",
          "htmlWithCitationsLawbox", "html_with_citations_lawbox",
          "xmlHarvard", "xml_harvard", "xmlLawbox", "xml_lawbox");
        const rawText =
          asString(opinion.plainText) ?? asString(opinion.plain_text) ?? rawHtml;
        const text = stripOpinionMarkup(rawText);
        const compacted = {
          opinionId:
            asNumber(opinion.opinionId) ??
            asNumber(opinion.id) ??
            asNumber(opinion.opinion_id),
          type: asString(opinion.type),
          author: asString(opinion.author) ?? asString(opinion.author_str),
          per_curiam: asString(opinion.per_curiam),
          joined_by_str: asString(opinion.joined_by_str),
          url: absoluteWebUrl(opinion.url),
          text: truncate(text, args.maxChars),
          html: truncate(sanitizeOpinionHtml(rawHtml), args.maxChars),
        };
        attachOpinionStructure(
          compacted,
          text,
          firstString(opinion,
            "xmlHarvard", "xml_harvard", "htmlWithCitations",
            "html_with_citations", "html", "htmlLawbox", "html_lawbox",
            "htmlColumbia", "html_columbia"),
        );
        return compacted;
      }),
    source: "bulk",
  };
}

function compactLocalOpinion(
  opinion: LocalCourtlistenerOpinion,
  maxChars: number,
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
      local_path: opinion.localPath,
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
  );
}

export async function verifyCourtlistenerCitations(args: {
  citations?: string[];
  db?: ServerSupabase;
  apiToken?: string | null;
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

  const bulk = await getBulkCitationLookup({
    db: args.db,
    citations,
    allowPartial: true,
  });
  devLog("[courtlistener/bulk-citation-lookup] result", {
    hit: !!bulk,
    citationsSubmitted: citations.length || undefined,
    candidateCount: citations.length,
    resultCount: bulk?.results.length ?? 0,
    citationLinkCount: bulk?.citationLinks.length ?? 0,
    statuses: bulk?.results.map((r) => r.status) ?? [],
    source: bulk?.source ?? null,
  });
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

    devLog("[courtlistener/bulk-citation-lookup] api fallback", {
      candidateCount: apiFallbackInputs.length, candidates: apiFallbackInputs,
    });
    try {
      const apiFallback = await fetchCourtlistenerCitationLookup({
        text: apiFallbackInputs.join("\n"),
        citationsSubmitted: apiFallbackInputs.length,
        apiToken: args.apiToken,
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
    } catch (err) {
      devLog("[courtlistener/bulk-citation-lookup] api fallback failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return bulk;
    }
  }

  return fetchCourtlistenerCitationLookup({
    text: citations.join("\n"),
    citationsSubmitted: citations.length || undefined,
    apiToken: args.apiToken,
  });
}

export async function searchCourtlistenerCaseLaw(args: {
  query?: string;
  court?: string;
  filedAfter?: string;
  filedBefore?: string;
  limit?: number;
  apiToken?: string | null;
}) {
  const query = args.query?.trim();
  if (!query) return { error: "query is required." };
  const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 10)));
  const local =
    args.court?.trim() || args.filedAfter?.trim() || args.filedBefore?.trim()
      ? null
      : searchLocalCourtlistenerCases({ query, limit });
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
    undefined,
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

export async function getCourtlistenerCaseOpinions(args: {
  clusterId?: number;
  includeFullText?: boolean;
  maxChars?: number;
  db?: ServerSupabase;
  apiToken?: string | null;
}) {
  if (!args.clusterId || !Number.isFinite(args.clusterId)) {
    return { error: "clusterId is required." };
  }
  const clusterId = Math.floor(args.clusterId);
  const maxChars = Math.max(1000, Math.min(50000, args.maxChars ?? 12000));
  const bulk = await getBulkCourtlistenerCaseOpinions({
    db: args.db,
    clusterId,
    maxChars,
  });
  if (bulk) return bulk;

  return fetchCaseOpinionsFromCourtlistenerOpinionsEndpoint({
    clusterId,
    maxChars,
    includeFullText: args.includeFullText,
    apiToken: args.apiToken,
  });
}

export async function getCourtlistenerCases(args: {
  clusterIds?: number[];
  includeFullText?: boolean;
  maxChars?: number;
  db?: ServerSupabase;
  apiToken?: string | null;
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
        const result = await getCourtlistenerCaseOpinions({
          clusterId,
          includeFullText: args.includeFullText,
          maxChars: args.maxChars,
          db: args.db,
          apiToken: args.apiToken,
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
