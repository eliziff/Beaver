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
const COMPOSITE_PROVIDERS: [string, ModelProvider][] = [
    ["claude-p:", "claude-p"], ["claude:", "claude"], ["gemini:", "gemini"],
    ["openai:", "openai"], ["deepseek:", "deepseek"], ["openrouter:", "openrouter"],
    ["opencode-go:", "opencode-go"], ["meta:", "meta"], ["codex:", "codex"],
    ["ollama:", "ollama"],
];

export function getModelProvider(modelId: string): ModelProvider | null {
    // A selection is `provider:native`; the provider is explicit.
    const composite = COMPOSITE_PROVIDERS.find(([prefix]) => modelId.startsWith(prefix));
    if (composite) return composite[1];
    // Legacy shape-only ids.
    if (modelId.includes("/") && !modelId.startsWith("opencode-go/")) return "openrouter";
    const prefixes: [string, ModelProvider][] = [
        ["claude-p:", "claude-p"], ["codex:", "codex"], ["ollama:", "ollama"],
        ["opencode-go/", "opencode-go"], ["claude-", "claude"], ["gemini-", "gemini"],
        ["gpt-", "openai"], ["deepseek-", "deepseek"], ["muse-spark-", "meta"],
    ];
    return prefixes.find(([prefix]) => modelId.startsWith(prefix))?.[1] ?? null;
}

const PROVIDER_LABELS: Record<ModelProvider, string> = {
    claude: "Anthropic (Claude)", gemini: "Google (Gemini)", openai: "OpenAI",
    deepseek: "DeepSeek", openrouter: "OpenRouter", "opencode-go": "OpenCode Go",
    meta: "Meta", "claude-p": "Claude Code", codex: "Codex", ollama: "Desktop",
};
export function isModelAvailable(modelId: string, apiKeys: ApiKeyState): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    // Subscription lanes carry their own credential, so the catalog being
    // non-empty is the availability signal rather than a pasted key.
    return provider === "claude-p" || provider === "codex" || provider === "ollama" ||
        provider === "opencode-go" || !!apiKeys[provider]?.configured;
}
export const providerLabel = (provider: ModelProvider) => PROVIDER_LABELS[provider];

const PROVIDER_SHORT_LABELS: Record<ModelProvider, string> = {
    claude: "Anthropic", "claude-p": "Claude Code", gemini: "Google", openai: "OpenAI",
    deepseek: "DeepSeek", openrouter: "OpenRouter", "opencode-go": "OpenCode Go",
    meta: "Meta", codex: "Codex", ollama: "Desktop",
};
export const providerShortLabel = (provider: ModelProvider) => PROVIDER_SHORT_LABELS[provider];
