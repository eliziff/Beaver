import type { ApiKeyState } from "@/app/lib/api/account";
import { modelProvider, type ModelProvider } from "mike/shared/runtime/clientContracts.mjs";
export { modelProvider, type ModelProvider };

const PROVIDER_LABELS: Record<ModelProvider, string> = {
    claude: "Anthropic (Claude)", gemini: "Google (Gemini)", openai: "OpenAI",
    deepseek: "DeepSeek", openrouter: "OpenRouter", "opencode-go": "OpenCode Go",
    meta: "Meta", "claude-p": "Claude Code", codex: "Codex", ollama: "Desktop",
    configured: "Configured endpoint",
};
export function isModelAvailable(modelId: string, apiKeys: ApiKeyState): boolean {
    const provider = modelProvider(modelId);
    if (!provider) return false;
    // Subscription lanes carry their own credential, so the catalog being
    // non-empty is the availability signal rather than a pasted key.
    return provider === "claude-p" || provider === "codex" || provider === "ollama" ||
        provider === "opencode-go" || provider === "configured" || !!apiKeys[provider]?.configured;
}
export const providerLabel = (provider: ModelProvider) => PROVIDER_LABELS[provider];

const PROVIDER_SHORT_LABELS: Record<ModelProvider, string> = {
    claude: "Anthropic", "claude-p": "Claude Code", gemini: "Google", openai: "OpenAI",
    deepseek: "DeepSeek", openrouter: "OpenRouter", "opencode-go": "OpenCode Go",
    meta: "Meta", codex: "Codex", ollama: "Desktop",
    configured: "Configured",
};
export const providerShortLabel = (provider: ModelProvider) => PROVIDER_SHORT_LABELS[provider];
