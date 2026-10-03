import type { LegalSourceReference } from "./legalSourceReference.mjs";

export const WORKFLOW_AUDIENCES = ["general", "solicitor", "litigator"] as const;
export type WorkflowAudience = typeof WORKFLOW_AUDIENCES[number];
export const API_KEY_PROVIDERS = [
  "claude", "gemini", "openai", "deepseek", "openrouter", "opencode-go", "meta",
  "courtlistener",
] as const;

export type ApiKeyProvider = typeof API_KEY_PROVIDERS[number];
export type LegalSourceSearchHit = LegalSourceReference & {
  snippet?: string | null;
  authors?: string | null;
  speaker?: string | null;
  passageStart?: number;
  passageEnd?: number;
  authority?: {
    citingCases: number;
    citingParagraphs: number;
    occurrences: number;
  };
};
