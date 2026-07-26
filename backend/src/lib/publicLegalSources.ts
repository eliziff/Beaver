import { XMLParser } from "fast-xml-parser";
import type { A2AJLocatorKind } from "./a2ajStructure";
import {
  buildLegalSourceStructure,
  lookupLegalSourceStructure,
  type LegalSourceStructure,
  type LegalStructureLookup,
} from "./legalSourceStructure";

const TNA_ORIGIN = "https://caselaw.nationalarchives.gov.uk";
const GOVUK_ORIGIN = "https://www.gov.uk";
const GOVINFO_API = "https://api.govinfo.gov";
const GOVINFO_WEB = "https://www.govinfo.gov";
const TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

export type TnaCaseSearchResult = {
  provider: "tna";
  citation: string;
  title: string | null;
  url: string;
  xmlUrl: string;
};

export type GovUkEtSearchResult = {
  provider: "govuk-et";
  caseNumber: string;
  title: string;
  url: string;
};

export type GovInfoCaseSearchResult = {
  provider: "govinfo";
  docket: string;
  packageId: string;
  title: string | null;
  url: string;
};

export type PublicLegalSearchResult =
  | TnaCaseSearchResult
  | GovUkEtSearchResult
  | GovInfoCaseSearchResult;

export type PublicLegalAttachment = {
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
  text: string;
  structure: LegalSourceStructure;
  attachments: PublicLegalAttachment[];
};

export type PublicLegalLookup = LegalStructureLookup & {
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
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !hosts.has(url.hostname.toLowerCase())
    ) {
      return null;
    }
    url.hash = "";
    url.searchParams.delete("api_key");
    return url.toString();
  } catch {
    return null;
  }
}

async function responseText(url: string, accept: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: accept, ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Public legal source request failed (${response.status})`);
  }
  return response.text();
}

async function responseJson(
  url: string,
  init?: RequestInit,
): Promise<JsonRecord> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Public legal source request failed (${response.status})`);
  }
  return asRecord(await response.json()) ?? {};
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

export async function searchTnaCase(
  verbatim: string,
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

export async function fetchTnaCase(
  result: TnaCaseSearchResult,
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
  );
  const structure = buildLegalSourceStructure({
    provider: "tna",
    text: "",
    markup: xml,
    docType: "cases",
    citation: result.citation,
    name: result.title,
  });
  return {
    provider: "tna",
    identity: result.citation,
    title: result.title,
    url,
    text: structure.text,
    structure,
    attachments: [],
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

export async function searchGovUkEtCase(
  verbatim: string,
): Promise<GovUkEtSearchResult | null> {
  const caseNumber = etCaseNumber(verbatim);
  if (!caseNumber) return null;
  const query = new URLSearchParams({
    q: caseNumber,
    filter_format: "employment_tribunal_decision",
    count: "50",
  });
  const body = await responseJson(`${GOVUK_ORIGIN}/api/search.json?${query}`);
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

export async function fetchGovUkEtCase(
  result: GovUkEtSearchResult,
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
  const body = await responseJson(`${GOVUK_ORIGIN}/api/content${path}`);
  const details = asRecord(body.details) ?? {};
  const title = asString(body.title) ?? result.title;
  const text = [
    title,
    asString(body.description),
    hiddenText(details.hidden_indexable_content),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const structure = buildLegalSourceStructure({
    provider: "govuk-et",
    text,
    docType: "cases",
    name: title,
  });
  return {
    provider: "govuk-et",
    identity: result.caseNumber,
    title,
    url: publicUrl,
    text,
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

export async function searchGovInfoCase(
  verbatim: string,
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

export async function fetchGovInfoCase(
  result: GovInfoCaseSearchResult,
): Promise<PublicLegalDocument> {
  if (!GOVINFO_PACKAGE.test(result.packageId)) {
    throw new Error("Invalid GovInfo package ID");
  }
  const body = await responseJson(
    `${GOVINFO_API}/packages/${encodeURIComponent(result.packageId)}/summary?api_key=${encodeURIComponent(govInfoApiKey())}`,
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
  const structure = buildLegalSourceStructure({
    provider: "govinfo",
    text,
    docType: "cases",
    name: title,
  });
  return {
    provider: "govinfo",
    identity: result.packageId,
    title,
    url: `${GOVINFO_WEB}/app/details/${result.packageId}`,
    text,
    structure,
    attachments: govInfoPdf(body),
  };
}

export function lookupPublicLegalSource(
  document: PublicLegalDocument,
  kind: A2AJLocatorKind,
  locator: string,
  contextBlocks = 0,
): PublicLegalLookup {
  const lookup = lookupLegalSourceStructure(
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
