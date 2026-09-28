import type { ExtractResponse } from "legal-citations";
import { structureNative } from "./structureNative";
import { reporterMarginLabels as sharedReporterMarginLabels,
  type PdfMarginPage } from "mike/shared/pdf-page-binding.mjs";
export { resolvePdfPagination, printedPageIndices, resolvePrintedPages } from
  "mike/shared/pdf-page-binding.mjs";
export type { PdfPageBinding } from "mike/shared/pdf-page-binding.mjs";

function reporterPages(text: string) {
  const result = structureNative().citationEngineCall("extract", JSON.stringify({
    text, offsetUnit: "utf16", options: { resolve: false },
  })) as ExtractResponse;
  return result.citations.filter(item => item.form === "full" && item.authority === "case" &&
    item.format === "reporter").flatMap(item => item.fields.page ?? []);
}

export function reporterStartPages(citations: readonly string[]) {
  return [...new Set(citations.flatMap(reporterPages).filter(page => /^\d+$/u.test(page))
    .map(Number).filter(page => Number.isSafeInteger(page) && page > 0))];
}

export function reporterMarginLabels(labels: readonly (string | null)[], starts: readonly number[],
  pages: readonly PdfMarginPage[]) {
  return sharedReporterMarginLabels(labels, starts, pages, (value, candidate) =>
    reporterPages(value).includes(candidate));
}
