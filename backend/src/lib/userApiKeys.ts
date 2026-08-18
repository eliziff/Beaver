import { createServerSupabase } from "./supabase";
import type { UserApiKeys } from "./llm";
import { decryptSecret, encryptSecret } from "./secretEncryption";

type Db = ReturnType<typeof createServerSupabase>;
export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "deepseek"
    | "openrouter"
    | "meta"
    | "courtlistener";
type ApiKeySource = "user" | "env" | null;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources: Record<ApiKeyProvider, ApiKeySource>;
};

type EncryptedKeyRow = {
    provider: ApiKeyProvider;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
};

const PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "deepseek",
    "openrouter",
    "meta",
    "courtlistener",
];

function envApiKey(provider: ApiKeyProvider): string | null {
    switch (provider) {
        case "claude":
            return (
                process.env.ANTHROPIC_API_KEY?.trim() ||
                process.env.CLAUDE_API_KEY?.trim() ||
                null
            );
        case "gemini":
            return process.env.GEMINI_API_KEY?.trim() || null;
        case "openai":
            return process.env.OPENAI_API_KEY?.trim() || null;
        case "deepseek":
            return (
                process.env.DEEPSEEK_API_KEY?.trim() ||
                process.env.DEEPSEEK_OCR_KEY?.trim() ||
                null
            );
        case "openrouter":
            return process.env.OPENROUTER_API_KEY?.trim() || null;
        case "meta":
            return (
                process.env.META_API_KEY?.trim() ||
                process.env.MODEL_API_KEY?.trim() ||
                null
            );
        case "courtlistener":
            return process.env.COURTLISTENER_API_TOKEN?.trim() || null;
        default:
            return null;
    }
}

export function hasEnvApiKey(provider: ApiKeyProvider): boolean {
    return !!envApiKey(provider);
}

export function getEnvironmentApiKeyStatus(): ApiKeyStatus {
    const status: ApiKeyStatus = {
        claude: false,
        gemini: false,
        openai: false,
        deepseek: false,
        openrouter: false,
        meta: false,
        courtlistener: false,
        sources: {
            claude: null,
            gemini: null,
            openai: null,
            deepseek: null,
            openrouter: null,
            meta: null,
            courtlistener: null,
        },
    };
    for (const provider of PROVIDERS) {
        if (!hasEnvApiKey(provider)) continue;
        status[provider] = true;
        status.sources[provider] = "env";
    }
    return status;
}

export function getEnvironmentApiKeys(): UserApiKeys {
    return {
        claude: envApiKey("claude"),
        gemini: envApiKey("gemini"),
        openai: envApiKey("openai"),
        deepseek: envApiKey("deepseek"),
        openrouter: envApiKey("openrouter"),
        meta: envApiKey("meta"),
        courtlistener: envApiKey("courtlistener"),
    };
}

const USER_API_KEY_SALT = "mike-user-api-keys-v1";

function encryptionSecret(): string {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured");
    }
    return secret;
}

function encrypt(value: string): Omit<EncryptedKeyRow, "provider"> {
    const encrypted = encryptSecret(value, encryptionSecret(), USER_API_KEY_SALT);
    return {
        encrypted_key: encrypted.encrypted,
        iv: encrypted.iv,
        auth_tag: encrypted.tag,
    };
}

function decrypt(row: EncryptedKeyRow): string | null {
    try {
        return decryptSecret(
            { encrypted: row.encrypted_key, iv: row.iv, tag: row.auth_tag },
            encryptionSecret(),
            USER_API_KEY_SALT,
        );
    } catch (err) {
        console.error("[user-api-keys] failed to decrypt stored key", {
            provider: row.provider,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

function isProvider(value: string): value is ApiKeyProvider {
    return (PROVIDERS as string[]).includes(value);
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
    return isProvider(value) ? value : null;
}

export async function getUserApiKeyStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const status = getEnvironmentApiKeyStatus();

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider")
        .eq("user_id", userId);
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

export async function getUserApiKeys(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    const apiKeys = getEnvironmentApiKeys();

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of (data ?? []) as EncryptedKeyRow[]) {
        const provider = normalizeApiKeyProvider(row.provider);
        if (!provider) continue;
        if (apiKeys[provider]?.trim()) continue;
        apiKeys[provider] = decrypt(row);
    }

    return apiKeys;
}

export async function saveUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    const normalized = value?.trim() || null;
    if (!normalized) {
        const { error } = await db
            .from("user_api_keys")
            .delete()
            .eq("user_id", userId)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider,
            ...encrypt(normalized),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) throw error;
}
