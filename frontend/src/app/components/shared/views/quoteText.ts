// Letters and digits of any script: an accented letter is part of its word.
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

export const normalizeQuoteText = (text: string) =>
    text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

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

