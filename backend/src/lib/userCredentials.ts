import { type ApiKeyProvider } from "mike/shared/runtime/clientContracts.mjs";
import type { UserApiKeys } from "./llm";

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources: Record<ApiKeyProvider, "user" | "env" | null>;
};

export type UserCredentials = {
  status(userId: string): Promise<ApiKeyStatus>;
  keys(userId: string): Promise<UserApiKeys>;
  save?(userId: string, provider: ApiKeyProvider, value: string | null): Promise<void>;
};
