import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { streamDeepSeek, completeDeepSeekText } from "./deepseek";
import { streamOpenRouter, completeOpenRouterText } from "./openrouter";
import { streamCodex, completeCodexText } from "./codex";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";
export { streamCodex };

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const provider = providerForModel(params.model);
    if (provider === "claude") return streamClaude(params);
    if (provider === "openai") return streamOpenAI(params);
    if (provider === "deepseek") return streamDeepSeek(params);
    if (provider === "openrouter") return streamOpenRouter(params);
    if (provider === "codex") return streamCodex(params);
    return streamGemini(params);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const provider = providerForModel(params.model);
    if (provider === "claude") return completeClaudeText(params);
    if (provider === "openai") return completeOpenAIText(params);
    if (provider === "deepseek") return completeDeepSeekText(params);
    if (provider === "openrouter") return completeOpenRouterText(params);
    if (provider === "codex") return completeCodexText(params);
    return completeGeminiText(params);
}
