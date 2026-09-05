export type WordEdit = {
  original: string;
  replacement?: string;
  formats?: string[];
  occurrence?: "all";
  reason?: string;
};
export const MAX_WORD_EDITS: number;
export const MAX_WORD_ANCHOR_CHARS: number;
export const WORD_FORMATS: string[];
export function parseWordEdits(value: unknown): WordEdit[] | null;
