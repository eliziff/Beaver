import type { UserApiKeys } from "./llm";

export const API_KEY_PROVIDERS = [
  "claude", "gemini", "openai", "deepseek", "openrouter", "opencode-go", "meta",
  "courtlistener",
] as const;

export type ApiKeyProvider = typeof API_KEY_PROVIDERS[number];
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources: Record<ApiKeyProvider, "user" | "env" | null>;
};

export type UserCredentials = {
  status(userId: string): Promise<ApiKeyStatus>;
  keys(userId: string): Promise<UserApiKeys>;
  environmentConfigured(provider: ApiKeyProvider): boolean;
  save?(userId: string, provider: ApiKeyProvider, value: string | null): Promise<void>;
};
