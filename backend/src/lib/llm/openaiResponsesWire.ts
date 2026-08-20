import { MAX_PROVIDER_TOOL_ARGUMENT_BYTES,
  type ProviderAdapter, type ProviderEvent, type ProviderStep } from "./providerLoop";
import { runtimeConstructor } from "./runtimeSdk";
import type { LlmMessage, NormalizedLlmUsage, StreamChatParams, Tool } from "./types";

type InputItem = Record<string, unknown>;
type State = { responseId: string } | { history: InputItem[] };
type OpenAIClient = {
  responses: {
    create(
      request: Record<string, unknown>,
      options: { signal?: AbortSignal; maxRetries: number },
    ): Promise<AsyncIterable<unknown>>;
  };
};
type OpenAIConstructor = new (options: {
  apiKey: string; baseURL: string; maxRetries: number;
}) => OpenAIClient;
const openAI = runtimeConstructor<OpenAIConstructor>("openai");

type ResponsesWireConfig = {
  apiKey: string;
  baseURL: string;
  provider: string;
  persistent: boolean;
  promptCacheKey: string;
  reasoningSummary?: boolean;
  serviceTier?: string;
  nativeCompaction?: boolean;
};

const input = (messages: LlmMessage[]): InputItem[] => messages.map((message) => {
  if (message.contextCheckpoint?.provider === "openai") return message.contextCheckpoint.item;
  return {
    role: message.role,
    content: message.role === "user" && message.images?.length
      ? [
          { type: "input_text", text: message.content },
          ...message.images.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.data}`,
          })),
        ]
      : message.content,
  };
});

const wireTools = (tools: Tool[]) => tools.map((tool) => ({
  type: "function" as const,
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema,
}));

function toolCall(item: Record<string, unknown>) {
  if (typeof item.call_id !== "string" || typeof item.name !== "string" ||
      typeof item.arguments !== "string") {
    throw new Error("OpenAI returned an invalid function call");
  }
  if (Buffer.byteLength(item.arguments) > MAX_PROVIDER_TOOL_ARGUMENT_BYTES)
    throw new Error("Provider tool calls exceeded the input limit");
  const parsed = JSON.parse(item.arguments) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenAI returned non-object function arguments");
  }
  return {
    id: item.call_id,
    name: item.name,
    input: parsed as Record<string, unknown>,
  };
}

function usage(value: Record<string, unknown>): NormalizedLlmUsage {
  const inputDetails = value.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = value.output_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: typeof value.input_tokens === "number" ? value.input_tokens : null,
    outputTokens: typeof value.output_tokens === "number" ? value.output_tokens : null,
    reasoningTokens: typeof outputDetails?.reasoning_tokens === "number"
      ? outputDetails.reasoning_tokens : null,
    cacheReadInputTokens: typeof inputDetails?.cached_tokens === "number"
      ? inputDetails.cached_tokens : null,
    cacheWriteInputTokens: typeof inputDetails?.cache_write_tokens === "number"
      ? inputDetails.cache_write_tokens : null,
  };
}

function failure(event: Record<string, unknown>, provider: string): string | null {
  const response = event.response as Record<string, unknown> | undefined;
  const error = (response?.error ?? event.error) as Record<string, unknown> | undefined;
  if (event.type !== "response.failed" && response?.status !== "failed" && !error) return null;
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim() : `${provider} response failed.`;
  return typeof error?.code === "string" && error.code.trim()
    ? `${provider} error (${error.code}): ${message}` : message;
}

export function createResponsesWireAdapter(
  params: StreamChatParams,
  config: ResponsesWireConfig,
): ProviderAdapter {
  const client = openAI.then((OpenAI) =>
    new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 0 }));
  const initial = input(params.messages);
  return {
    provider: config.provider,
    async *events(step: ProviderStep): AsyncIterable<ProviderEvent> {
      const state = step.checkpoint as State | undefined;
      const resultItems = step.results.map((result) => ({
        type: "function_call_output",
        call_id: result.tool_use_id,
        output: result.content,
      }));
      const steeringItems = step.steering.map(({ text }) => ({ role: "user", content: text }));
      const additions = [...resultItems, ...steeringItems];
      const responseId = state && "responseId" in state ? state.responseId : undefined;
      if (step.iteration && config.persistent && !responseId) {
        throw new Error(`${config.provider} did not return a continuation id`);
      }
      if (step.iteration && !config.persistent && (!state || !("history" in state))) {
        throw new Error(`${config.provider} did not return continuation items`);
      }
      const requestInput = !step.iteration ? initial
        : config.persistent ? additions
        : [...(state as { history: InputItem[] }).history, ...additions];
      const reasoning = params.enableThinking || params.reasoningEffort
        ? {
            summary: params.enableThinking && config.reasoningSummary ? "auto" : undefined,
            effort: params.reasoningEffort,
          }
        : undefined;
      const stream = await (await client).responses.create({
        model: params.model,
        instructions: params.systemPrompt || undefined,
        input: requestInput,
        tools: wireTools(step.tools),
        stream: true,
        max_output_tokens: params.maxTokens ?? 16_384,
        previous_response_id: responseId,
        reasoning,
        service_tier: config.serviceTier,
        prompt_cache_key: config.promptCacheKey,
        ...(config.nativeCompaction && params.compactThreshold
          ? { context_management: [{ type: "compaction", compact_threshold: params.compactThreshold }] }
          : {}),
      }, {
        signal: step.signal,
        maxRetries: 0,
      });

      let nextResponseId: string | undefined;
      let reasoningBlock = 0;
      const output: InputItem[] = [];
      for await (const raw of stream) {
        const event = raw as unknown as Record<string, unknown>;
        const response = event.response as Record<string, unknown> | undefined;
        if (typeof response?.id === "string") nextResponseId = response.id;
        const message = failure(event, config.provider);
        if (message) throw new Error(message);
        if (
          (event.type === "response.reasoning_summary_text.delta" ||
            event.type === "response.reasoning_text.delta") &&
          typeof event.delta === "string"
        ) {
          yield { type: "reasoning_delta", text: event.delta, block: reasoningBlock };
        } else if (
          event.type === "response.reasoning_summary_text.done" ||
          event.type === "response.reasoning_text.done"
        ) {
          reasoningBlock += 1;
        } else if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          yield { type: "text_delta", text: event.delta };
        } else if (event.type === "response.output_item.added") {
          const item = event.item as InputItem | undefined;
          if (item?.type === "compaction") {
            yield { type: "opaque_checkpoint", compaction: "running" };
          }
        } else if (event.type === "response.output_item.done") {
          const item = event.item as InputItem | undefined;
          if (!item) continue;
          output.push(item);
          if (item.type === "function_call") yield { type: "tool_call", call: toolCall(item) };
          if (item.type === "compaction") {
            yield {
              type: "opaque_checkpoint",
              public: { provider: "openai", item },
              compaction: "completed",
            };
          }
        }
        if (
          ["response.completed", "response.incomplete", "response.failed"].includes(String(event.type)) &&
          (response?.usage && typeof response.usage === "object" ||
            typeof response?.service_tier === "string")
        ) {
          const reported = response.usage && typeof response.usage === "object"
            ? response.usage as Record<string, unknown> : {};
          yield {
            type: "usage",
            usage: usage(reported),
            usedTokens: typeof reported.input_tokens === "number" ? reported.input_tokens : undefined,
            serviceTier: typeof response.service_tier === "string" ? response.service_tier : undefined,
          };
        }
      }
      let checkpoint: State;
      if (config.persistent) {
        if (!nextResponseId) throw new Error(`${config.provider} did not return a response id`);
        checkpoint = { responseId: nextResponseId };
      } else {
        checkpoint = { history: [...requestInput, ...output] };
      }
      yield { type: "opaque_checkpoint", checkpoint };
      yield { type: "done" };
    },
  };
}
