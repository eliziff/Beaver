import type { LegalSourceReference } from "./legalSourceReference.mjs";

export const WORKFLOW_AUDIENCES = ["general", "solicitor", "litigator"] as const;
export type WorkflowAudience = typeof WORKFLOW_AUDIENCES[number];
export const API_KEY_PROVIDERS = [
  "claude", "gemini", "openai", "deepseek", "openrouter", "opencode-go", "meta",
  "courtlistener",
] as const;

export type ApiKeyProvider = typeof API_KEY_PROVIDERS[number];
export const MODEL_PROVIDERS = ["claude", "claude-p", "gemini", "openai", "deepseek", "openrouter",
  "opencode-go", "meta", "codex", "configured", "ollama"] as const;
export type ModelProvider = typeof MODEL_PROVIDERS[number];
const MODEL_SHAPES: [RegExp, ModelProvider][] = [[/^opencode-go\//u, "opencode-go"], [/^claude/u, "claude"],
  [/^gemini/u, "gemini"], [/^gpt-/u, "openai"], [/^deepseek-/u, "deepseek"],
  // OpenRouter slugs are namespaced; Meta's Model API takes the bare id.
  [/\//u, "openrouter"], [/^muse-spark-/u, "meta"]];
/** A selected model is `provider:native`; an id without a provider is read by its shape. */
export function modelProvider(model: string): ModelProvider | null {
  const explicit = /^([a-z-]+):/u.exec(model)?.[1];
  if (explicit && (MODEL_PROVIDERS as readonly string[]).includes(explicit)) return explicit as ModelProvider;
  return MODEL_SHAPES.find(([shape]) => shape.test(model))?.[1] ?? null;
}
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
