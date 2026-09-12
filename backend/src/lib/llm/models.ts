import type { Provider } from "./types";

export type PickerModel = {
    id: string; label: string; group: string; provider: Provider;
    settingsOnly?: boolean; available?: boolean;
    reasoningEfforts?: string[]; defaultReasoningEffort?: string;
};
const STATIC_MODELS = [
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-5", label: "Claude Opus 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", group: "DeepSeek" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", group: "DeepSeek" },
    { id: "muse-spark-1.2", label: "Muse Spark 1.2", group: "Meta" },
    { id: "muse-spark-1.1", label: "Muse Spark 1.1", group: "Meta" },
    { id: "meta/muse-spark-1.1", label: "Muse Spark 1.1 (OpenRouter)", group: "Meta" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI", settingsOnly: true },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI", settingsOnly: true },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic", settingsOnly: true },
    { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", group: "Google", settingsOnly: true },
    { id: "gpt-5.4-lite", label: "GPT-5.4 Lite", group: "OpenAI", settingsOnly: true },
    // The contributor tier trains on inputs and stays out of the chat picker.
    { id: "muse-spark-1.2-contributor", label: "Muse Spark 1.2 (contributor � trains on input)", group: "Meta", settingsOnly: true },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", group: "OpenAI", hidden: true },
];

export function pickerModel(model: Omit<PickerModel, "provider">): PickerModel {
    const reasoning = model.id.startsWith("deepseek-")
        ? { reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" }
        : model.id.startsWith("claude-p:")
            ? { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high" }
        : model.id.includes("muse-spark-")
            ? { reasoningEfforts: ["xhigh", "high", "medium", "low", "minimal"], defaultReasoningEffort: "medium" }
            : {};
    return { ...reasoning, ...model, provider: providerForModel(model.id) };
}

export function staticPickerModels() {
    const models = STATIC_MODELS.filter(model => !model.hidden);
    return [...models.map(pickerModel), ...models.filter(model => model.group === "Anthropic")
        .map(model => pickerModel({ ...model, id: `claude-p:${model.id}`, group: "Claude Code" }))];
}

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
        "grok-4.5",
        "gpt-5.6-luna",
        "muse-spark-1.3-contributor",
        "muse-spark-1.2-contributor",
        "omen-alpha",
    ]),
    chat: new Set([
        "glm-5.3-flash",
        "glm-5.3",
        "glm-5.2",
        "glm-5.1",
        "glm-5",
        "kimi-k3",
        "kimi-k2.7-code",
        "kimi-k2.6",
        "kimi-k2.5",
        "longcat-2.0",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "mimo-v2-pro",
        "mimo-v2-omni",
        "hy4-preview",
        "hy3",
        "hy3-preview",
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
        "qwen3.5-plus",
    ]),
} as const;

export type OpenCodeGoProtocol = keyof typeof OPENCODE_GO_MODELS;

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.1-flash-lite-preview";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

const ALL_MODELS = new Set(STATIC_MODELS.map(model => model.id));

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
