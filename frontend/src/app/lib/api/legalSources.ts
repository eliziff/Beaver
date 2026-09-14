import { apiRequest, pagePath, segment } from "@/app/lib/api/client";

export type LegalDocumentType = "cases" | "laws" | "articles";
export type LegalSearchDocumentType = LegalDocumentType | "hansard";
export type { LegalSourceSearchHit as LegalSourceSearchResult } from "../../../../../backend/src/lib/legalSources";
import type { LegalSourceSearchHit as LegalSourceSearchResult } from "../../../../../backend/src/lib/legalSources";
export interface LegalSourceCoverage {
  dataset: string;
  description: string;
  docType: "cases" | "laws";
  jurisdictionCode: string;
  jurisdiction: string;
  sourceKind: "court" | "tribunal" | "legislation" | "regulation";
}
export interface LegalSourceViewerPayload {
  reference: {
    docType: LegalDocumentType;
    provider: string;
    id: string;
    kind: "case" | "legislation" | "journal" | "hansard";
    citation: string;
    language: "en" | "fr";
    dataset: string | null;
    sourceSha256: string;
  };
  metadata: {
    title: string;
    citation: string;
    alternateCitation: string | null;
    date: string | null;
    url: string | null;
    language: "en" | "fr";
    pdfUrl?: string | null;
  };
  slices: {
    start: number;
    end: number;
    text: string;
    depth: number;
    anchors: LegalSourceViewerAnchor[];
    primary: LegalSourceViewerAnchor | null;
  }[];
  truncated: boolean;
}
interface LegalSourceViewerAnchor {
  kind: "paragraph" | "page" | "section" | "footnote";
  label: string;
  start: number;
  end: number;
  parentLabel?: string;
}
export const getLegalSourceCoverage = async () =>
  (await apiRequest<{ coverage: LegalSourceCoverage[] }>("/sources/coverage")).coverage;
export const searchLegalSources = async (args: {
  query: string;
  docType: LegalSearchDocumentType;
  language?: "en" | "fr";
  datasets?: string[];
  author?: string;
  journal?: string;
  speaker?: string;
  startDate?: string;
  endDate?: string;
  sortResults?: "default" | "newest_first" | "oldest_first";
}) => apiRequest<{ results: LegalSourceSearchResult[]; status: "available" | "not_installed" }>(
      pagePath("/sources/search", {
        query: args.query,
        doc_type: args.docType,
        language: args.language ?? "en",
        dataset: args.datasets?.join(","),
        author: args.author,
        journal: args.journal,
        speaker: args.speaker,
        start_date: args.startDate,
        end_date: args.endDate,
        sort_results:
          args.sortResults === "default" ? undefined : args.sortResults,
      }),
    );
const legalSourceDocumentCache = new Map<string, LegalSourceViewerPayload>();
const legalSourceDocumentRequests = new Map<
  string,
  Promise<LegalSourceViewerPayload>
>();
/** Each payload is a whole document, so a small count is the bound; the reader keeps no more open. */
const LEGAL_SOURCE_CACHE_LIMIT = 6;
let legalSourceCacheGeneration = 0;
export const clearLegalSourceRequests = () => {
  legalSourceCacheGeneration += 1;
  legalSourceDocumentCache.clear();
  legalSourceDocumentRequests.clear();
};
async function cachedLegalSourceDocument(path: string) {
  const cached = legalSourceDocumentCache.get(path);
  if (cached) {
    legalSourceDocumentCache.delete(path);
    legalSourceDocumentCache.set(path, cached);
    return cached;
  }
  const pending = legalSourceDocumentRequests.get(path);
  if (pending) return pending;
  const request = apiRequest<LegalSourceViewerPayload>(path, {
    cache: "default",
  });
  legalSourceDocumentRequests.set(path, request);
  const generation = legalSourceCacheGeneration;
  void request.then((payload) => {
    // A response that landed after the account boundary must not repopulate the old cache.
    if (generation !== legalSourceCacheGeneration) return;
    legalSourceDocumentCache.set(path, payload);
    while (legalSourceDocumentCache.size > LEGAL_SOURCE_CACHE_LIMIT)
      legalSourceDocumentCache.delete(legalSourceDocumentCache.keys().next().value!);
  }).finally(() => {
    if (legalSourceDocumentRequests.get(path) === request)
      legalSourceDocumentRequests.delete(path);
  }).catch(() => undefined);
  return request;
}
export const getLegalSourceDocument = (referenceId: string) =>
  cachedLegalSourceDocument(`/sources/${segment(referenceId)}/document`);
export const getDirectLegalSourceDocument = (args: {
  provider: "a2aj" | "journal";
  citation: string;
  sourceId?: string | null;
  docType?: LegalDocumentType | "auto";
  language?: "en" | "fr";
  dataset?: string | null;
}) => {
  return cachedLegalSourceDocument(pagePath("/sources/document", {
    citation: args.citation,
    provider: args.provider,
    doc_type: args.docType ?? "auto",
    language: args.language ?? "en",
    dataset: args.dataset,
    source_id: args.sourceId,
  }));
}
