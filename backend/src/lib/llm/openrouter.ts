import { requireApiKey } from "./apiKeys";
import {
  completeResponsesText,
  streamResponsesApi,
} from "./openai";
import type { StreamChatParams, StreamChatResult } from "./types";

const OPENROUTER_RESPONSES_URL = "https://openrouter.ai/api/v1/responses";

function apiKey(override?: string | null): string {
  return requireApiKey(override, ["OPENROUTER_API_KEY"], "OpenRouter");
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
