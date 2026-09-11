import { XMLParser } from "fast-xml-parser";
import { cachedContent } from "../contentCache";
import { guardedRemoteFetch } from "../remoteUrlSafety";
import { structureNative } from "../structureNative";
import {
  arrayValue,
  legalSourceUrl,
  objectValue,
  remoteCaseProvider,
  stringValue,
  type RemoteLegalSourceDocument,
} from "./remoteProvider";

const ORIGIN = "https://caselaw.nationalarchives.gov.uk";
const HOSTS = ["caselaw.nationalarchives.gov.uk"] as const;

type TnaSearchResult = {
  citation: string;
  title: string | null;
  url: string;
  xmlUrl: string;
};

const parser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: true,
});
const parseXml = (xml: string) => {
  if (/<!DOCTYPE(?:\s|>)/iu.test(xml)) throw new Error("TNA XML contains a forbidden DOCTYPE");
  return parser.parse(xml);
};

const citationFrom = (value: string) => structureNative().providerCitationsInText(value)
  .find(({ jurisdiction }) => jurisdiction === "uk");

const normalized = (value: string) =>
  value.replace(/\s+/gu, " ").trim().toLowerCase();

async function fetchXml(url: string, accept: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const value = await cachedContent({
    scope: "shared",
    kind: "legal-source-tna-xml",
    key: `${accept} ${url}`,
    version: 1,
    ttlMs: 7 * 24 * 60 * 60 * 1_000,
    produce: async () => {
      const response = await guardedRemoteFetch(
        url,
        { signal, headers: { Accept: accept } },
        {
          label: "TNA legal source request",
          allowedHosts: HOSTS,
          defaultPortOnly: true,
          allowIpLiterals: false,
          timeoutMs: 15_000,
          response: {
            label: "TNA legal source response",
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
      if (!response.ok) throw new Error(`TNA request failed (${response.status})`);
      return response.text();
    },
  });
  signal?.throwIfAborted();
  return value;
}

async function searchTnaCase(text: string, signal?: AbortSignal) {
  const match = citationFrom(text);
  if (!match?.court) return null;
  const citation = match.text.replace(/\s+/gu, " ").trim();
  const court = match.court.replace(/\s+/gu, "/").toLowerCase();
  const query = new URLSearchParams({
    query: `"${citation}"`,
    court,
    per_page: "50",
  });
  const root = objectValue(parseXml(await fetchXml(
    `${ORIGIN}/atom.xml?${query}`,
    "application/atom+xml, application/xml",
    signal,
  )));
  const feed = objectValue(root?.feed) ?? root;
  const matches = new Map<string, TnaSearchResult>();
  for (const value of arrayValue(feed?.entry)) {
    const entry = objectValue(value);
    const exact = arrayValue(entry?.identifier).some((raw) => {
      const identifier = objectValue(raw);
      return stringValue(identifier?.type)?.toLowerCase() === "ukncn" &&
        normalized(stringValue(identifier?.["#text"]) ?? "") === normalized(citation);
    });
    if (!entry || !exact) continue;
    let url: string | null = null;
    let xmlUrl: string | null = null;
    for (const raw of arrayValue(entry.link)) {
      const link = objectValue(raw);
      if (stringValue(link?.rel)?.toLowerCase() !== "alternate") continue;
      const type = stringValue(link?.type)?.toLowerCase();
      const href = legalSourceUrl(link?.href, ORIGIN, HOSTS);
      if (!href) continue;
      if (type === "text/html" || !type) url ??= href;
      if (["application/akn+xml", "application/xml", "text/xml"].includes(type ?? "")) {
        xmlUrl ??= href;
      }
    }
    if (url && xmlUrl) {
      matches.set(`${url}\n${xmlUrl}`, {
        citation,
        title: stringValue(entry.title),
        url,
        xmlUrl,
      });
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

async function fetchTnaCase(
  result: TnaSearchResult,
  signal?: AbortSignal,
): Promise<RemoteLegalSourceDocument> {
  const xmlUrl = legalSourceUrl(result.xmlUrl, ORIGIN, HOSTS);
  const url = legalSourceUrl(result.url, ORIGIN, HOSTS);
  if (!xmlUrl || !url) throw new Error("Invalid TNA case URL");
  const xml = await fetchXml(
    xmlUrl,
    "application/akn+xml, application/xml, text/xml",
    signal,
  );
  const native = await structureNative().deriveDocumentStructure({
    kind: "native_markup",
    input: {
      provider: "tna", id: result.citation, url, text: "", markup: xml,
      citation: result.citation,
    },
  });
  return {
    provider: "tna",
    identity: result.citation,
    title: result.title,
    url,
    native,
    attachments: [],
  };
}

/**
 * Judgment metadata, official PDF, and full text for one UK neutral citation.
 * Find Case Law publishes every judgment rendition under its neutral-citation
 * URI, so the PDF is addressed directly rather than discovered.
 */
export async function tnaCaseSource(citation: string, signal?: AbortSignal) {
  const result = await searchTnaCase(citation, signal);
  if (!result) return null;
  const document = await fetchTnaCase(result, signal);
  return { id: result.citation.toLowerCase(), citation: result.citation, date: null,
    url: document.url, title: document.title,
    pdfUrl: `${document.url.replace(/\/+$/u, "")}/data.pdf`,
    text: structureNative().documentText(document.native) };
}

export const tnaLegalSourceProvider = remoteCaseProvider({
  id: "tna",
  matches: citationFrom,
  search: searchTnaCase,
  fetch: fetchTnaCase,
  reference: (result: TnaSearchResult) => ({
    id: result.citation,
    part: result.xmlUrl,
    title: result.title,
    citation: result.citation,
    url: result.url,
  }),
  fromSource: (source) => source.url && source.part
    ? {
        citation: source.citation || source.id,
        title: source.title ?? null,
        url: source.url,
        xmlUrl: source.part,
      }
    : null,
});
