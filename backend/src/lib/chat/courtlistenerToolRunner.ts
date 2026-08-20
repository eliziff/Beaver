import { courtlistenerLegalSourceProvider } from "../legalSources/courtlistener";
import { queueProviderPdfAttachment } from "../providerPdfLibraryBridge";
import { resourceReference } from "../resourceReferences";
import { jsonRecord as row, nonemptyString as text, positiveInteger as integer } from "../value";

export async function courtlistenerPdfRendition(value: object, userId?: string) {
  const source = value as Record<string, unknown>;
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
    }, userId);
    return queued && {
      ...queued,
      resource: resourceReference.source("pdf", queued.reference_id),
    };
  } catch {
    return null;
  }
}
