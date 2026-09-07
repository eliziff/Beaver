import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { normalizeQuoteText } from "./quoteText";

/** One cache per open PDF, reused across zoom/resize; never shared across documents. */
export function createPdfPageCache(pdf: PDFDocumentProxy) {
    const pending = new Map<number, Promise<PDFPageProxy>>();
    const resolved = new Map<number, PDFPageProxy>();
    const text = new Map<number, { promise: Promise<string>; bytes: number }>();
    const get = (number: number) => {
        let page = pending.get(number);
        if (!page) {
            page = pdf.getPage(number).then((value) => {
                resolved.set(number, value);
                return value;
            }, (error: unknown) => { pending.delete(number); throw error; });
            pending.set(number, page);
        }
        return page;
    };
    return {
        get,
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

/** Index at a document-space scroll offset, including the inter-page gap. */
export function pageAt(pages: readonly { top: number; height: number }[], offset: number) {
    let low = 0, high = pages.length - 1;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (pages[middle + 1].top <= offset) low = middle + 1;
        else high = middle;
    }
    return low;
}
