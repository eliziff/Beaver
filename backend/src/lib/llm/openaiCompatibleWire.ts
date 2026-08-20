import { MAX_PROVIDER_TOOL_ARGUMENT_BYTES,
  type ProviderAdapter, type ProviderEvent, type ProviderStep } from "./providerLoop";
import { runtimeConstructor } from "./runtimeSdk";
import type { LlmMessage, NormalizedLlmUsage, StreamChatParams, Tool } from "./types";
import { isJsonRecord } from "../value";

export type CompatibleMessage = Record<string, unknown> & {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
};

type State = { messages: CompatibleMessage[] };
type PendingCall = { id: string; name: string; arguments: string };
type OpenAIClient = {
  chat: {
    completions: {
      create(
        request: Record<string, unknown>,
        options: { signal?: AbortSignal; maxRetries: number },
      ): Promise<AsyncIterable<unknown>>;
    };
  };
};
type OpenAIConstructor = new (options: {
  apiKey: string;
  baseURL: string;
  defaultHeaders?: Record<string, string>;
  maxRetries: number;
}) => OpenAIClient;
const openAI = runtimeConstructor<OpenAIConstructor>("openai");

type CompatibleWireConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: string;
  maxTokens: number;
  headers?: Record<string, string>;
  request?: Record<string, unknown>;
  prepareMessages?: (messages: CompatibleMessage[], tools: Tool[]) => void;
  mapError?: (error: unknown) => Error;
};

const wireTools = (tools: Tool[]) => tools.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.inputSchema,
  },
}));

function messages(source: LlmMessage[], system: string): CompatibleMessage[] {
  if (source.some((message) => message.images?.length)) {
    throw new Error("This provider does not support image input.");
  }
  return [
    ...(system ? [{ role: "system" as const, content: system }] : []),
    ...source.map((message): CompatibleMessage => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

function normalizedUsage(value: Record<string, unknown>): NormalizedLlmUsage {
  return {
    inputTokens: typeof value.prompt_tokens === "number" ? value.prompt_tokens : null,
    outputTokens: typeof value.completion_tokens === "number" ? value.completion_tokens : null,
    reasoningTokens: null,
    cacheReadInputTokens: typeof value.prompt_cache_hit_tokens === "number"
      ? value.prompt_cache_hit_tokens : null,
    cacheWriteInputTokens: typeof value.prompt_cache_miss_tokens === "number"
      ? value.prompt_cache_miss_tokens : null,
  };
}

export function createCompatibleWireAdapter(
  params: StreamChatParams,
  config: CompatibleWireConfig,
): ProviderAdapter {
  const initial = messages(params.messages, params.systemPrompt);
  const client = openAI.then((OpenAI) => new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.headers,
    maxRetries: 0,
  }));
  return {
    provider: config.provider,
    async *events(step: ProviderStep): AsyncIterable<ProviderEvent> {
      const state = step.iteration ? step.checkpoint as State | undefined : { messages: initial };
      if (!state) throw new Error(`${config.provider} did not return continuation state`);
      const requestMessages = state.messages.map((message) => ({ ...message }));
      for (const result of step.results) {
        requestMessages.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content });
      }
      for (const steer of step.steering) requestMessages.push({ role: "user", content: steer.text });
      config.prepareMessages?.(requestMessages, step.tools);

      let stream: AsyncIterable<unknown>;
      try {
        stream = await (await client).chat.completions.create({
          model: config.model,
          messages: requestMessages,
          tools: wireTools(step.tools),
          max_tokens: params.maxTokens ?? config.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...config.request,
        }, {
          signal: step.signal,
          maxRetries: 0,
        });
      } catch (error) {
        throw config.mapError?.(error) ?? error;
      }

      const pending = new Map<number, PendingCall>();
      let content = "";
      let reasoning = "";
      let reasoningField: "reasoning_content" | "reasoning" | undefined;
      let reportedUsage: Record<string, unknown> | undefined;
      let toolArgumentBytes = 0;
      try {
        for await (const raw of stream) {
          const chunk = raw as Record<string, unknown>;
          const error = chunk.error as Record<string, unknown> | undefined;
          if (error) {
            const detail = typeof error.message === "string" ? error.message : "Request failed.";
            throw new Error(`${config.provider} error${error.code ? ` (${error.code})` : ""}: ${detail}`);
          }
          if (chunk.usage && typeof chunk.usage === "object") {
            reportedUsage = chunk.usage as Record<string, unknown>;
          }
          const choice = Array.isArray(chunk.choices) ? chunk.choices[0] as Record<string, unknown> : undefined;
          const delta = choice?.delta as Record<string, unknown> | undefined;
          const thought = typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta?.reasoning === "string" ? delta.reasoning : "";
          if (thought) {
            reasoningField = typeof delta?.reasoning_content === "string" ? "reasoning_content" : "reasoning";
            reasoning += thought;
            yield { type: "reasoning_delta", text: thought };
          }
          if (typeof delta?.content === "string" && delta.content) {
            content += delta.content;
            yield { type: "text_delta", text: delta.content };
          }
          const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls as Record<string, unknown>[] : [];
          for (const part of calls) {
            const index = typeof part.index === "number" ? part.index : 0;
            const fn = part.function as Record<string, unknown> | undefined;
            const call = pending.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof part.id === "string") call.id = part.id;
            if (typeof fn?.name === "string") call.name += fn.name;
            if (typeof fn?.arguments === "string") {
              toolArgumentBytes += Buffer.byteLength(fn.arguments);
              if (toolArgumentBytes > MAX_PROVIDER_TOOL_ARGUMENT_BYTES)
                throw new Error("Provider tool calls exceeded the input limit");
              call.arguments += fn.arguments;
            }
            pending.set(index, call);
          }
        }
      } catch (error) {
        throw config.mapError?.(error) ?? error;
      }

      const nativeCalls = [...pending.entries()].sort(([a], [b]) => a - b).map(([index, call]) => ({
        id: call.id || `${config.provider.toLowerCase()}-tool-${step.iteration}-${index}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      }));
      for (const call of nativeCalls) {
        const input = JSON.parse(call.function.arguments || "{}") as unknown;
        if (!isJsonRecord(input)) throw new Error("Provider returned non-object function arguments");
        yield {
          type: "tool_call",
          call: { id: call.id, name: call.function.name, input },
        };
      }
      const assistant: CompatibleMessage = {
        role: "assistant",
        content: content || null,
        ...(reasoning && reasoningField ? { [reasoningField]: reasoning } : {}),
        ...(nativeCalls.length ? { tool_calls: nativeCalls } : {}),
      };
      if (reportedUsage) {
        yield {
          type: "usage",
          usage: normalizedUsage(reportedUsage),
          usedTokens: typeof reportedUsage.prompt_tokens === "number"
            ? reportedUsage.prompt_tokens : undefined,
        };
      }
      yield {
        type: "opaque_checkpoint",
        checkpoint: { messages: [...requestMessages, assistant] } satisfies State,
      };
      yield { type: "done" };
    },
  };
}
