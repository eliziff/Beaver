import { requireApiKey } from "./apiKeys";
import { createCompatibleWireAdapter } from "./openaiCompatibleWire";
import { runProviderLoop } from "./providerLoop";
import type { StreamChatParams, StreamChatResult } from "./types";

const maxTokens = () => Number(process.env.MIKE_DEEPSEEK_MAX_TOKENS) || 32_768;
const effort = (value?: string) => {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (!["low", "medium", "high", "max"].includes(normalized)) {
    throw new Error(`Unsupported DeepSeek reasoning effort: ${value}`);
  }
  return normalized;
};

export function streamDeepSeek(params: StreamChatParams): Promise<StreamChatResult> {
  const apiKey = requireApiKey(
    params.apiKeys?.deepseek,
    "DEEPSEEK_API_KEY",
    "DeepSeek",
  );
  return runProviderLoop(params, createCompatibleWireAdapter(params, {
    apiKey,
    baseURL: "https://api.deepseek.com",
    model: params.model,
    provider: "deepseek",
    maxTokens: maxTokens(),
    request: {
      thinking: { type: params.enableThinking ? "enabled" : "disabled" },
      reasoning_effort: params.enableThinking ? effort(params.reasoningEffort) : undefined,
    },
  }));
}
