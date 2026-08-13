import { abortError, throwIfAborted } from "./abort";
import { requireApiKey } from "./apiKeys";
import type {
  NormalizedToolCall,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createLlmTrace } from "./rawStreamLog";

const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
// DeepSeek's own default output budget for reasoning models is 32K tokens
// (max 64K); at 16K the reasoning stream ate the entire budget before the
// model could emit a tool call (LAB smoke run, 2026-08-03), truncating
// mid-planning. Keep the provider default unless the experiment asks for more
// (MIKE_DEEPSEEK_MAX_TOKENS raises the per-response output budget so heavy
// analysis finishes before drafting).
const MAX_TOKENS = Number(process.env.MIKE_DEEPSEEK_MAX_TOKENS) || 32768;

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

type DeepSeekUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

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
  usage?: DeepSeekUsage;
  error?: { code?: string; message?: string };
};

function apiKey(override?: string | null): string {
  return requireApiKey(
    override,
    ["DEEPSEEK_API_KEY", "DEEPSEEK_OCR_KEY"],
    "DeepSeek",
  );
}

function effort(value?: string): string {
  const normalized = value?.toLowerCase() ?? "";
  if (["max", "xhigh", "ultra"].includes(normalized)) return "max";
  if (["low", "medium", "high"].includes(normalized)) return normalized;
  return "high";
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

/**
 * Transport-class failures worth one more attempt: socket/DNS-level errors
 * (undici surfaces mid-stream TLS resets as `TypeError: terminated`, request
 * failures as `TypeError: fetch failed` with the errno on `cause`) plus
 * transient HTTP statuses. Semantic failures — 4xx other than 429, provider
 * `chunk.error` payloads — never match.
 */
const TRANSPORT_ERROR_PATTERN =
  /\bterminated\b|fetch failed|socket hang up|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_|DeepSeek request failed \((?:429|500|502|503|504)\)/i;

const TRANSPORT_ATTEMPTS = 3;

export function isTransportError(error: unknown): boolean {
  const seen: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 4; depth++) {
    if (cursor instanceof Error) {
      seen.push(cursor.name, cursor.message);
      const code = (cursor as { code?: unknown }).code;
      if (typeof code === "string") seen.push(code);
      cursor = cursor.cause;
    } else {
      seen.push(String(cursor));
      break;
    }
  }
  return TRANSPORT_ERROR_PATTERN.test(seen.join(" "));
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
      stream_options: params.stream
        ? { include_usage: true }
        : undefined,
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
  const trace = createLlmTrace({ provider: "deepseek", model });
  let fullText = "";
  // Aggregated provider-reported usage across every response in the tool loop.
  // DeepSeek streams one usage object per response (final chunk when
  // stream_options.include_usage is set); cache hit/miss map to the harness's
  // cacheRead/cacheWrite fields. DeepSeek does not break out reasoning tokens,
  // so reasoningTokens stays null.
  const totalUsage: DeepSeekUsage = {};
  let sawUsage = false;

  try {
    for (
      let iteration = 0;
      params.maxIterations === undefined || iteration < params.maxIterations;
      iteration++
    ) {
      throwIfAborted(params.abortSignal);
      // Per-round resolveTools, matching the other adapters (openai/claudeP/
      // gemini/ollama): a tool revealed by a discovery call in round N must be
      // callable in round N+1. DeepSeek's prefix-cache identity is on the
      // SERIALIZED request bytes, not object identity — an unchanged tool array
      // serializes identically each round, so per-round resolution does not
      // hurt the automatic context cache.
      const resolvedTools = params.resolveTools?.() ?? tools;
      // A transient socket reset must not kill an hour-long run. Retry the
      // round on transport-class failures, but only while nothing has been
      // forwarded to callbacks/fullText: consumers accumulate deltas into the
      // persisted turn, so a post-emission retry would duplicate text, and a
      // resampled response cannot be stitched onto a partial one. The exposed
      // window is dominated by prefill (minutes of silence on large contexts),
      // which is exactly the zero-progress case this covers.
      const pending = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let content = "";
      let reasoning = "";
      let responseUsage: DeepSeekUsage | undefined;
      let roundEmitted = false;
      for (let attempt = 1; ; attempt++) {
        pending.clear();
        content = "";
        reasoning = "";
        responseUsage = undefined;
        roundEmitted = false;
        try {
          const response = await createCompletion({
            apiKey: key,
            model,
            messages,
            tools: resolvedTools,
            stream: true,
            thinking: enableThinking,
            reasoningEffort: params.reasoningEffort,
            signal: params.abortSignal,
          });
          if (!response.body) throw new Error("DeepSeek response had no body.");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            throwIfAborted(params.abortSignal);
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const parsed = ssePayloads(done ? `${buffer}\n\n` : buffer);
            buffer = parsed.rest;

            for (const payload of parsed.payloads) {
              trace.record({ iteration, label: "sse_event", payload });
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
              // Usage arrives on the stream's final chunk (no choices). Capture the
              // last usage object of the response — that is the cumulative total.
              if (chunk.usage) responseUsage = chunk.usage;
              const delta = chunk.choices?.[0]?.delta;
              if (typeof delta?.reasoning_content === "string") {
                if (delta.reasoning_content) roundEmitted = true;
                reasoning += delta.reasoning_content;
                callbacks.onReasoningDelta?.(delta.reasoning_content);
              }
              if (typeof delta?.content === "string") {
                if (delta.content) roundEmitted = true;
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
          break;
        } catch (error) {
          throwIfAborted(params.abortSignal);
          if (
            attempt >= TRANSPORT_ATTEMPTS ||
            roundEmitted ||
            !isTransportError(error)
          ) {
            throw error;
          }
          trace.record({
            iteration,
            label: "transport_retry",
            payload: JSON.stringify({ attempt, error: String(error) }),
          });
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }
      }

      if (responseUsage) {
        sawUsage = true;
        totalUsage.prompt_tokens =
          (totalUsage.prompt_tokens ?? 0) + (responseUsage.prompt_tokens ?? 0);
        totalUsage.completion_tokens =
          (totalUsage.completion_tokens ?? 0) +
          (responseUsage.completion_tokens ?? 0);
        totalUsage.total_tokens =
          (totalUsage.total_tokens ?? 0) + (responseUsage.total_tokens ?? 0);
        totalUsage.prompt_cache_hit_tokens =
          (totalUsage.prompt_cache_hit_tokens ?? 0) +
          (responseUsage.prompt_cache_hit_tokens ?? 0);
        totalUsage.prompt_cache_miss_tokens =
          (totalUsage.prompt_cache_miss_tokens ?? 0) +
          (responseUsage.prompt_cache_miss_tokens ?? 0);
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
      if (results.some((result) => result.terminal)) break;
      for (const result of results) {
        messages.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: result.content,
        });
      }
    }

    await trace.flush("completed");
    return {
      fullText,
      usage: sawUsage
        ? {
            inputTokens: totalUsage.prompt_tokens ?? null,
            outputTokens: totalUsage.completion_tokens ?? null,
            reasoningTokens: null,
            cacheReadInputTokens: totalUsage.prompt_cache_hit_tokens ?? null,
            cacheWriteInputTokens: null,
          }
        : undefined,
    };
  } catch (error) {
    await trace.flush("error", error);
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
