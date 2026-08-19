import { randomUUID } from "node:crypto";
import { requireApiKey } from "./apiKeys";
import { createResponsesWireAdapter } from "./openaiResponsesWire";
import { runProviderLoop } from "./providerLoop";
import type { StreamChatParams, StreamChatResult } from "./types";

const hosted = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    label: "OpenAI",
    env: "OPENAI_API_KEY",
    persistent: true,
    reasoningSummary: true,
    nativeCompaction: true,
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    label: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    persistent: false,
  },
  meta: {
    baseURL: "https://api.meta.ai/v1",
    label: "Meta",
    env: "META_API_KEY",
    persistent: false,
  },
} as const;

export function streamResponses(
  params: StreamChatParams,
  provider: keyof typeof hosted,
): Promise<StreamChatResult> {
  const config = hosted[provider];
  const override = provider === "openai" ? params.apiKeys?.openai
    : provider === "openrouter" ? params.apiKeys?.openrouter : params.apiKeys?.meta;
  const promptCacheKey = params.promptCacheKey?.trim() || randomUUID();
  const requestedTier = provider === "openai" ? params.serviceTier?.trim().toLowerCase() : undefined;
  const adapter = createResponsesWireAdapter(params, {
    ...config,
    provider: config.label,
    apiKey: requireApiKey(override, config.env, config.label),
    promptCacheKey,
    ...(requestedTier ? { serviceTier: requestedTier } : {}),
  });
  return runProviderLoop(params, adapter);
}
