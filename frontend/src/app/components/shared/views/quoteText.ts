const ALPHANUMERIC = /[a-zA-Z0-9]/;

export const normalizeQuoteText = (text: string) =>
    text.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

export function strippedToOriginal(text: string, position: number) {
    let count = 0;
    for (let index = 0; index < text.length; index++) {
        if (ALPHANUMERIC.test(text[index]) && count++ === position) return index;
    }
    return text.length;
}

/** Keep quote-search eligibility identical to the existing DOM highlighter. */
export const quoteSegments = (quote: string) => quote.split(/\.{3}|\u2026/u)
    .map(normalizeQuoteText).filter(Boolean);

export const matchesQuoteText = (normalized: string, quote: string) =>
    quoteSegments(quote).some(segment => normalized.includes(segment.slice(0, 30)));
