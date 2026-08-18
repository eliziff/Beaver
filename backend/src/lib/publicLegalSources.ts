import { XMLParser } from "fast-xml-parser";
import { cachedContent } from "./contentCache";
import {
  readSourceDocRange,
  type SourceDoc,
  type SourceDocLocatorKind,
  type SourceDocLookup,
} from "./sourceDoc";
import {
  compileNativeMarkupSourceDoc,
  lookupLegalSourceDoc,
  nativeMarkupCitedRefs,
  type NativeMarkupRef,
} from "./sourceDocNativeMarkup";
import type { JournalArticleSearchResult } from "./journalArticles";
import { sha256 } from "./hash";
import {
  guardedRemoteFetch,
  normalizeRemoteHttpsUrl,
} from "./remoteUrlSafety";
import type {
  LegalSourcePassage,
  LegalSourceProvider,
  LegalSourceReference,
  LegalSourceResolveRequest,
} from "./legalSources";

const TNA_ORIGIN = "https://caselaw.nationalarchives.gov.uk";
const GOVUK_ORIGIN = "https://www.gov.uk";
const GOVINFO_API = "https://api.govinfo.gov";
const GOVINFO_WEB = "https://www.govinfo.gov";
const TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

type TnaCaseSearchResult = {
  provider: "tna";
  citation: string;
  title: string | null;
  url: string;
  xmlUrl: string;
};

type GovUkEtSearchResult = {
  provider: "govuk-et";
  caseNumber: string;
  title: string;
  url: string;
};

type GovInfoCaseSearchResult = {
  provider: "govinfo";
  docket: string;
  packageId: string;
  title: string | null;
  url: string;
};

type PublicLegalSearchResult =
  | TnaCaseSearchResult
  | GovUkEtSearchResult
  | GovInfoCaseSearchResult
  | JournalArticleSearchResult;

type PublicLegalAttachment = {
  title: string | null;
  url: string;
  contentType: string | null;
  filename: string | null;
  pageCount: number | null;
};

export type PublicLegalDocument = {
  provider: PublicLegalSearchResult["provider"];
  identity: string;
  title: string | null;
  url: string;
  structure: SourceDoc;
  attachments: PublicLegalAttachment[];
  /** journal provider only: the article's canonical citation and date,
   * carried through so the pulled article can become a legal-evidence
   * receipt. Absent for the other providers. */
  citation?: string | null;
  date?: string | null;
  /** Cited authorities the provider's markup states as data (TNA <ref>). */
  citedAuthorities?: NativeMarkupRef[];
  sourceSha256?: string;
};

type PublicLegalLookup = SourceDocLookup & {
  provider: PublicLegalDocument["provider"];
  url: string;
  anchor: string | null;
};

const TNA_CITATION =
  /\[(?:19|20)\d{2}\]\s+(?:UKSC|UKPC|EWCA\s+(?:Civ|Crim)|EWHC|EWCC|EWFC|EWCOP|EWCR|UKUT|UKFTT|EAT)\s+\d+(?:\s+\((?:Admin|Admlty|Ch|Comm|Fam|KB|QB|TCC|Pat|IPEC|SCCO|AAC|IAC|LC|GRC|TC|B)\))?/iu;
const ET_CASE_NUMBER =
  /(?<![\w/])(?:[A-Z]\/)?\d{6,8}\/(?:19|20)\d{2}(?![\w/])/giu;
const FULL_DOCKET = /\b\d{1,2}:\d{2,4}-(?:cv|cr|bk|ap|md|mj|mc)-\d{1,8}\b/iu;
const APPEAL_DOCKET = /\b(?:case\s+)?no\.?\s*(\d{2}-\d{3,6})\b/iu;
const US_COURT =
  /\b(?:U\.?S\.?|United States|federal|Court of Appeals|\d{1,2}(?:st|nd|rd|th)\s+Cir\.?)\b/iu;
const GOVINFO_PACKAGE = /^USCOURTS-[A-Za-z0-9]+-([A-Za-z0-9_-]+)$/u;

const xmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: true,
});

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const text = asRecord(value)?.["#text"];
  return typeof text === "string" ? text.trim() || null : null;
}

function asNumber(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalized(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function trustedUrl(
  raw: unknown,
  base: string,
  hosts: ReadonlySet<string>,
): string | null {
  const value = asString(raw);
  if (!value) return null;
  try {
    const url = new URL(value, base);
    url.searchParams.delete("api_key");
    return normalizeRemoteHttpsUrl(url.toString(), {
      label: "Public legal source URL",
      allowedHosts: [...hosts],
      defaultPortOnly: true,
      allowIpLiterals: false,
    }).url.toString();
  } catch {
    return null;
  }
}

async function responseText(url: string, accept: string, init?: RequestInit) {
  // Downloaded-authority cache: published sources (legislation pages,
  // judgments) change rarely; a week bounds staleness.
  return cachedContent({
    scope: "shared",
    kind: "public-legal-text",
    key: `${accept} ${url}`,
    version: 1,
    ttlMs: 7 * 24 * 60 * 60 * 1_000,
    produce: async () => {
      const response = await guardedRemoteFetch(
        url,
        {
          ...init,
          headers: { Accept: accept, ...(init?.headers ?? {}) },
        },
        {
          label: "Public legal source request",
          allowedHosts: ["caselaw.nationalarchives.gov.uk"],
          defaultPortOnly: true,
          allowIpLiterals: false,
          timeoutMs: TIMEOUT_MS,
          response: {
            label: "Public legal source response",
            maxBytes: 64 * 1024 * 1024,
            contentTypes: [
              "application/atom+xml",
              "application/akn+xml",
              "application/xml",
              "text/xml",
            ],
          },
        },
      );
      if (!response.ok) {
        throw new Error(
          `Public legal source request failed (${response.status})`,
        );
      }
      return response.text();
    },
  });
}

async function responseJson(
  url: string,
  init?: RequestInit,
): Promise<JsonRecord> {
  // Search-ish endpoints: shorter staleness ceiling than document bodies.
  return cachedContent({
    scope: "shared",
    kind: "public-legal-json",
    key: url,
    version: 1,
    ttlMs: 24 * 60 * 60 * 1_000,
    produce: async () => {
      const response = await guardedRemoteFetch(
        url,
        {
          ...init,
          headers: { Accept: "application/json", ...(init?.headers ?? {}) },
        },
        {
          label: "Public legal source request",
          allowedHosts: ["www.gov.uk", "api.govinfo.gov"],
          defaultPortOnly: true,
          allowIpLiterals: false,
          timeoutMs: TIMEOUT_MS,
          response: {
            label: "Public legal source response",
            maxBytes: 32 * 1024 * 1024,
            contentTypes: ["application/json", "application/*+json"],
          },
        },
      );
      if (!response.ok) {
        throw new Error(
          `Public legal source request failed (${response.status})`,
        );
      }
      return asRecord(await response.json()) ?? {};
    },
  });
}

function tnaCitation(verbatim: string) {
  return verbatim.match(TNA_CITATION)?.[0].replace(/\s+/gu, " ").trim() ?? "";
}

function tnaCourt(citation: string) {
  const court = citation.match(
    /\]\s+(EWCA\s+(?:Civ|Crim)|UKSC|UKPC|EWHC|EWCC|EWFC|EWCOP|EWCR|UKUT|UKFTT|EAT)\b/iu,
  )?.[1];
  return court?.replace(/\s+/gu, "/").toLowerCase() ?? "";
}

async function searchTnaCase(
  verbatim: string,
  signal?: AbortSignal,
): Promise<TnaCaseSearchResult | null> {
  const citation = tnaCitation(verbatim);
  if (!citation) return null;
  const query = new URLSearchParams({
    query: `"${citation}"`,
    court: tnaCourt(citation),
    per_page: "50",
  });
  const xml = await responseText(
    `${TNA_ORIGIN}/atom.xml?${query}`,
    "application/atom+xml, application/xml",
    { signal },
  );
  const root = asRecord(xmlParser.parse(xml));
  const feed = asRecord(root?.feed) ?? root;
  const matches = new Map<string, TnaCaseSearchResult>();

  for (const value of asArray(feed?.entry)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const exact = asArray(entry.identifier).some((raw) => {
      const identifier = asRecord(raw);
      return (
        asString(identifier?.type)?.toLowerCase() === "ukncn" &&
        normalized(asString(identifier?.["#text"]) ?? "") ===
          normalized(citation)
      );
    });
    if (!exact) continue;

    let htmlUrl: string | null = null;
    let xmlUrl: string | null = null;
    for (const raw of asArray(entry.link)) {
      const link = asRecord(raw);
      if (asString(link?.rel)?.toLowerCase() !== "alternate") continue;
      const type = asString(link?.type)?.toLowerCase();
      const url = trustedUrl(
        link?.href,
        TNA_ORIGIN,
        new Set(["caselaw.nationalarchives.gov.uk"]),
      );
      if (!url) continue;
      if (type === "text/html" || !type) htmlUrl ??= url;
      if (
        type === "application/akn+xml" ||
        type === "application/xml" ||
        type === "text/xml"
      ) {
        xmlUrl ??= url;
      }
    }
    if (!htmlUrl || !xmlUrl) continue;
    matches.set(`${htmlUrl}\n${xmlUrl}`, {
      provider: "tna",
      citation,
      title: asString(entry.title),
      url: htmlUrl,
      xmlUrl,
    });
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

async function fetchTnaCase(
  result: TnaCaseSearchResult,
  signal?: AbortSignal,
): Promise<PublicLegalDocument> {
  const xmlUrl = trustedUrl(
    result.xmlUrl,
    TNA_ORIGIN,
    new Set(["caselaw.nationalarchives.gov.uk"]),
  );
  const url = trustedUrl(
    result.url,
    TNA_ORIGIN,
    new Set(["caselaw.nationalarchives.gov.uk"]),
  );
  if (!xmlUrl || !url) throw new Error("Invalid TNA case URL");
  const xml = await responseText(
    xmlUrl,
    "application/akn+xml, application/xml, text/xml",
    { signal },
  );
  const structure = compileNativeMarkupSourceDoc({
    provider: "tna",
    id: result.citation,
    url,
    text: "",
    markup: xml,
    citation: result.citation,
  });
  const sourceSha256 = sha256(xml);
  return {
    provider: "tna",
    identity: result.citation,
    title: result.title,
    url,
    structure,
    attachments: [],
    citedAuthorities: nativeMarkupCitedRefs(xml),
    sourceSha256,
  };
}

function etCaseNumber(verbatim: string) {
  const matches = new Set(
    [...verbatim.matchAll(ET_CASE_NUMBER)].map(([value]) =>
      value.toUpperCase(),
    ),
  );
  return matches.size === 1 ? [...matches][0] : "";
}

async function searchGovUkEtCase(
  verbatim: string,
  signal?: AbortSignal,
): Promise<GovUkEtSearchResult | null> {
  const caseNumber = etCaseNumber(verbatim);
  if (!caseNumber) return null;
  const query = new URLSearchParams({
    q: caseNumber,
    filter_format: "employment_tribunal_decision",
    count: "50",
  });
  const body = await responseJson(`${GOVUK_ORIGIN}/api/search.json?${query}`, {
    signal,
  });
  const matches = new Map<string, GovUkEtSearchResult>();
  for (const value of asArray(body.results)) {
    const item = asRecord(value);
    const title = asString(item?.title);
    const link = asString(item?.link);
    if (
      asString(item?.format) !== "employment_tribunal_decision" ||
      !title ||
      !link ||
      !link.startsWith("/employment-tribunal-decisions/") ||
      ![...title.matchAll(ET_CASE_NUMBER)].some(
        ([value]) => value.toUpperCase() === caseNumber,
      )
    ) {
      continue;
    }
    const url = trustedUrl(link, GOVUK_ORIGIN, new Set(["www.gov.uk"]));
    if (url) {
      matches.set(url, {
        provider: "govuk-et",
        caseNumber,
        title,
        url,
      });
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function decodeHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:div|h[1-6]|li|p|tr)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function hiddenText(value: unknown): string {
  if (typeof value === "string") return decodeHtml(value);
  if (Array.isArray(value))
    return value.map(hiddenText).filter(Boolean).join("\n");
  return "";
}

/** The same field kept as raw HTML for the native-markup compiler. */
function hiddenMarkup(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(hiddenMarkup).filter(Boolean).join("\n");
  return "";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function govUkAttachments(value: unknown): PublicLegalAttachment[] {
  const allowed = new Set(["www.gov.uk", "assets.publishing.service.gov.uk"]);
  return asArray(value).flatMap((raw) => {
    const attachment = asRecord(raw);
    const url = trustedUrl(attachment?.url, GOVUK_ORIGIN, allowed);
    if (!url) return [];
    return [
      {
        title: asString(attachment?.title),
        url,
        contentType: asString(
          attachment?.content_type ?? attachment?.contentType,
        ),
        filename: asString(attachment?.filename),
        pageCount: asNumber(
          attachment?.number_of_pages ?? attachment?.page_count,
        ),
      },
    ];
  });
}

async function fetchGovUkEtCase(
  result: GovUkEtSearchResult,
  signal?: AbortSignal,
): Promise<PublicLegalDocument> {
  const publicUrl = trustedUrl(
    result.url,
    GOVUK_ORIGIN,
    new Set(["www.gov.uk"]),
  );
  if (!publicUrl) throw new Error("Invalid GOV.UK case URL");
  const path = new URL(publicUrl).pathname;
  if (!path.startsWith("/employment-tribunal-decisions/")) {
    throw new Error("Invalid GOV.UK Employment Tribunal path");
  }
  const body = await responseJson(`${GOVUK_ORIGIN}/api/content${path}`, {
    signal,
  });
  const details = asRecord(body.details) ?? {};
  const title = asString(body.title) ?? result.title;
  const description = asString(body.description);
  const text = [
    title,
    description,
    hiddenText(details.hidden_indexable_content),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  // hidden_indexable_content is HTML whose <p>[N] ...</p> markup carries
  // the paragraph boundaries; tag-stripping it first forced the compiler
  // to re-guess them from flattened text (structural-richness survey
  // 2026-07-29, finding 4). Title/description ride along as escaped
  // paragraphs so the rendered document keeps its header.
  const hiddenHtml = hiddenMarkup(details.hidden_indexable_content);
  const structure = compileNativeMarkupSourceDoc({
    provider: "govuk-et",
    id: result.caseNumber,
    url: publicUrl,
    text,
    markup: hiddenHtml
      ? [title, description]
          .filter((value): value is string => Boolean(value))
          .map((value) => `<p>${escapeHtml(value)}</p>`)
          .join("") + hiddenHtml
      : null,
  });
  return {
    provider: "govuk-et",
    identity: result.caseNumber,
    title,
    url: publicUrl,
    structure,
    attachments: govUkAttachments(details.attachments),
  };
}

function govInfoDocket(verbatim: string) {
  const full = verbatim.match(FULL_DOCKET)?.[0];
  if (full) return full.toLowerCase();
  const appeal = verbatim.match(APPEAL_DOCKET)?.[1];
  return appeal && US_COURT.test(verbatim) ? appeal.toLowerCase() : "";
}

function govInfoApiKey() {
  return process.env.GOVINFO_API_KEY?.trim() || "DEMO_KEY";
}

async function searchGovInfoCase(
  verbatim: string,
  signal?: AbortSignal,
): Promise<GovInfoCaseSearchResult | null> {
  const docket = govInfoDocket(verbatim);
  if (!docket) return null;
  const body = await responseJson(
    `${GOVINFO_API}/search?api_key=${encodeURIComponent(govInfoApiKey())}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `collection:(USCOURTS) and casenumber:(${docket})`,
        pageSize: "10",
        offsetMark: "*",
        sorts: [{ field: "score", sortOrder: "DESC" }],
      }),
      signal,
    },
  );
  const expected = docket.replace(":", "_").toLowerCase();
  const matches = new Map<string, GovInfoCaseSearchResult>();
  for (const value of asArray(body.results)) {
    const result = asRecord(value);
    const packageId = asString(result?.packageId);
    const packageMatch = packageId?.match(GOVINFO_PACKAGE);
    if (
      asString(result?.collectionCode) !== "USCOURTS" ||
      !packageId ||
      packageMatch?.[1].toLowerCase() !== expected
    ) {
      continue;
    }
    matches.set(packageId, {
      provider: "govinfo",
      docket,
      packageId,
      title: asString(result?.title),
      url: `${GOVINFO_WEB}/app/details/${packageId}`,
    });
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function govInfoPdf(summary: JsonRecord): PublicLegalAttachment[] {
  const download = asRecord(summary.download) ?? {};
  const url = trustedUrl(
    download.pdfLink ?? summary.pdfLink,
    GOVINFO_API,
    new Set(["api.govinfo.gov", "www.govinfo.gov"]),
  );
  if (!url) return [];
  return [
    {
      title: asString(summary.title),
      url,
      contentType: "application/pdf",
      filename: asString(summary.pdfFileName ?? summary.filename),
      pageCount: asNumber(
        summary.pageCount ?? summary.numberOfPages ?? summary.pages,
      ),
    },
  ];
}

async function fetchGovInfoCase(
  result: GovInfoCaseSearchResult,
  signal?: AbortSignal,
): Promise<PublicLegalDocument> {
  if (!GOVINFO_PACKAGE.test(result.packageId)) {
    throw new Error("Invalid GovInfo package ID");
  }
  const body = await responseJson(
    `${GOVINFO_API}/packages/${encodeURIComponent(result.packageId)}/summary?api_key=${encodeURIComponent(govInfoApiKey())}`,
    { signal },
  );
  const title = asString(body.title) ?? result.title;
  const text = [
    title,
    asString(body.caseNumber) ?? result.docket,
    asString(body.courtName),
    asString(body.dateIssued),
    asString(body.docketText),
    asString(body.description),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const structure = compileNativeMarkupSourceDoc({
    provider: "govinfo",
    id: result.packageId,
    url: `${GOVINFO_WEB}/app/details/${result.packageId}`,
    text,
  });
  return {
    provider: "govinfo",
    identity: result.packageId,
    title,
    url: `${GOVINFO_WEB}/app/details/${result.packageId}`,
    structure,
    attachments: govInfoPdf(body),
  };
}

function lookupPublicLegalSource(
  document: PublicLegalDocument,
  kind: SourceDocLocatorKind,
  locator: string,
  contextBlocks = 0,
): PublicLegalLookup {
  const lookup = lookupLegalSourceDoc(
    document.structure,
    kind,
    locator,
    contextBlocks,
  );
  return {
    ...lookup,
    provider: document.provider,
    url: document.url,
    anchor: lookup.block?.anchor ?? null,
  };
}

type PublicProviderId = "tna" | "govuk-et" | "govinfo";

function publicReference(input: {
  provider: PublicProviderId;
  id: string;
  citation: string;
  title: string | null;
  url: string;
}) {
  return {
    provider: input.provider,
    family: "public",
    id: input.id,
    kind: "case",
    title: input.title,
    citation: input.citation,
    url: input.url,
  } satisfies LegalSourceReference;
}

async function resolveTnaReference(text: string, signal?: AbortSignal) {
  const result = await searchTnaCase(text, signal);
  if (!result) return null;
  return {
    source: publicReference({
        provider: "tna",
        id: result.citation,
        citation: result.citation,
        title: result.title,
        url: result.url,
    }),
    document: await fetchTnaCase(result, signal),
  };
}

async function resolveGovUkReference(text: string, signal?: AbortSignal) {
  const result = await searchGovUkEtCase(text, signal);
  if (!result) return null;
  return {
    source: publicReference({
        provider: "govuk-et",
        id: result.caseNumber,
        citation: result.caseNumber,
        title: result.title,
        url: result.url,
    }),
    document: await fetchGovUkEtCase(result, signal),
  };
}

async function resolveGovInfoReference(text: string, signal?: AbortSignal) {
  const result = await searchGovInfoCase(text, signal);
  if (!result) return null;
  return {
    source: publicReference({
        provider: "govinfo",
        id: result.packageId,
        citation: result.docket,
        title: result.title,
        url: result.url,
    }),
    document: await fetchGovInfoCase(result, signal),
  };
}

async function fetchPublicReference(
  source: LegalSourceReference,
  signal?: AbortSignal,
) {
  if (source.provider === "tna") {
    const result = await searchTnaCase(source.citation || source.id, signal);
    return result ? fetchTnaCase(result, signal) : null;
  }
  if (source.provider === "govuk-et") {
    const result = await searchGovUkEtCase(
      source.citation || source.id,
      signal,
    );
    return result ? fetchGovUkEtCase(result, signal) : null;
  }
  if (source.provider === "govinfo") {
    return fetchGovInfoCase(
      {
        provider: "govinfo",
        docket: source.citation || source.id,
        packageId: source.id,
        title: source.title ?? null,
        url: source.url ?? `${GOVINFO_WEB}/app/details/${source.id}`,
      },
      signal,
    );
  }
  return null;
}

function providerCanResolve(
  provider: PublicProviderId,
  request: LegalSourceResolveRequest,
) {
  if (request.kind !== "case") return false;
  if (provider === "tna") return Boolean(tnaCitation(request.text));
  if (provider === "govuk-et") return Boolean(etCaseNumber(request.text));
  return Boolean(govInfoDocket(request.text));
}

function createPublicLegalSourceProvider(
  provider: PublicProviderId,
  resolveReference: (
    text: string,
    signal?: AbortSignal,
  ) => Promise<{
    source: LegalSourceReference;
    document: PublicLegalDocument;
  } | null>,
): LegalSourceProvider<
  SourceDoc | string,
  {
    document: PublicLegalDocument;
    lookup?: PublicLegalLookup;
  }
> {
  const documents = new Map<string, PublicLegalDocument>();
  return {
    id: provider,
    canResolve: (request) => providerCanResolve(provider, request),
    async resolve(request) {
      const resolved = await resolveReference(request.text, request.signal);
      if (!resolved) return [];
      documents.set(resolved.source.id, resolved.document);
      if (documents.size > 16) documents.delete(documents.keys().next().value!);
      return [resolved.source];
    },
    async readPassage(request) {
      const document =
        documents.get(request.source.id) ??
        (await fetchPublicReference(request.source, request.signal));
      if (!document || document.provider !== provider) return [];
      const source = document.structure;
      const reference = {
        ...request.source,
        title: document.title,
        url: document.url,
      } satisfies LegalSourceReference;
      const revision = document.sourceSha256 ?? source.revision;
      if (!request.locator) {
        const passage: LegalSourcePassage<
          SourceDoc,
          { document: PublicLegalDocument; lookup?: PublicLegalLookup }
        > = {
          source: reference,
          locator: { requested: null, label: "document" },
          role: "document",
          text: source.text,
          textSha256: sha256(source.text),
          documentSha256: source.revision,
          revision,
          blockArtifact: source,
          documentArtifact: source,
          native: { document },
        };
        return [passage];
      }
      const lookup = lookupPublicLegalSource(
        document,
        request.locator.kind,
        request.locator.value,
        request.contextBlocks ?? 0,
      );
      if (lookup.status !== "found" || !lookup.block) return [];
      const range = request.locator.endValue
        ? readSourceDocRange(
            source,
            request.locator.kind,
            request.locator.value,
            request.locator.endValue,
            request.contextBlocks ?? 0,
          )
        : null;
      if (request.locator.endValue && !range) return [];
      const visible = range
        ? [
            ...range.before.map((block) => ({ block, role: "context" as const })),
            ...range.selected.map((block) => ({ block, role: "selected" as const })),
            ...range.after.map((block) => ({ block, role: "context" as const })),
          ]
        : [
            { block: lookup.block, role: "selected" as const },
            ...lookup.before.map((block) => ({ block, role: "context" as const })),
            ...lookup.after.map((block) => ({ block, role: "context" as const })),
          ];
      return visible.map(({ block, role }) => ({
        source: reference,
        locator: {
          requested: request.locator!,
          label: block.label,
          anchor: block.anchor ?? (role === "selected" ? lookup.anchor : null),
          pageScoped: block.kind === "page",
        },
        role,
        text: block.text,
        textSha256: sha256(block.text),
        documentSha256: source.revision,
        revision,
        blockArtifact: block.text,
        documentArtifact: source,
        native: {
          document,
          lookup: {
            ...lookup,
            requestedLabel: block.label,
            matches: [block.label],
            block,
            before: [],
            after: [],
            anchor: block.anchor ?? null,
          },
        },
      }));
    },
  };
}

const tnaLegalSourceProvider = createPublicLegalSourceProvider(
  "tna",
  resolveTnaReference,
);
const govUkEtLegalSourceProvider = createPublicLegalSourceProvider(
  "govuk-et",
  resolveGovUkReference,
);
const govInfoLegalSourceProvider = createPublicLegalSourceProvider(
  "govinfo",
  resolveGovInfoReference,
);
export const publicLegalSourceProviders = [
  tnaLegalSourceProvider,
  govUkEtLegalSourceProvider,
  govInfoLegalSourceProvider,
] as const;
