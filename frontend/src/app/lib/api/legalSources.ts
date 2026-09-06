import { apiRequest, pagePath, segment } from "@/app/lib/api/client";

export type LegalDocumentType = "cases" | "laws" | "articles";
export type LegalSearchDocumentType = LegalDocumentType | "hansard";
export interface LegalSourceSearchResult {
  provider: "a2aj" | "journal" | "hansard";
  doc_type: LegalSearchDocumentType;
  source_id?: string | null;
  language: "en" | "fr";
  dataset: string;
  citation: string;
  name: string | null;
  date: string | null;
  url: string | null;
  snippet: string | null;
}
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
}): Promise<LegalSourceSearchResult[]> => {
  return (
    await apiRequest<{ results: LegalSourceSearchResult[] }>(
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
    )
  ).results;
};
const legalSourceDocumentRequests = new Map<
  string,
  Promise<LegalSourceViewerPayload>
>();
export const clearLegalSourceRequests = () => legalSourceDocumentRequests.clear();
async function cachedLegalSourceDocument(path: string) {
  const cached = legalSourceDocumentRequests.get(path);
  if (cached) return cached;
  const request = apiRequest<LegalSourceViewerPayload>(path, {
    cache: "default",
  });
  legalSourceDocumentRequests.set(path, request);
  void request.finally(() => {
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
