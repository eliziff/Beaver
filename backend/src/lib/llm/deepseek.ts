import type {
  NormalizedToolCall,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const MAX_TOKENS = 16384;

type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type DeepSeekMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type DeepSeekStreamChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  error?: { code?: string; message?: string };
};

function apiKey(override?: string | null): string {
  const key =
    override?.trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    process.env.DEEPSEEK_OCR_KEY?.trim() ||
    "";
  if (!key) {
    throw new Error(
      "DeepSeek API key is not configured. Set DEEPSEEK_API_KEY or add a user DeepSeek key.",
    );
  }
  return key;
}

function abortError(): Error {
  const error = new Error("Stream aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function effort(value?: string): "high" | "max" {
  return ["max", "xhigh", "ultra"].includes(value?.toLowerCase() ?? "")
    ? "max"
    : "high";
}

export function toDeepSeekMessages(
  messages: StreamChatParams["messages"],
  systemPrompt?: string,
): DeepSeekMessage[] {
  if (messages.some((message) => message.images?.length)) {
    throw new Error("DeepSeek V4 does not support image input.");
  }
  return [
    ...(systemPrompt
      ? ([{ role: "system", content: systemPrompt }] as DeepSeekMessage[])
      : []),
    ...messages.map(
      (message): DeepSeekMessage => ({
        role: message.role,
        content: message.content,
      }),
    ),
  ];
}

function parseToolCall(call: DeepSeekToolCall): NormalizedToolCall {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    // The tool dispatcher will surface missing/invalid arguments safely.
  }
  return { id: call.id, name: call.function.name, input };
}

function ssePayloads(buffer: string): { payloads: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  return {
    payloads: blocks.flatMap((block) => {
      const payload = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      return payload && payload !== "[DONE]" ? [payload] : [];
    }),
    rest,
  };
}

async function createCompletion(params: {
  apiKey: string;
  model: string;
  messages: DeepSeekMessage[];
  tools?: OpenAIToolSchema[];
  stream?: boolean;
  maxTokens?: number;
  thinking?: boolean;
  reasoningEffort?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const thinking = params.thinking === true;
  const response = await fetch(DEEPSEEK_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      tools: params.tools?.length ? params.tools : undefined,
      stream: params.stream,
      max_tokens: params.maxTokens ?? MAX_TOKENS,
      thinking: { type: thinking ? "enabled" : "disabled" },
      reasoning_effort: thinking ? effort(params.reasoningEffort) : undefined,
    }),
    signal: params.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `DeepSeek request failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return response;
}

export async function streamDeepSeek(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const {
    callbacks = {},
    enableThinking,
    model,
    runTools,
    systemPrompt,
    tools = [],
  } = params;
  const key = apiKey(params.apiKeys?.deepseek);
  const messages = toDeepSeekMessages(params.messages, systemPrompt);
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "deepseek",
    model,
  });
  let fullText = "";

  try {
    for (let iteration = 0; iteration < (params.maxIterations ?? 10); iteration++) {
      throwIfAborted(params.abortSignal);
      const response = await createCompletion({
        apiKey: key,
        model,
        messages,
        tools,
        stream: true,
        thinking: enableThinking,
        reasoningEffort: params.reasoningEffort,
        signal: params.abortSignal,
      });
      if (!response.body) throw new Error("DeepSeek response had no body.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const pending = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let content = "";
      let reasoning = "";
      let buffer = "";

      while (true) {
        throwIfAborted(params.abortSignal);
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const parsed = ssePayloads(done ? `${buffer}\n\n` : buffer);
        buffer = parsed.rest;

        for (const payload of parsed.payloads) {
          logRawLlmStream({
            provider: "deepseek",
            model,
            iteration,
            label: "sse_event",
            payload,
          });
          rawStreamRecorder?.record({
            iteration,
            label: "sse_event",
            payload,
          });
          let chunk: DeepSeekStreamChunk;
          try {
            chunk = JSON.parse(payload) as DeepSeekStreamChunk;
          } catch {
            continue;
          }
          if (chunk.error) {
            throw new Error(
              `DeepSeek error${chunk.error.code ? ` (${chunk.error.code})` : ""}: ${chunk.error.message || "Request failed."}`,
            );
          }
          const delta = chunk.choices?.[0]?.delta;
          if (typeof delta?.reasoning_content === "string") {
            reasoning += delta.reasoning_content;
            callbacks.onReasoningDelta?.(delta.reasoning_content);
          }
          if (typeof delta?.content === "string") {
            content += delta.content;
            fullText += delta.content;
            callbacks.onContentDelta?.(delta.content);
          }
          for (const part of delta?.tool_calls ?? []) {
            const index = part.index ?? 0;
            const current = pending.get(index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.name += part.function.name;
            if (part.function?.arguments) {
              current.arguments += part.function.arguments;
            }
            pending.set(index, current);
          }
        }
        if (done) break;
      }

      if (reasoning) callbacks.onReasoningBlockEnd?.();
      const nativeCalls: DeepSeekToolCall[] = [...pending.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          id: call.id || `deepseek-tool-${iteration}-${index}`,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      const toolCalls = nativeCalls.map(parseToolCall);
      for (const call of toolCalls) callbacks.onToolCallStart?.(call);

      if (!toolCalls.length || !runTools) break;
      messages.push({
        role: "assistant",
        content: content || null,
        reasoning_content: reasoning || undefined,
        tool_calls: nativeCalls,
      });
      const results = await runTools(toolCalls);
      for (const result of results) {
        messages.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: result.content,
        });
      }
    }

    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    if (params.abortSignal?.aborted) throw abortError();
    throw error;
  }
}

export async function completeDeepSeekText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { deepseek?: string | null };
}): Promise<string> {
  const response = await createCompletion({
    apiKey: apiKey(params.apiKeys?.deepseek),
    model: params.model,
    messages: toDeepSeekMessages(
      [{ role: "user", content: params.user }],
      params.systemPrompt,
    ),
    maxTokens: params.maxTokens ?? 512,
    thinking: false,
  });
  const json = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}
