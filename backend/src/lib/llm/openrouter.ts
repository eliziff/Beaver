import {
  completeResponsesText,
  streamResponsesApi,
} from "./openai";
import type { StreamChatParams, StreamChatResult } from "./types";

const OPENROUTER_RESPONSES_URL = "https://openrouter.ai/api/v1/responses";

function apiKey(override?: string | null): string {
  const key = override?.trim() || process.env.OPENROUTER_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "OpenRouter API key is not configured. Set OPENROUTER_API_KEY or add a user OpenRouter key.",
    );
  }
  return key;
}

export async function streamOpenRouter(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  return streamResponsesApi(params, {
    endpoint: OPENROUTER_RESPONSES_URL,
    provider: "OpenRouter",
    apiKey: apiKey(params.apiKeys?.openrouter),
    persistent: false,
    defaultReasoningEffort: "medium",
  });
}

export async function completeOpenRouterText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { openrouter?: string | null };
}): Promise<string> {
  return completeResponsesText(params, {
    endpoint: OPENROUTER_RESPONSES_URL,
    provider: "OpenRouter",
    apiKey: apiKey(params.apiKeys?.openrouter),
  });
}
