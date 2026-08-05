import { requireApiKey } from "./apiKeys";
import {
  completeResponsesText,
  streamResponsesApi,
} from "./openai";
import type { StreamChatParams, StreamChatResult } from "./types";

// Meta Model API speaks the OpenAI Responses dialect verbatim: probed against
// muse-spark-1.2 on 2026-08-05, `store:false`, `reasoning.effort`, function
// tools and the standard response.* SSE event names are all accepted.
const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";

function apiKey(override?: string | null): string {
  // MODEL_API_KEY is the name Meta's own docs export; META_API_KEY keeps the
  // repo's <PROVIDER>_API_KEY convention and wins when both are set.
  return requireApiKey(override, ["META_API_KEY", "MODEL_API_KEY"], "Meta");
}

export async function streamMeta(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  return streamResponsesApi(params, {
    endpoint: META_RESPONSES_URL,
    provider: "Meta",
    apiKey: apiKey(params.apiKeys?.meta),
    persistent: false,
    defaultReasoningEffort: "medium",
  });
}

export async function completeMetaText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { meta?: string | null };
}): Promise<string> {
  return completeResponsesText(params, {
    endpoint: META_RESPONSES_URL,
    provider: "Meta",
    apiKey: apiKey(params.apiKeys?.meta),
  });
}
