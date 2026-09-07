import { SETTINGS_MODELS, type ModelOption } from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "@/app/lib/api/account";
export type ModelProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "deepseek"
    | "openrouter"
    | "opencode-go"
    | "meta"
    | "claude-p"
    | "codex"
    | "ollama";
export function getModelProvider(modelId: string): ModelProvider | null {
    if (modelId.startsWith("claude-p:")) return "claude-p";
    if (modelId.startsWith("codex:")) {
        return "codex";
    }
    if (modelId.startsWith("ollama:")) return "ollama";
    if (modelId.startsWith("opencode-go/")) return "opencode-go";
    // Muse Spark ships on two transports; the bare id is the direct one and
    // the `meta/` slug is OpenRouter, so the group alone cannot decide.
    if (modelId.startsWith("muse-spark-")) return "meta";
    const model = SETTINGS_MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    return modelGroupToProvider(model.group);
}
export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    return isProviderAvailable(provider, apiKeys);
}
function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    // Subscription lanes carry their own credential, so the catalog being
    // non-empty is the availability signal rather than a pasted key.
    if (
        provider === "claude-p" ||
        provider === "codex" ||
        provider === "ollama" ||
        provider === "opencode-go"
    )
        return true;
    return !!apiKeys[provider]?.configured;
}
export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI";
    if (provider === "deepseek") return "DeepSeek";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "opencode-go") return "OpenCode Go";
    if (provider === "meta") return "Meta";
    if (provider === "claude-p") return "Claude Code";
    if (provider === "codex") return "Codex";
    if (provider === "ollama") return "Desktop";
    return "Google (Gemini)";
}
function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Claude Code") return "claude-p";
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    if (group === "DeepSeek") return "deepseek";
    if (group === "Meta") return "openrouter";
    if (group === "OpenCode Go") return "opencode-go";
    if (group === "Codex") return "codex";
    if (group === "Desktop") return "ollama";
    return "gemini";
}
