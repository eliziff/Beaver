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
