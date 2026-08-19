import { createCompatibleWireAdapter, type CompatibleMessage } from "./openaiCompatibleWire";
import { ollamaBaseUrl } from "./ollamaModels";
import { runProviderLoop } from "./providerLoop";
import type { StreamChatParams, StreamChatResult, Tool } from "./types";

const numCtx = () => {
  const value = Number(process.env.OLLAMA_NUM_CTX || 32_768);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 32_768;
};

function compact(messages: CompatibleMessage[], tools: Tool[]) {
  const limit = Math.floor(numCtx() * 0.9);
  const estimate = () => Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools })) / 4);
  if (estimate() <= limit) return;
  const results = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  for (const index of results.slice(0, -1)) {
    const replacement = JSON.stringify({
      compacted: true,
      note: "Older tool output omitted to fit the local model context. Re-run the tool with a narrower query if needed.",
    });
    if (String(messages[index].content).length > replacement.length) messages[index].content = replacement;
    if (estimate() <= limit) return;
  }
  throw new Error(
    `This request is too large for the selected model's ${numCtx().toLocaleString("en-CA")}-token context. Start a new chat or choose a model with a larger context window.`,
  );
}

function mapError(error: unknown) {
  const status = (error as { status?: unknown }).status;
  const payload = (error as { error?: unknown }).error;
  if (typeof status === "number") {
    const detail = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error: unknown }).error) : error instanceof Error ? error.message : "";
    return Object.assign(new Error(
      `Desktop Ollama failed (HTTP ${status})${detail ? `: ${detail.replace(/\s+/gu, " ").trim().slice(0, 500)}` : ""}. Retry the request.`,
      { cause: error },
    ), { status });
  }
  return new Error(
    `Desktop Ollama is unreachable at ${ollamaBaseUrl()}. Start Ollama on the desktop and try again.`,
    { cause: error },
  );
}

export function streamOllama(params: StreamChatParams): Promise<StreamChatResult> {
  const model = params.model.startsWith("ollama:") ? params.model.slice(7).trim() : "";
  if (!model) throw new Error(`Not an ollama model: ${params.model}`);
  const effort = params.reasoningEffort?.toLowerCase();
  if (params.enableThinking && effort && !["low", "medium", "high"].includes(effort)) {
    throw new Error(`Unsupported Ollama reasoning effort: ${params.reasoningEffort}`);
  }
  return runProviderLoop(params, createCompatibleWireAdapter(params, {
    apiKey: "ollama",
    baseURL: `${ollamaBaseUrl()}/v1`,
    model,
    provider: "ollama",
    maxTokens: 32_768,
    headers: process.env.OLLAMA_HOST_HEADER ? { Host: process.env.OLLAMA_HOST_HEADER } : undefined,
    request: {
      temperature: 0,
      ...(!params.enableThinking ? { reasoning_effort: "none" } : effort ? { reasoning_effort: effort } : {}),
    },
    prepareMessages: compact,
    mapError,
  }));
}
