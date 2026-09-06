import { normalizeQuoteText, quoteSegments, strippedToOriginal } from "./quoteText";
export { getPdfJs } from "@/app/lib/pdfJs";

export const STANDARD_FONT_DATA_URL = new URL(
    "/pdfjs-standard-fonts/",
    globalThis.location?.origin ?? "http://localhost",
).href;

const HIGHLIGHT_CLASS = "pdf-text-highlight";
const ORIGINAL_TEXT_ATTR = "data-original-text";

export function clearHighlights(textDivs: HTMLElement[]) {
    for (const div of textDivs) {
        if (!div.hasAttribute(ORIGINAL_TEXT_ATTR)) continue;
        div.textContent = div.getAttribute(ORIGINAL_TEXT_ATTR)!;
        div.removeAttribute(ORIGINAL_TEXT_ATTR);
    }
}

export function highlightQuote(textDivs: HTMLElement[], quote: string) {
    clearHighlights(textDivs);
    const segments = quoteSegments(quote);
    const original: string[] = [];
    const normalized: string[] = [];
    const starts: number[] = [];
    let fullText = "";
    for (const div of textDivs) {
        const text = div.textContent ?? "";
        original.push(text);
        normalized.push(normalizeQuoteText(text));
        starts.push(fullText.length);
        fullText += normalized.at(-1);
    }
    const ranges = new Map<number, [number, number]>();
    for (const segment of segments) {
        const match = fullText.indexOf(segment.slice(0, 30));
        if (match < 0) continue;
        const end = match + segment.length;
        for (let index = 0; index < textDivs.length; index += 1) {
            const start = starts[index];
            const divEnd = start + normalized[index].length;
            if (match >= divEnd || end <= start) continue;
            ranges.set(index, [
                Math.max(0, match - start),
                Math.min(normalized[index].length, end - start),
            ]);
        }
    }
    if (!ranges.size) return false;
    for (const [index, [start, end]] of ranges) {
        const div = textDivs[index];
        const text = original[index];
        const originalStart = strippedToOriginal(text, start);
        const originalEnd = strippedToOriginal(text, end);
        div.setAttribute(ORIGINAL_TEXT_ATTR, text);
        const highlight = document.createElement("span");
        highlight.className = HIGHLIGHT_CLASS;
        highlight.textContent = text.slice(originalStart, originalEnd);
        div.replaceChildren(text.slice(0, originalStart), highlight, text.slice(originalEnd));
    }
    return true;
}
