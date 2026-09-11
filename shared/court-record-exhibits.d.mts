export function extractExhibitMentions(text: string): Record<string, string[]>;
/** Punctuation- and case-insensitive identity of one exhibit statement. */
export function mentionKey(value: string): string;
export function sourceExhibitLabels(pages: string[]): string[];
/** Sequential exhibit label for a zero-based slot: A, B, ... Z, AA. */
export function exhibitName(index: number): string;
/** The first `count` sequential exhibit labels. */
export function exhibitNames(count: number): string[];
/** Zero-based slot of a plain-letter exhibit label, or -1. */
export function exhibitIndex(label?: string): number;
export const MAX_EXHIBIT_LABELS: 702;
