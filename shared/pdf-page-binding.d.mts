/** One PDF page of the engine's page map (`PdfDocument::page_map`). */
export type PdfPageBinding = {
  pdfPage: number;
  observed: string | null;
  label: string | null;
  source: "detected" | "embedded" | "reporter" | null;
  status: "resolved" | "unknown" | "ambiguous";
};
export function printedPageIndices(labels: readonly (string | null)[]): Map<string, number[]>;
export function resolvePrintedPages(label: string, bindings: readonly PdfPageBinding[]): number[];
