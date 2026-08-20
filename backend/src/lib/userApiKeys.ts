import type { UserApiKeys } from "./llm";
import { decryptSecret, encryptionSecret, encryptSecret } from "./secretEncryption";
import { createServerSupabase } from "./supabase";
import { safeErrorLog } from "./safeError";

type Db = ReturnType<typeof createServerSupabase>;
export const API_KEY_PROVIDERS = [
  "claude", "gemini", "openai", "deepseek", "openrouter", "meta", "courtlistener",
] as const;
export type ApiKeyProvider = typeof API_KEY_PROVIDERS[number];
type ApiKeySource = "user" | "env" | null;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources: Record<ApiKeyProvider, ApiKeySource>;
};
type EncryptedKeyRow = { provider: string; encrypted_key: string; iv: string; auth_tag: string };

const ENVIRONMENT_KEYS: Record<ApiKeyProvider, string> = {
  claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY", meta: "META_API_KEY",
  courtlistener: "COURTLISTENER_API_TOKEN",
};
const SALT = "beaver-user-api-keys-v1";

function environmentKey(provider: ApiKeyProvider) {
  return process.env[ENVIRONMENT_KEYS[provider]]?.trim() || null;
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
  return API_KEY_PROVIDERS.find((provider) => provider === value) ?? null;
}

export const hasEnvApiKey = (provider: ApiKeyProvider) => !!environmentKey(provider);

export function getEnvironmentApiKeys(): UserApiKeys {
  return Object.fromEntries(API_KEY_PROVIDERS.map((provider) => [
    provider, environmentKey(provider),
  ])) as UserApiKeys;
}

export function getEnvironmentApiKeyStatus(): ApiKeyStatus {
  const sources = {} as Record<ApiKeyProvider, ApiKeySource>;
  const status = { sources } as ApiKeyStatus;
  for (const provider of API_KEY_PROVIDERS) {
    const present = hasEnvApiKey(provider);
    status[provider] = present;
    sources[provider] = present ? "env" : null;
  }
  return status;
}

const secret = () => encryptionSecret("USER_API_KEYS_ENCRYPTION_SECRET");

export async function getUserApiKeyStatus(userId: string, db: Db = createServerSupabase()) {
  const status = getEnvironmentApiKeyStatus();
  const { data, error } = await db.from("user_api_keys").select("provider").eq("user_id", userId);
  if (error) throw error;
  for (const row of data ?? []) {
    const provider = normalizeApiKeyProvider(String(row.provider));
    if (provider && !status[provider]) {
      status[provider] = true;
      status.sources[provider] = "user";
    }
  }
  return status;
}

export async function getUserApiKeys(userId: string, db: Db = createServerSupabase()) {
  const keys = getEnvironmentApiKeys();
  const { data, error } = await db.from("user_api_keys")
    .select("provider, encrypted_key, iv, auth_tag").eq("user_id", userId);
  if (error) throw error;
  for (const row of (data ?? []) as EncryptedKeyRow[]) {
    const provider = normalizeApiKeyProvider(row.provider);
    if (!provider || keys[provider]) continue;
    try { keys[provider] = decryptSecret(
      { encrypted: row.encrypted_key, iv: row.iv, tag: row.auth_tag }, secret(), SALT,
      `${userId}\0${provider}`,
    ); }
    catch (error) {
      console.error("[user-api-keys] stored key is unreadable", {
        provider, ...safeErrorLog(error),
      });
    }
  }
  return keys;
}

export async function saveUserApiKey(
  userId: string, provider: ApiKeyProvider, value: string | null,
  db: Db = createServerSupabase(),
) {
  const normalized = value?.trim() || null;
  if (!normalized) {
    const { error } = await db.from("user_api_keys").delete()
      .eq("user_id", userId).eq("provider", provider);
    if (error) throw error;
    return;
  }
  const encrypted = encryptSecret(normalized, secret(), SALT, `${userId}\0${provider}`);
  const { error } = await db.from("user_api_keys").upsert({
    user_id: userId, provider, encrypted_key: encrypted.encrypted,
    iv: encrypted.iv, auth_tag: encrypted.tag, updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,provider" });
  if (error) throw error;
}
