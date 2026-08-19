import { requireApiKey } from "./apiKeys";
import { createGeminiWireAdapter } from "./geminiWire";
import { runProviderLoop } from "./providerLoop";
import type { StreamChatParams, StreamChatResult } from "./types";

export function streamGemini(params: StreamChatParams): Promise<StreamChatResult> {
  const key = requireApiKey(params.apiKeys?.gemini, "GEMINI_API_KEY", "Gemini");
  return runProviderLoop(params, createGeminiWireAdapter(params, key));
}
