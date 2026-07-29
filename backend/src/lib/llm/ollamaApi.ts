// ollama:<model> — local models (the desktop PC's Qwen) over ollama's
// native /api/chat tool calling. Transport-only, so the Beaver harness
// stays identical while a local small model supplies the inference layer.
// Base URL from OLLAMA_BASE_URL, context window from OLLAMA_NUM_CTX.
import { throwIfAborted } from "./abort";
import type {
  NormalizedLlmUsage,
  NormalizedToolCall,
  StreamChatParams,
  StreamChatResult,
} from "./types";

const DEFAULT_BASE_URL = "http://192.168.1.64:11434";
const CALL_TIMEOUT_MS = 900_000;

export function ollamaModelSlug(model: string): string | null {
  return model.startsWith("ollama:")
    ? model.slice("ollama:".length).trim() || null
    : null;
}

type OllamaMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  tool_name?: string;
};

type OllamaChatReply = {
  message?: OllamaMessage;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

export async function streamOllama(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const slug = ollamaModelSlug(params.model);
  if (!slug) throw new Error(`Not an ollama model: ${params.model}`);
  const { callbacks = {}, runTools, tools = [] } = params;
  const baseUrl = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/u, "");
  const numCtx = Number(process.env.OLLAMA_NUM_CTX || 32768);
  const maxIter = params.maxIterations ?? 10;

  // Images are not carried over this transport (fails closed).
  const messages: OllamaMessage[] = [
    { role: "system", content: params.systemPrompt },
    ...params.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  let fullText = "";
  let callCounter = 0;
  const callNames = new Map<string, string>();
  const usage: NormalizedLlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
  };

  for (let iter = 0; iter < maxIter; iter++) {
    throwIfAborted(params.abortSignal);
    const signals = [AbortSignal.timeout(CALL_TIMEOUT_MS)];
    if (params.abortSignal) signals.push(params.abortSignal);
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: slug,
        messages,
        // OpenAIToolSchema is already ollama's expected tool shape.
        tools,
        stream: false,
        options: { temperature: 0, num_ctx: numCtx },
      }),
      signal: AbortSignal.any(signals),
    });
    if (!response.ok)
      throw new Error(`ollama /api/chat HTTP ${response.status}`);
    const reply = (await response.json()) as OllamaChatReply;
    if (reply.error) throw new Error(`ollama error: ${reply.error}`);
    const message = reply.message ?? { role: "assistant", content: "" };

    usage.inputTokens = (usage.inputTokens ?? 0) + (reply.prompt_eval_count ?? 0);
    usage.outputTokens = (usage.outputTokens ?? 0) + (reply.eval_count ?? 0);

    if (message.content) {
      fullText += message.content;
      callbacks.onContentDelta?.(message.content);
      callbacks.onContentBlockEnd?.();
    }

    const toolCalls: NormalizedToolCall[] = [];
    for (const raw of message.tool_calls ?? []) {
      const name = String(raw.function?.name ?? "");
      if (!name) continue;
      const rawArguments = raw.function?.arguments;
      let input: Record<string, unknown> = {};
      if (typeof rawArguments === "string") {
        try {
          input = JSON.parse(rawArguments) as Record<string, unknown>;
        } catch {
          input = {};
        }
      } else if (rawArguments && typeof rawArguments === "object") {
        input = rawArguments as Record<string, unknown>;
      }
      callCounter += 1;
      const id = `call_${callCounter}`;
      callNames.set(id, name);
      const call: NormalizedToolCall = { id, name, input };
      callbacks.onToolCallStart?.(call);
      toolCalls.push(call);
    }

    if (!toolCalls.length || !runTools) break;
    const results = await runTools(toolCalls);
    throwIfAborted(params.abortSignal);
    messages.push(message);
    for (const result of results) {
      messages.push({
        role: "tool",
        tool_name: callNames.get(result.tool_use_id) ?? result.tool_use_id,
        content: result.content,
      });
    }
  }

  return { fullText, usage };
}

export async function completeOllamaText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
}): Promise<string> {
  const result = await streamOllama({
    model: params.model,
    systemPrompt: params.systemPrompt ?? "",
    messages: [{ role: "user", content: params.user }],
  });
  return result.fullText;
}
