import { structureNative } from "./structureNative";
export { printedPageIndices, resolvePrintedPages } from "mike/shared/pdf-page-binding.mjs";
export type { PdfPageBinding } from "mike/shared/pdf-page-binding.mjs";

/** The first pages of the reports `citations` cite, as the engine reads them (a page map's anchors). */
export function reporterStartPages(citations: readonly string[]) {
  return structureNative().reporterStartPages([...citations]);
}
