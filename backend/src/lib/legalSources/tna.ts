import { XMLParser } from "fast-xml-parser";
import { cachedContent } from "../contentCache";
import { sha256 } from "../hash";
import { guardedRemoteFetch } from "../remoteUrlSafety";
import { lookupLegalSourceDoc } from "../sourceDocNativeMarkup";
import {
  compileNativeMarkupSourceDoc,
  nativeMarkupCitedRefs,
} from "../sourceDocNativeMarkup";
import type { LegalSourceReference } from ".";
import { sourceDocPassages } from "./sourceDocPassages";
import {
  arrayValue,
  legalSourceUrl,
  objectValue,
  stringValue,
  type RemoteLegalSourceDocument,
  type RemoteLegalSourceProvider,
} from "./remoteProvider";

const ORIGIN = "https://caselaw.nationalarchives.gov.uk";
const HOSTS = ["caselaw.nationalarchives.gov.uk"] as const;
const CITATION =
  /\[(?:19|20)\d{2}\]\s+(?:UKSC|UKPC|EWCA\s+(?:Civ|Crim)|EWHC|EWCC|EWFC|EWCOP|EWCR|UKUT|UKFTT|EAT)\s+\d+(?:\s+\((?:Admin|Admlty|Ch|Comm|Fam|KB|QB|TCC|Pat|IPEC|SCCO|AAC|IAC|LC|GRC|TC|B)\))?/iu;

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

const citationFrom = (value: string) =>
  value.match(CITATION)?.[0].replace(/\s+/gu, " ").trim() ?? "";

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
  const citation = citationFrom(text);
  if (!citation) return null;
  const court = citation.match(
    /\]\s+(EWCA\s+(?:Civ|Crim)|UKSC|UKPC|EWHC|EWCC|EWFC|EWCOP|EWCR|UKUT|UKFTT|EAT)\b/iu,
  )?.[1].replace(/\s+/gu, "/").toLowerCase() ?? "";
  const query = new URLSearchParams({
    query: `"${citation}"`,
    court,
    per_page: "50",
  });
  const root = objectValue(parser.parse(await fetchXml(
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
  return {
    provider: "tna",
    identity: result.citation,
    title: result.title,
    url,
    structure: compileNativeMarkupSourceDoc({
      provider: "tna",
      id: result.citation,
      url,
      text: "",
      markup: xml,
      citation: result.citation,
    }),
    attachments: [],
    citedAuthorities: nativeMarkupCitedRefs(xml),
    sourceSha256: sha256(xml),
  };
}

const reference = (result: TnaSearchResult) => ({
  provider: "tna",
  id: result.citation,
  part: result.xmlUrl,
  kind: "case",
  title: result.title,
  citation: result.citation,
  url: result.url,
}) satisfies LegalSourceReference;

export const tnaLegalSourceProvider: RemoteLegalSourceProvider = {
  id: "tna",
  canResolve: ({ kind, text }) => kind === "case" && Boolean(citationFrom(text)),
  async resolve({ text, signal }) {
    const result = await searchTnaCase(text, signal);
    return result ? [reference(result)] : [];
  },
  async readPassage(request) {
    const { source, signal } = request;
    const result = source.url && source.part
      ? {
          citation: source.citation || source.id,
          title: source.title ?? null,
          url: source.url,
          xmlUrl: source.part,
        }
      : await searchTnaCase(source.citation || source.id, signal);
    if (!result) return [];
    const document = await fetchTnaCase(result, signal);
    return sourceDocPassages({
      request,
      reference: { ...source, ...reference(result), title: document.title },
      document: document.structure,
      revision: document.sourceSha256,
      native: { document },
      lookup: (kind, value, contextBlocks) =>
        lookupLegalSourceDoc(document.structure, kind, value, contextBlocks),
    });
  },
};
