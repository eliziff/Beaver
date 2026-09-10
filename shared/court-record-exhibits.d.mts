export function extractExhibitMentions(text: string): Record<string, string[]>;
/** Punctuation- and case-insensitive identity of one exhibit statement. */
export function mentionKey(value: string): string;
export function sourceExhibitLabels(pages: string[]): string[];
