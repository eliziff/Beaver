import { structureNative, type NativeDocument } from "./structureNative";

/** Where each quotation stands in a PDF the engine read: the page (from 1) its words are found on and their
 *  rectangles there, or none where its words are found on no page. */
export async function pdfQuotePlacements(document: NativeDocument, quotes: string[]) {
  const native = structureNative(), { pageCount } = native.pdfDocumentSummary(document);
  const [target] = (await native.pdfPassageGeometry(document, [{ id: "document", locatorKind: "page", locator: "1",
    physicalPages: Array.from({ length: pageCount }, (_, index) => index + 1), exactQuotes: quotes }])).targets;
  return quotes.map((_, index) => {
    const placed = target?.quotes[index];
    return placed?.status === "found" && placed.pageNumber
      ? { pageNumber: placed.pageNumber, rects: placed.rects } : null;
  });
}
