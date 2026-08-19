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
    getUserApiKeys,
} from "./userApiKeys";
import { isLocalRuntime } from "./localMode";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
};

export function resolveAvailableModel(
    apiKeys: Partial<Record<"gemini" | "openai" | "deepseek" | "claude", unknown>>,
    forTabular = false,
) {
    const geminiModel = forTabular ? DEFAULT_TABULAR_MODEL : DEFAULT_TITLE_MODEL;
    if (apiKeys.gemini) return geminiModel;
    if (apiKeys.openai) return OPENAI_LOW_MODELS[0];
    if (apiKeys.deepseek) return DEEPSEEK_MAIN_MODELS[0];
    if (apiKeys.claude)
        return forTabular ? CLAUDE_MID_MODELS[0] : CLAUDE_LOW_MODELS[0];
    return geminiModel;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    if (isLocalRuntime()) {
        const api_keys = getEnvironmentApiKeys();
        return {
            title_model: resolveAvailableModel(api_keys),
            tabular_model: resolveAvailableModel(api_keys, true),
            legal_research_us: true,
            api_keys,
        };
    }
    const client = db ?? createServerSupabase();
    const { data, error } = await client
        .from("user_profiles")
        .select("title_model, tabular_model, legal_research_us")
        .eq("user_id", userId)
        .single();
    if (error) throw error;
    const api_keys = await getUserApiKeys(userId, client);

    return {
        title_model: resolveModel(
            data?.title_model,
            resolveAvailableModel(api_keys),
        ),
        tabular_model: resolveModel(data?.tabular_model, resolveAvailableModel(api_keys, true)),
        legal_research_us:
            (data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
        api_keys,
    };
}
