export function searchHighlightRanges(text: string, query: string): [number, number][] {
    const term = query.trim();
    if (!term) return [];
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}
