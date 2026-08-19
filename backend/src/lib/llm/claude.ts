import { requireApiKey } from "./apiKeys";
import { createAnthropicWireAdapter } from "./anthropicWire";
import { hasNativeCompaction } from "./contextWindow";
import { runProviderLoop } from "./providerLoop";
import type { StreamChatParams, StreamChatResult } from "./types";

export function streamClaude(params: StreamChatParams): Promise<StreamChatResult> {
  const key = requireApiKey(params.apiKeys?.claude, "ANTHROPIC_API_KEY", "Anthropic");
  return runProviderLoop(
    params,
    createAnthropicWireAdapter(params, key, hasNativeCompaction(params.model)),
  );
}
