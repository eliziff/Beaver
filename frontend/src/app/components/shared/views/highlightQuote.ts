import type { CitationQuote } from "@/app/lib/citations";
import { clearDocxQuoteHighlights, highlightDocxQuotes } from "./highlightDocxQuote";
export { getPdfJs } from "@/app/lib/pdfJs";
// Resolve against the page, not its origin: a page opened from disk has the origin "null".
export const STANDARD_FONT_DATA_URL = new URL("/pdfjs-standard-fonts/", globalThis.location?.href ?? "http://localhost").href;
export const clearHighlights = clearDocxQuoteHighlights;

/** PDF text layers use the same multi-span matcher as the other readers. */
export function highlightQuote(root: HTMLElement, quotes: CitationQuote[]) {
    const matches = highlightDocxQuotes(root, quotes);
    root.querySelectorAll("[data-qspan]").forEach((span) => span.classList.add("pdf-text-highlight"));
    return matches.some(Boolean);
}
