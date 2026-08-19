import { courtlistenerLegalSourceProvider } from "../legalSources/courtlistener";
import { queueProviderPdfAttachment } from "../providerPdfLibraryBridge";
import { resourceReference } from "../resourceReferences";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const integer = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export async function courtlistenerPdfRendition(value: object, userId?: string) {
  const source = value as Row;
  const clusterId = integer(source.clusterId) ?? integer(source.id);
  const opinions = Array.isArray(source.opinions)
    ? source.opinions.filter((item): item is object => Boolean(row(item))) : [];
  const pdfUrl = text(source.pdfUrl) ?? text(source.pdf_url);
  const needsRendition = opinions.some((opinion) =>
    !courtlistenerLegalSourceProvider.hasNativeOpinionStructure(opinion));
  if (!clusterId || !userId || !pdfUrl || !needsRendition) return null;
  try {
    const queued = await queueProviderPdfAttachment({
      provider: "courtlistener",
      identity: String(clusterId),
      structureSource: "flat_text",
      url: pdfUrl,
      canonicalUrl: text(source.url),
      title: text(source.caseName) ?? text(source.case_name) ??
        (Array.isArray(source.citations) ? text(source.citations[0]) : null) ??
        `CourtListener ${clusterId}`,
    });
    return queued && {
      ...queued,
      resource: resourceReference.source("pdf", queued.reference_id),
    };
  } catch {
    return null;
  }
}
