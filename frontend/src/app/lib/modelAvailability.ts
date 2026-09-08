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
    const prefixes: [string, ModelProvider][] = [
        ["claude-p:", "claude-p"], ["codex:", "codex"], ["ollama:", "ollama"],
        ["opencode-go/", "opencode-go"], ["claude-", "claude"], ["gemini-", "gemini"],
        ["gpt-", "openai"], ["deepseek-", "deepseek"], ["meta/", "openrouter"], ["muse-spark-", "meta"],
    ];
    return prefixes.find(([prefix]) => modelId.startsWith(prefix))?.[1] ?? null;
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
