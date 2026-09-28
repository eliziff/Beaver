export type PdfPageBinding = {
  pdfPage: number;
  observed: string | null;
  label: string | null;
  source: "detected" | "embedded" | "reporter" | null;
  status: "resolved" | "unknown" | "ambiguous";
};
export type PdfMarginPage = { pageNumber: number; width: number; height: number;
  lines: readonly { text?: string; rect: readonly number[]; words: readonly { text: string }[] }[] };
export function resolvePdfPagination(observed: readonly (string | null)[],
  embedded: readonly (string | null)[], reporterStarts?: readonly number[]): PdfPageBinding[];
export function reporterMarginLabels(labels: readonly (string | null)[], starts: readonly number[],
  pages: readonly PdfMarginPage[], isCitation: (text: string, page: string) => boolean): (string | null)[];
export function printedPageIndices(labels: readonly (string | null)[]): Map<string, number[]>;
export function resolvePrintedPages(label: string, bindings: readonly PdfPageBinding[]): number[];
