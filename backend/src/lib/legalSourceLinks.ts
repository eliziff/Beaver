import { type A2AJCompiledDocument, type A2AJLocatorKind } from "./legalSources/a2aj";
import { structureNative, type NativeDocument } from "./structureNative";
import type { VerifiedPdfEvidence } from "./legalSourcePresentation";

/**
 * Deterministic pinpoint URLs: a provider anchor where one exists, plus text
 * fragments verified to select exactly one place in the document.
 *
 * Everything here queries the canonical native document.
 */

export type LegalSourceEvidence = {
  url: string;
  verifiedPdf?: VerifiedPdfEvidence | null;
  anchor?: string;
  /** The passage the quote must appear in. */
  blockText: string;
  /**
   * The corpus the fragment must be unique in. Required: without it a
   * directive can only be spelled blind, and Chrome then paints the first
   * matching text anywhere in the document rather than the cited passage.
   */
  documentText: NativeDocument;
  pageScoped?: boolean;
};

/** The link a passage of an A2AJ document is routed to, from the engine: on the publisher's page A2AJ names where it
 *  prints an anchor for the pinpoint, else on the document's CanLII page, else on A2AJ Law Web. */
export function a2ajDocumentLink(
  source: A2AJCompiledDocument, locator: { kind: A2AJLocatorKind; label: string } | null,
  blockText: string, quotes: string[],
) {
  return structureNative().sourceLink(source.searchNative, {
    ...source.url && { url: source.url }, citation: source.citation, docType: source.docType ?? "cases",
    locator, blockText, quotes,
    verifiedPdf: source.verifiedPdf ? { url: source.verifiedPdf.url, pdfOnly: source.verifiedPdf.pdfOnly } : null,
  });
}

/** The passage's link at its page: the page at the passage's anchor with its block's or quotations' fragments
 *  (a verified PDF where only that plans whole), from the engine. */
export function buildLegalSourcePinpoint(
  evidence: LegalSourceEvidence,
  quotes: string[],
  preferIndependentHtmlBlocks = false,
) {
  return structureNative().passageLink(evidence.documentText, {
    url: evidence.url, ...evidence.anchor !== undefined && { anchor: evidence.anchor },
    blockText: evidence.blockText, quotes, preferIndependentHtmlBlocks,
    verifiedPdf: evidence.verifiedPdf ? { url: evidence.verifiedPdf.url, pdfOnly: evidence.verifiedPdf.pdfOnly } : null,
  });
}

/** Add complete source-anchored text fragments beside the existing paragraph or provision anchor. A provision link
 *  paints the part of the provision its citation pinpoints ("sec16(3)", "sec445(1)(a)") where the document has it,
 *  else the provision's opening block. Each plan runs off the JavaScript thread, so a workbook plans its links at once. */
export async function citedPassageLink(rawUrl: string, document: NativeDocument | null | undefined,
  pinpoints: readonly string[] = []) {
  const url = structureNative().sourceUrl(rawUrl);
  if (!url || !document) return url;
  return await structureNative().offThread("citedPassageLink", document, url, [...pinpoints]) ?? url;
}

