export type WorkExtent = { key: string; lastPage?: number; paragraphs?: number };
export function workExtents(citations: ReadonlyArray<{ key?: string | null }>): WorkExtent[];
