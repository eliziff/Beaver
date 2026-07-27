import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    DEEPSEEK_MAIN_MODELS,
    CLAUDE_LOW_MODELS,
    CLAUDE_MID_MODELS,
    type UserApiKeys,
} from "./llm";
import {
    getEnvironmentApiKeys,
    getUserApiKeys as getStoredUserApiKeys,
} from "./userApiKeys";
import { isAnonymousLocalMode } from "./localMode";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
};

function resolveAvailableModel(
    apiKeys: UserApiKeys,
    forTabular = false,
) {
    const geminiModel = forTabular ? DEFAULT_TABULAR_MODEL : DEFAULT_TITLE_MODEL;
    if (apiKeys.gemini?.trim()) return geminiModel;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.deepseek?.trim()) return DEEPSEEK_MAIN_MODELS[0];
    if (apiKeys.claude?.trim())
        return forTabular ? CLAUDE_MID_MODELS[0] : CLAUDE_LOW_MODELS[0];
    return geminiModel;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    if (isAnonymousLocalMode()) {
        const api_keys = getEnvironmentApiKeys();
        return {
            title_model: resolveAvailableModel(api_keys),
            tabular_model: resolveAvailableModel(api_keys, true),
            legal_research_us: true,
            api_keys,
        };
    }
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("title_model, tabular_model, legal_research_us")
        .eq("user_id", userId)
        .single();
    const api_keys = await getStoredUserApiKeys(userId, client);

    return {
        title_model: resolveModel(
            data?.title_model,
            resolveAvailableModel(api_keys),
        ),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        legal_research_us:
            (data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    if (isAnonymousLocalMode()) return getEnvironmentApiKeys();
    const client = db ?? createServerSupabase();
    return getStoredUserApiKeys(userId, client);
}
