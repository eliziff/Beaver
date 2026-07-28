import crypto from "node:crypto";
import { access, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { legalProviderCache, mikeLocalDataHome } from "./legalDataPath";
import type {
  SourceDoc,
  SourceDocLocatorKind,
  SourceDocLookup,
} from "./sourceDoc";
import {
  compileNativeMarkupSourceDoc,
  lookupLegalSourceDoc,
} from "./sourceDocNativeMarkup";
import type { JournalArticleSearchResult } from "./journalArticles";
import { sha256 } from "./hash";

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
  text: string;
  structure: SourceDoc;
  attachments: PublicLegalAttachment[];
  sourceVersion?: {
    format: "tna-akn-xml";
    url: string;
    sha256: string;
    body: string;
  };
};

export type PublicLegalLookup = SourceDocLookup & {
  provider: PublicLegalDocument["provider"];
  url: string;
  anchor: string | null;
};

const EVIDENCE_SCHEMA = "mike.provider_legal_evidence.v1";
const EVIDENCE_HANDLE = /^mike-provider-evidence:v1:([0-9a-f]{64})$/u;

export type PublicLegalEvidenceReceipt = {
  schema_version: typeof EVIDENCE_SCHEMA;
  handle: string;
  source: {
    provider: "tna";
    identifier: string;
    title: string | null;
    canonical_url: string;
    source_url: string;
    source_sha256: string;
    format: "tna-akn-xml";
  };
  lookup: {
    locator_kind: SourceDocLocatorKind;
    locator: string;
    provider_locator: string;
    context_blocks: number;
  };
  evidence: {
    block_text_sha256: string;
    payload_sha256: string;
  };
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

function evidencePath(handle: string) {
  const digest = handle.match(EVIDENCE_HANDLE)?.[1];
  if (!digest) throw new Error("Invalid provider evidence handle");
  return path.join(
    mikeLocalDataHome(),
    "evidence",
    "provider-native",
    "v1",
    `${digest}.json`,
  );
}

function sourcePath(sourceSha256: string) {
  return path.join(
    legalProviderCache("tna"),
    "native",
    "blobs",
    "v1",
    `${sourceSha256}.xml`,
  );
}

async function atomicWriteOnce(filename: string, value: string) {
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    await access(filename);
    return;
  } catch {
    // Publish the complete content-addressed file below.
  }
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await access(filename);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function lookupPayload(lookup: PublicLegalLookup) {
  const block = (value: PublicLegalLookup["block"]) =>
    value
      ? {
          kind: value.kind,
          label: value.label,
          start: value.start,
          end: value.end,
          anchor: value.anchor ?? null,
          // Receipt payload field names and defaulting are frozen: their
          // JSON is sha256'd into persisted payload_sha256 values.
          locator_kind: value.kind,
          provider_locator: value.anchor ?? value.label,
          origin: value.origin,
          parent_label: value.parentLabel ?? null,
          text: value.text,
        }
      : null;
  return {
    requested_label: lookup.requestedLabel,
    matches: lookup.matches,
    block: block(lookup.block),
    before: lookup.before.map(block),
    after: lookup.after.map(block),
  };
}

function receiptValue(value: unknown): PublicLegalEvidenceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid provider evidence receipt");
  }
  const receipt = value as Partial<PublicLegalEvidenceReceipt>;
  const source = receipt.source;
  const lookup = receipt.lookup;
  const evidence = receipt.evidence;
  if (
    receipt.schema_version !== EVIDENCE_SCHEMA ||
    typeof receipt.handle !== "string" ||
    !EVIDENCE_HANDLE.test(receipt.handle) ||
    !source ||
    source.provider !== "tna" ||
    typeof source.identifier !== "string" ||
    !source.identifier ||
    (source.title !== null && typeof source.title !== "string") ||
    typeof source.canonical_url !== "string" ||
    typeof source.source_url !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.source_sha256 ?? "") ||
    source.format !== "tna-akn-xml" ||
    !lookup ||
    !["paragraph", "page", "section", "footnote"].includes(
      lookup.locator_kind,
    ) ||
    typeof lookup.locator !== "string" ||
    !lookup.locator ||
    typeof lookup.provider_locator !== "string" ||
    !lookup.provider_locator ||
    !Number.isInteger(lookup.context_blocks) ||
    lookup.context_blocks < 0 ||
    lookup.context_blocks > 2 ||
    !evidence ||
    !/^[a-f0-9]{64}$/u.test(evidence.block_text_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(evidence.payload_sha256 ?? "")
  ) {
    throw new Error("Invalid provider evidence receipt");
  }
  const canonicalUrl = trustedUrl(
    source.canonical_url,
    TNA_ORIGIN,
    new Set(["caselaw.nationalarchives.gov.uk"]),
  );
  const sourceUrl = trustedUrl(
    source.source_url,
    TNA_ORIGIN,
    new Set(["caselaw.nationalarchives.gov.uk"]),
  );
  if (
    canonicalUrl !== source.canonical_url ||
    sourceUrl !== source.source_url
  ) {
    throw new Error("Invalid provider evidence receipt");
  }
  const { handle: _handle, ...identity } =
    receipt as PublicLegalEvidenceReceipt;
  if (
    `mike-provider-evidence:v1:${sha256(JSON.stringify(identity))}` !==
    receipt.handle
  ) {
    throw new Error(
      "Provider evidence receipt handle does not match its content",
    );
  }
  return receipt as PublicLegalEvidenceReceipt;
}

export async function persistPublicLegalEvidence(
  document: PublicLegalDocument,
  lookup: PublicLegalLookup,
  contextBlocks = 0,
) {
  if (
    document.provider !== "tna" ||
    !document.sourceVersion ||
    lookup.status !== "found" ||
    !lookup.block
  ) {
    return null;
  }
  const sourceVersion = document.sourceVersion;
  if (
    sourceVersion.format !== "tna-akn-xml" ||
    sha256(sourceVersion.body) !== sourceVersion.sha256
  ) {
    throw new Error("Provider source version does not match its bytes");
  }
  const context = Math.min(Math.max(Math.trunc(contextBlocks), 0), 2);
  const identity = {
    schema_version: EVIDENCE_SCHEMA as typeof EVIDENCE_SCHEMA,
    source: {
      provider: "tna" as const,
      identifier: document.identity,
      title: document.title,
      canonical_url: document.url,
      source_url: sourceVersion.url,
      source_sha256: sourceVersion.sha256,
      format: sourceVersion.format,
    },
    lookup: {
      locator_kind: lookup.block.kind,
      locator: lookup.block.label,
      provider_locator: lookup.block.anchor ?? lookup.block.label,
      context_blocks: context,
    },
    evidence: {
      block_text_sha256: sha256(lookup.block.text),
      payload_sha256: sha256(JSON.stringify(lookupPayload(lookup))),
    },
  };
  const handle = `mike-provider-evidence:v1:${sha256(JSON.stringify(identity))}`;
  const receipt: PublicLegalEvidenceReceipt = { ...identity, handle };
  const blob = sourcePath(sourceVersion.sha256);
  await atomicWriteOnce(blob, sourceVersion.body);
  if (sha256(await readFile(blob, "utf8")) !== sourceVersion.sha256) {
    throw new Error("Provider source snapshot failed integrity verification");
  }
  const filename = evidencePath(handle);
  await atomicWriteOnce(filename, `${JSON.stringify(receipt, null, 2)}\n`);
  const stored = receiptValue(JSON.parse(await readFile(filename, "utf8")));
  if (stored.handle !== handle) {
    throw new Error("Conflicting provider evidence receipt");
  }
  return stored;
}

export async function readPublicLegalEvidenceReceipt(handle: string) {
  const receipt = receiptValue(
    JSON.parse(await readFile(evidencePath(handle), "utf8")),
  );
  if (receipt.handle !== handle) {
    throw new Error("Provider evidence receipt handle does not match its path");
  }
  return receipt;
}

export async function rehydratePublicLegalEvidence(handle: string) {
  const receipt = await readPublicLegalEvidenceReceipt(handle);
  const body = await readFile(sourcePath(receipt.source.source_sha256), "utf8");
  if (sha256(body) !== receipt.source.source_sha256) {
    throw new Error("Provider source snapshot failed integrity verification");
  }
  const structure = compileNativeMarkupSourceDoc({
    provider: "tna",
    id: receipt.source.identifier,
    url: receipt.source.canonical_url,
    text: "",
    markup: body,
    citation: receipt.source.identifier,
  });
  const document: PublicLegalDocument = {
    provider: "tna",
    identity: receipt.source.identifier,
    title: receipt.source.title,
    url: receipt.source.canonical_url,
    text: structure.text,
    structure,
    attachments: [],
    sourceVersion: {
      format: receipt.source.format,
      url: receipt.source.source_url,
      sha256: receipt.source.source_sha256,
      body,
    },
  };
  const lookup = lookupPublicLegalSource(
    document,
    receipt.lookup.locator_kind,
    receipt.lookup.locator,
    receipt.lookup.context_blocks,
  );
  if (lookup.status !== "found" || !lookup.block) {
    throw new Error(
      "Provider evidence locator is absent from its source snapshot",
    );
  }
  if (
    (lookup.block.anchor ?? lookup.block.label) !==
    receipt.lookup.provider_locator
  ) {
    throw new Error("Provider evidence locator changed in its source snapshot");
  }
  if (sha256(lookup.block.text) !== receipt.evidence.block_text_sha256) {
    throw new Error("Provider evidence text changed in its source snapshot");
  }
  if (
    sha256(JSON.stringify(lookupPayload(lookup))) !==
    receipt.evidence.payload_sha256
  ) {
    throw new Error("Provider evidence no longer matches its source snapshot");
  }
  return { document, lookup, receipt };
}

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
    text: structure.text,
    structure,
    attachments: [],
    sourceVersion: {
      format: "tna-akn-xml",
      url: xmlUrl,
      sha256: sourceSha256,
      body: xml,
    },
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
  const structure = compileNativeMarkupSourceDoc({
    provider: "govuk-et",
    id: result.caseNumber,
    url: publicUrl,
    text,
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
    text,
    structure,
    attachments: govInfoPdf(body),
  };
}

export function lookupPublicLegalSource(
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
