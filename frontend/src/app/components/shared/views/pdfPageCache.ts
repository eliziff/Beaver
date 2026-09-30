import type { PDFDocumentProxy } from "pdfjs-dist";
import { normalizeQuoteText } from "./quoteText";

/** One cache per open PDF, reused across zoom/resize; never shared across documents. */
export function createPdfPageCache(pdf: PDFDocumentProxy) {
    const text = new Map<number, { promise: Promise<string>; bytes: number }>();
    // PDF.js already caches page proxies and their in-flight loads.
    const get = (number: number) => pdf.getPage(number);
    return {
        get,
        get size() { return resolved.size; },
        peek: (number: number) => resolved.get(number),
        normalizedText(number: number) {
            const hit = text.get(number);
            if (hit) { text.delete(number); text.set(number, hit); return hit.promise; }
            const entry = { promise: Promise.resolve(""), bytes: 0 };
            entry.promise = get(number).then(page => page.getTextContent()).then(content => {
                const result = normalizeQuoteText(content.items.map(item => "str" in item ? item.str : "").join(""));
                entry.bytes = result.length * 2;
                let bytes = [...text.values()].reduce((sum, value) => sum + value.bytes, 0);
                // This is a quote-search working set, not an unbounded document-text cache.
                while (text.size > 64 || bytes > 4 * 1024 * 1024) {
                    const first = text.keys().next().value;
                    if (first === undefined) break;
                    bytes -= text.get(first)!.bytes; text.delete(first);
                }
                return result;
            }, (error: unknown) => { if (text.get(number) === entry) text.delete(number); throw error; });
            text.set(number, entry);
            return entry.promise;
        },
    };
}
