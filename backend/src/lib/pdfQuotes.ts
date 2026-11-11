import { structureNative, type NativeDocument } from "./structureNative";

/** The page (from 1) each quotation's words are found on in a PDF the engine read, or none where they are found on no
 *  page. */
export async function pdfQuotePages(document: NativeDocument, quotes: string[]) {
  const native = structureNative(), { pageCount } = native.pdfDocumentSummary(document);
  const [target] = (await native.pdfPassageGeometry(document, [{ id: "document", locatorKind: "page", locator: "1",
    physicalPages: Array.from({ length: pageCount }, (_, index) => index + 1), exactQuotes: quotes }])).targets;
  return quotes.map((_, index) => target?.quotes[index]?.status === "found" ? target.quotes[index].pageNumber ?? null : null);
}