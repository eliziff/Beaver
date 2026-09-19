import type { UserApiKeys } from "./llm";
import { decryptSecret, encryptionSecret, encryptSecret } from "./secretEncryption";
import { sql, type RelationalDatabase } from "./relational";
import type { UserCredentials } from "./userCredentials";
import { safeErrorLog } from "./safeError";
import {
  API_KEY_PROVIDERS,
  type ApiKeyProvider,
  type ApiKeyStatus,
} from "./userCredentials";

type EncryptedKeyRow = { provider: string; encrypted_key: string; iv: string; auth_tag: string };

const ENVIRONMENT_KEYS: Record<ApiKeyProvider, string> = {
  claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY", meta: "META_API_KEY",
  "opencode-go": "OPENCODE_GO_API_KEY",
  courtlistener: "COURTLISTENER_API_TOKEN",
};
const SALT = "beaver-user-api-keys-v1";

function environmentKey(provider: ApiKeyProvider) {
  return process.env[ENVIRONMENT_KEYS[provider]]?.trim() || null;
}

export const hasEnvApiKey = (provider: ApiKeyProvider) => !!environmentKey(provider);

export function getEnvironmentApiKeys(): UserApiKeys {
  return Object.fromEntries(API_KEY_PROVIDERS.map((provider) => [
    provider, environmentKey(provider),
  ])) as UserApiKeys;
}

export function getEnvironmentApiKeyStatus(): ApiKeyStatus {
  const sources = {} as ApiKeyStatus["sources"];
  const status = { sources } as ApiKeyStatus;
  for (const provider of API_KEY_PROVIDERS) {
    const present = hasEnvApiKey(provider);
    status[provider] = present;
    sources[provider] = present ? "env" : null;
  }
  return status;
}

const secret = () => encryptionSecret("USER_API_KEYS_ENCRYPTION_SECRET");

export function createUserCredentials(db: RelationalDatabase): UserCredentials {
  return {
    async status(userId) {
      const status = getEnvironmentApiKeyStatus();
      const { rows } = await db.query(sql`SELECT provider FROM user_api_keys WHERE user_id=${userId}`);
      for (const row of rows) {
        const provider = API_KEY_PROVIDERS.find((value) => value === String(row.provider));
        if (provider) {
          status[provider] = true;
          status.sources[provider] = "user";
        }
      }
      return status;
    },

    async keys(userId) {
      const keys = getEnvironmentApiKeys();
      const { rows } = await db.query<EncryptedKeyRow>(sql`
        SELECT provider, encrypted_key, iv, auth_tag FROM user_api_keys WHERE user_id=${userId}`);
      for (const row of rows) {
        const provider = API_KEY_PROVIDERS.find((value) => value === row.provider);
        if (!provider) continue;
        try { keys[provider] = decryptSecret(
          { encrypted: row.encrypted_key, iv: row.iv, tag: row.auth_tag }, secret(), SALT,
          `${userId}\0${provider}`,
        ); }
        catch (error) {
          console.error("[user-api-keys] stored key is unreadable", {
            provider, ...safeErrorLog(error),
          });
          throw new Error(`Your ${provider} key could not be read. Save it again or remove it in settings.`);
        }
      }
      return keys;
    },

    async save(userId, provider, value) {
      const normalized = value?.trim() || null;
      if (!normalized) {
        await db.query(sql`DELETE FROM user_api_keys WHERE user_id=${userId} AND provider=${provider}`);
        return;
      }
      const encrypted = encryptSecret(normalized, secret(), SALT, `${userId}\0${provider}`);
      await db.query(sql`INSERT INTO user_api_keys(user_id,provider,encrypted_key,iv,auth_tag,updated_at)
        VALUES(${userId},${provider},${encrypted.encrypted},${encrypted.iv},${encrypted.tag},${new Date().toISOString()})
        ON CONFLICT(user_id,provider) DO UPDATE SET encrypted_key=excluded.encrypted_key,
          iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=excluded.updated_at`);
    },
  };
}
