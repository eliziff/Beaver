import type { Provider } from "./types";

export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = ["gpt-5.6-luna", "gpt-5.5", "gpt-5.4"] as const;
export const DEEPSEEK_MAIN_MODELS = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
] as const;
/** Muse Spark reached over OpenRouter. The `meta/` prefix is OpenRouter's slug. */
export const META_MAIN_MODELS = ["meta/muse-spark-1.1"] as const;
/**
 * Muse Spark reached directly on Meta Model API, which uses bare model ids.
 * The `-contributor` tier is ~12x cheaper because Meta trains on the prompts
 * and completions sent to it, so it is off the default picker and belongs
 * nowhere near client documents.
 */
const META_DIRECT_MODELS = [
    "muse-spark-1.2",
    "muse-spark-1.1",
    "muse-spark-1.2-contributor",
] as const;

export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"] as const;
export const OPENAI_MID_MODELS = ["gpt-5.4"] as const;

export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.4-lite"] as const;
const CODEX_MODEL_PREFIX = "codex:";
const CLAUDE_P_MODEL_PREFIX = "claude-p:";
const OLLAMA_MODEL_PREFIX = "ollama:";
const OPENCODE_GO_MODEL_PREFIX = "opencode-go/";
// OpenCode Go publishes one catalog over three wire protocols, but /models
// does not say which protocol each model speaks. Keep this small compatibility
// map fail-closed and refresh it from https://opencode.ai/docs/go/.
const OPENCODE_GO_MODELS = {
    responses: new Set([
        "grok-4.6",
        "gpt-5.6-luna",
        "muse-spark-1.2-contributor",
    ]),
    chat: new Set([
        "glm-5.3-flash",
        "glm-5.3",
        "glm-5.2",
        "glm-5.1",
        "kimi-k3",
        "kimi-k2.7-code",
        "kimi-k2.6",
        "longcat-2.0",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "hy4-preview",
        "hy3",
    ]),
    messages: new Set([
        "minimax-m3",
        "minimax-m2.7",
        "minimax-m2.5",
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.6-plus",
    ]),
} as const;

export type OpenCodeGoProtocol = keyof typeof OPENCODE_GO_MODELS;

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.1-flash-lite-preview";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
    ...DEEPSEEK_MAIN_MODELS,
    ...META_MAIN_MODELS,
    ...META_DIRECT_MODELS,
]);


export function providerForModel(model: string): Provider {
    if (model.startsWith(CODEX_MODEL_PREFIX)) return "codex";
    if (model.startsWith(CLAUDE_P_MODEL_PREFIX)) return "claude-p";
    if (model.startsWith(OLLAMA_MODEL_PREFIX)) return "ollama";
    if (model.startsWith(OPENCODE_GO_MODEL_PREFIX)) return "opencode-go";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    if (model.startsWith("deepseek-")) return "deepseek";
    // Transport is carried by the id shape: OpenRouter slugs are namespaced,
    // Meta Model API takes the bare id.
    if (model.startsWith("meta/")) return "openrouter";
    if (model.startsWith("muse-spark-")) return "meta";
    throw new Error(`Unknown model id: ${model}`);
}

export function isSupportedModel(model: string): boolean {
    if (ALL_MODELS.has(model)) return true;
    if (openCodeGoProtocol(model)) return true;
    return [CODEX_MODEL_PREFIX, CLAUDE_P_MODEL_PREFIX, OLLAMA_MODEL_PREFIX]
        .some((prefix) => model.startsWith(prefix) && model.slice(prefix.length).trim().length > 0);
}

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id && isSupportedModel(id)) return id;
    return fallback;
}

export function resolveRequestedModel(
    id: string | null | undefined,
    fallback: string,
): string {
    if (!id) return fallback;
    if (isSupportedModel(id)) return id;
    throw new Error(`Unsupported model id: ${id}`);
}

export function codexModelSlug(model: string): string | null {
    if (!model.startsWith(CODEX_MODEL_PREFIX)) return null;
    const slug = model.slice(CODEX_MODEL_PREFIX.length).trim();
    return slug || null;
}

export function openCodeGoModelSlug(model: string): string | null {
    if (!model.startsWith(OPENCODE_GO_MODEL_PREFIX)) return null;
    const slug = model.slice(OPENCODE_GO_MODEL_PREFIX.length).trim();
    return slug && !slug.includes("/") ? slug : null;
}

export function openCodeGoProtocol(model: string): OpenCodeGoProtocol | null {
    const slug = model.startsWith(OPENCODE_GO_MODEL_PREFIX)
        ? openCodeGoModelSlug(model)
        : model.trim();
    if (!slug) return null;
    return (Object.keys(OPENCODE_GO_MODELS) as OpenCodeGoProtocol[])
        .find((protocol) => OPENCODE_GO_MODELS[protocol].has(slug)) ?? null;
}

/** All currently exposed Beaver models accept images; unknown future models fail closed. */
export function modelSupportsImageInput(model: string): boolean {
    if (model.startsWith(OPENCODE_GO_MODEL_PREFIX)) {
        return model === `${OPENCODE_GO_MODEL_PREFIX}deepseek-v4-flash-vision-exp`;
    }
    if (model.startsWith("deepseek-")) return false;
    // Experiment transports carry text only.
    if (model.startsWith(CLAUDE_P_MODEL_PREFIX)) return false;
    if (model.startsWith(OLLAMA_MODEL_PREFIX)) return false;
    return model.startsWith(CODEX_MODEL_PREFIX) || ALL_MODELS.has(model);
}
