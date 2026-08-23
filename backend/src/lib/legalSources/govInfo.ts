import { lookupSourceDoc, type SourceDoc } from "../sourceDoc";
import { analyzeDocumentNative } from "../structureNative";
import type { LegalSourceReference } from ".";
import {
  arrayValue,
  cachedLegalSourceJson,
  legalSourceUrl,
  nonnegativeNumber,
  objectValue,
  stringValue,
  type JsonObject,
  type RemoteLegalSourceAttachment,
  type RemoteLegalSourceDocument,
  type RemoteLegalSourceProvider,
} from "./remoteProvider";
import { sourceDocPassages } from "./sourceDocPassages";

const API_ORIGIN = "https://api.govinfo.gov";
const WEB_ORIGIN = "https://www.govinfo.gov";
const FULL_DOCKET = /\b\d{1,2}:\d{2,4}-(?:cv|cr|bk|ap|md|mj|mc)-\d{1,8}\b/iu;
const APPEAL_DOCKET = /\b(?:case\s+)?no\.?\s*(\d{2}-\d{3,6})\b/iu;
const US_COURT =
  /\b(?:U\.?S\.?|United States|federal|Court of Appeals|\d{1,2}(?:st|nd|rd|th)\s+Cir\.?)\b/iu;
const PACKAGE_ID = /^USCOURTS-[A-Za-z0-9]+-([A-Za-z0-9_-]+)$/u;

type GovInfoSearchResult = {
  docket: string;
  packageId: string;
  title: string | null;
  url: string;
};

function docketFrom(value: string) {
  const full = value.match(FULL_DOCKET)?.[0];
  if (full) return full.toLowerCase();
  const appeal = value.match(APPEAL_DOCKET)?.[1];
  return appeal && US_COURT.test(value) ? appeal.toLowerCase() : "";
}

const apiKey = () => process.env.GOVINFO_API_KEY?.trim() || "DEMO_KEY";

async function searchGovInfoCase(text: string, signal?: AbortSignal) {
  const docket = docketFrom(text);
  if (!docket) return null;
  const body = await cachedLegalSourceJson(
    `${API_ORIGIN}/search?api_key=${encodeURIComponent(apiKey())}`,
    "api.govinfo.gov",
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
  const matches = new Map<string, GovInfoSearchResult>();
  for (const value of arrayValue(body.results)) {
    const result = objectValue(value);
    const packageId = stringValue(result?.packageId);
    const match = packageId?.match(PACKAGE_ID);
    if (
      stringValue(result?.collectionCode) !== "USCOURTS" || !packageId ||
      match?.[1].toLowerCase() !== expected
    ) continue;
    matches.set(packageId, {
      docket,
      packageId,
      title: stringValue(result?.title),
      url: `${WEB_ORIGIN}/app/details/${packageId}`,
    });
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function pdfAttachment(summary: JsonObject): RemoteLegalSourceAttachment[] {
  const download = objectValue(summary.download) ?? {};
  const url = legalSourceUrl(
    download.pdfLink ?? summary.pdfLink,
    API_ORIGIN,
    ["api.govinfo.gov", "www.govinfo.gov"],
  );
  return url ? [{
    title: stringValue(summary.title),
    url,
    contentType: "application/pdf",
    filename: stringValue(summary.pdfFileName ?? summary.filename),
    pageCount: nonnegativeNumber(
      summary.pageCount ?? summary.numberOfPages ?? summary.pages,
    ),
  }] : [];
}

async function fetchGovInfoCase(
  result: GovInfoSearchResult,
  signal?: AbortSignal,
): Promise<RemoteLegalSourceDocument> {
  if (!PACKAGE_ID.test(result.packageId)) {
    throw new Error("Invalid GovInfo package ID");
  }
  const body = await cachedLegalSourceJson(
    `${API_ORIGIN}/packages/${encodeURIComponent(result.packageId)}/summary?api_key=${encodeURIComponent(apiKey())}`,
    "api.govinfo.gov",
    { signal },
  );
  const title = stringValue(body.title) ?? result.title;
  const text = [
    title,
    stringValue(body.caseNumber) ?? result.docket,
    stringValue(body.courtName),
    stringValue(body.dateIssued),
    stringValue(body.docketText),
    stringValue(body.description),
  ].filter((value): value is string => Boolean(value)).join("\n");
  const url = `${WEB_ORIGIN}/app/details/${result.packageId}`;
  const analyzed = await analyzeDocumentNative<{
    structure: unknown; source_doc?: SourceDoc;
  }>({
    kind: "native_markup",
    source_doc: true,
    input: {
      provider: "govinfo",
      id: result.packageId,
      url,
      text,
      scope: { kind: "excerpt", excerptOf: result.packageId },
    },
  });
  if (!analyzed.source_doc) throw new Error("Rust omitted SourceDoc");
  return {
    provider: "govinfo",
    identity: result.packageId,
    title,
    url,
    analysis: { ...analyzed, source_doc: analyzed.source_doc },
    attachments: pdfAttachment(body),
  };
}

const reference = (result: GovInfoSearchResult) => ({
  provider: "govinfo",
  id: result.packageId,
  kind: "case",
  title: result.title,
  citation: result.docket,
  url: result.url,
}) satisfies LegalSourceReference;

export const govInfoLegalSourceProvider: RemoteLegalSourceProvider = {
  id: "govinfo",
  canResolve: ({ kind, text }) => kind === "case" && Boolean(docketFrom(text)),
  async resolve({ text, signal }) {
    const result = await searchGovInfoCase(text, signal);
    return result ? [reference(result)] : [];
  },
  async readPassage(request) {
    const { source, signal } = request;
    const result = {
      docket: source.citation || source.id,
      packageId: source.id,
      title: source.title ?? null,
      url: `${WEB_ORIGIN}/app/details/${source.id}`,
    };
    const document = await fetchGovInfoCase(result, signal);
    return sourceDocPassages({
      request,
      reference: { ...source, ...reference(result), title: document.title },
      document: document.analysis.source_doc,
      native: { document },
      lookup: (kind, value, contextBlocks) =>
        lookupSourceDoc(document.analysis.source_doc, kind, value, contextBlocks),
    });
  },
};
