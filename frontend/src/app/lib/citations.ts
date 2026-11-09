import { isSpreadsheetFilename } from "@/app/lib/documentFilename";

export interface CitationQuote {
  color?: string;
  page?: number;
  quote: string;
}
import type { AssistantCitation } from "mike/shared/runtime/assistantWire.mjs";
export type Citation = AssistantCitation;
export type DocumentCitation = Extract<Citation, { kind: "document" }>;
type DocumentCitationQuote = DocumentCitation["quotes"][number];
function formatCellLocator(sheet?: string, cell?: string): string {
  if (sheet && cell) return `${sheet}!${cell}`;
  return cell ?? sheet ?? "";
}
/** A quote's page is the PDF's, from 1, only where it is a number: a page written as text ("iv", "12-13") is the
 *  printed label the author cited, shown but not navigated to. */
function expandDocumentQuoteEntry(entry: DocumentCitationQuote): CitationQuote[] {
  return [typeof entry.page === "number" ? { page: entry.page, quote: entry.quote } : { quote: entry.quote }];
}
export function getDocumentCitationQuotes(a: Citation): DocumentCitationQuote[] {
  return a.kind === "document"
    ? a.quotes.filter((entry) => entry.quote.trim().length > 0).map((entry) => ({ ...entry, sheet: entry.sheet ?? a.sheet, cell: entry.cell ?? a.cells }))
    : [];
}
export function expandCitationToEntries(
  a: Citation,
): CitationQuote[] {
  return getDocumentCitationQuotes(a).flatMap(expandDocumentQuoteEntry);
}
/** The cell locators a spreadsheet citation points at, or else its page numbers. */
function documentLocators(a: DocumentCitation) {
  const spreadsheet = isSpreadsheetFilename(a.filename);
  const values = getDocumentCitationQuotes(a).flatMap((q) => spreadsheet
    ? [formatCellLocator(q.sheet, q.cell)].filter(Boolean)
    : q.page == null ? [] : [String(q.page)]);
  return { spreadsheet, values: Array.from(new Set(values)) };
}
export function formatCitationPage(a: Citation): string {
  if (a.kind === "a2aj") return a.citation || a.name || "A2AJ source";
  if (a.kind === "public_legal") {
    return a.title || a.identifier || "Public legal source";
  }
  if (a.kind === "tabular") return `${a.col_name} · ${a.doc_name}`;
  const { spreadsheet, values } = documentLocators(a);
  if (spreadsheet) return values.join(", ");
  if (values.length > 1) return `Pages ${values.join(", ")}`;
  if (values.length === 1) return `Page ${values[0]}`;
  return "";
}
export function citationPinpoint(a: Citation): string {
  if (a.kind === "a2aj" || a.kind === "public_legal") {
    return a.pinpoint?.trim() ?? "";
  }
  if (a.kind === "tabular") return a.col_name;
  if (a.pinpoint?.trim()) return a.pinpoint.trim();
  const { spreadsheet, values } = documentLocators(a);
  if (spreadsheet) return values.join(", ");
  if (values.length === 1)
    return `p. ${values[0].replace(/\s*-\s*/gu, "–")}`;
  return values.length > 1 ? `pp. ${values.join(", ")}` : "";
}
export function displayCitationQuote(a: Citation): string {
  if (a.kind === "a2aj" || a.kind === "public_legal") {
    return a.quotes
      .map((q) => q.quote)
      .join(" / ");
  }
  return getDocumentCitationQuotes(a)
    .map((q) => q.quote)
    .filter(Boolean)
    .join(" / ");
}
