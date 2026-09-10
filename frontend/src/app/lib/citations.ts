import { isSpreadsheetFilename } from "@/app/lib/documentFilename";

export interface CitationQuote {
  color?: string;
  page?: number;
  quote: string;
}
import type { AssistantCitation } from "../../../../backend/src/lib/chat/assistantWire";
export type Citation = AssistantCitation;
export type DocumentCitation = Extract<Citation, { kind: "document" }>;
type DocumentCitationQuote = DocumentCitation["quotes"][number];
const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";
function formatCellLocator(sheet?: string, cell?: string): string {
  if (sheet && cell) return `${sheet}!${cell}`;
  return cell ?? sheet ?? "";
}
function expandDocumentQuoteEntry(entry: DocumentCitationQuote): CitationQuote[] {
  const rangeMatch =
    typeof entry.page === "string"
      ? entry.page.match(/^(\d+)\s*-\s*(\d+)$/)
      : null;
  if (rangeMatch && entry.quote.includes(PAGE_BREAK_SENTINEL)) {
    const startPage = parseInt(rangeMatch[1], 10);
    const endPage = parseInt(rangeMatch[2], 10);
    const [before, after] = entry.quote.split(PAGE_BREAK_SENTINEL);
    return [
      { page: startPage, quote: before.trim() },
      { page: endPage, quote: after.trim() },
    ].filter((e) => e.quote.length > 0);
  }
  const pageNum =
    typeof entry.page === "number"
      ? entry.page
      : parseInt(String(entry.page), 10);
  return Number.isFinite(pageNum)
    ? [{ page: pageNum, quote: entry.quote }]
    : [{ quote: entry.quote }];
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
export function formatCitationPage(a: Citation): string {
  if (a.kind === "a2aj") return a.citation || a.name || "A2AJ source";
  if (a.kind === "public_legal") {
    return a.title || a.identifier || "Public legal source";
  }
  if (a.kind === "tabular") return `${a.col_name} · ${a.doc_name}`;
  const quotes = getDocumentCitationQuotes(a);
  if (isSpreadsheetFilename(a.filename)) {
    const cells = Array.from(
      new Set(
        quotes.map((q) => formatCellLocator(q.sheet, q.cell)).filter(Boolean),
      ),
    );
    return cells.join(", ");
  }
  const pages = Array.from(
    new Set(quotes.flatMap((q) => q.page == null ? [] : [String(q.page)])),
  );
  if (pages.length > 1) return `Pages ${pages.join(", ")}`;
  if (pages.length === 1) return `Page ${pages[0]}`;
  return "";
}
export function citationPinpoint(a: Citation): string {
  if (a.kind === "a2aj" || a.kind === "public_legal") {
    return a.pinpoint?.trim() ?? "";
  }
  if (a.kind === "tabular") return a.col_name;
  if (a.pinpoint?.trim()) return a.pinpoint.trim();
  const quotes = getDocumentCitationQuotes(a);
  if (isSpreadsheetFilename(a.filename)) {
    return Array.from(
      new Set(
        quotes.map((q) => formatCellLocator(q.sheet, q.cell)).filter(Boolean),
      ),
    ).join(", ");
  }
  const pages = Array.from(
    new Set(
      quotes.flatMap((q) =>
        q.page === undefined || q.page === null ? [] : [String(q.page)],
      ),
    ),
  );
  if (pages.length === 1)
    return `p. ${pages[0].replace(/\s*-\s*/gu, "\u2013")}`;
  return pages.length > 1 ? `pp. ${pages.join(", ")}` : "";
}
function cleanCitationQuoteText(rawQuote: string): string {
  return rawQuote.replaceAll(PAGE_BREAK_SENTINEL, "...");
}
export function displayCitationQuote(a: Citation): string {
  if (a.kind === "a2aj" || a.kind === "public_legal") {
    return a.quotes
      .map((q) => cleanCitationQuoteText(q.quote))
      .join(" / ");
  }
  return getDocumentCitationQuotes(a)
    .map((q) => cleanCitationQuoteText(q.quote))
    .filter(Boolean)
    .join(" / ");
}
