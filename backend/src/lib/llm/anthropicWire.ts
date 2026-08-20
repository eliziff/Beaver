import { MAX_PROVIDER_TOOL_ARGUMENT_BYTES,
  type ProviderAdapter, type ProviderEvent, type ProviderStep } from "./providerLoop";
import { runtimeConstructor } from "./runtimeSdk";
import type { LlmMessage, NormalizedLlmUsage, StreamChatParams, Tool } from "./types";

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: string | Block[] };
type State = { messages: Message[] };
type AnthropicClient = {
  messages: {
    create(
      request: Record<string, unknown>,
      options: { signal?: AbortSignal; maxRetries: number },
    ): Promise<AsyncIterable<unknown>>;
  };
  beta: {
    messages: {
      create(
        request: Record<string, unknown>,
        options: { signal?: AbortSignal; maxRetries: number },
      ): Promise<AsyncIterable<unknown>>;
    };
  };
};
type AnthropicConstructor = new (options: {
  apiKey: string; baseURL: string; maxRetries: number;
}) => AnthropicClient;
const anthropic = runtimeConstructor<AnthropicConstructor>("@anthropic-ai/sdk");

const tools = (source: Tool[]) => source.map((tool) => ({
  name: tool.name,
  description: tool.description ?? "",
  input_schema: tool.inputSchema,
}));

function messages(source: LlmMessage[], nativeCompaction: boolean): Message[] {
  return source.map((message) => ({
    role: message.role,
    content: nativeCompaction && message.contextCheckpoint?.provider === "claude"
      ? [message.contextCheckpoint.block]
      : message.role === "user" && message.images?.length
        ? [
            { type: "text", text: message.content },
            ...message.images.map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.data },
            })),
          ]
        : message.content,
  }));
}

function failure(event: Record<string, unknown>): string | null {
  const error = event.error as Record<string, unknown> | undefined;
  if (event.type !== "error" || !error) return null;
  const message = typeof error.message === "string" && error.message.trim()
    ? error.message.trim() : "Claude stream failed.";
  return typeof error.type === "string" && error.type.trim()
    ? `Claude error (${error.type}): ${message}` : `Claude error: ${message}`;
}

function providerError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("Claude error")) return error;
  return new Error(`Claude error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

export function createAnthropicWireAdapter(
  params: StreamChatParams,
  apiKey: string,
  nativeCompaction: boolean,
): ProviderAdapter {
  const client = anthropic.then((Anthropic) =>
    new Anthropic({ apiKey, baseURL: "https://api.anthropic.com", maxRetries: 0 }));
  const initial = messages(params.messages, nativeCompaction);
  return {
    provider: "claude",
    async *events(step: ProviderStep): AsyncIterable<ProviderEvent> {
      const state = step.iteration ? step.checkpoint as State | undefined : { messages: initial };
      if (!state) throw new Error("Claude did not return continuation state");
      const requestMessages = [...state.messages];
      if (step.results.length || step.steering.length) {
        requestMessages.push({
          role: "user",
          content: [
            ...step.results.map((result) => ({
              type: "tool_result",
              tool_use_id: result.tool_use_id,
              content: result.content,
            })),
            ...step.steering.map(({ text }) => ({ type: "text", text })),
          ],
        });
      }
      const body = {
        model: params.model,
        system: params.systemPrompt,
        messages: requestMessages,
        tools: tools(step.tools),
        max_tokens: params.maxTokens ?? 16_384,
        stream: true,
        ...(params.enableThinking
          ? { thinking: { type: "adaptive" }, output_config: { effort: "high" } }
          : {}),
      };
      let stream: AsyncIterable<unknown>;
      try {
        stream = params.compactThreshold && nativeCompaction
          ? await (await client).beta.messages.create({
              ...body,
              betas: ["compact-2026-01-12"],
              context_management: {
                edits: [{
                  type: "compact_20260112",
                  instructions: "Summarize the transcript for continuing the task. Preserve user constraints, decisions, exact identifiers, unfinished work, and next steps. Do not call tools; return text only.",
                  trigger: { type: "input_tokens", value: Math.max(50_000, params.compactThreshold) },
                }],
              },
            }, { signal: step.signal, maxRetries: 0 })
          : await (await client).messages.create(body, {
              signal: step.signal,
              maxRetries: 0,
            });
      } catch (error) {
        throw providerError(error);
      }

      const blocks = new Map<number, Block>();
      const argumentsByBlock = new Map<number, string>();
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let cacheRead: number | null = null;
      let cacheWrite: number | null = null;
      try {
        for await (const raw of stream) {
          const event = raw as Record<string, unknown>;
          const message = failure(event);
          if (message) throw new Error(message);
          const index = typeof event.index === "number" ? event.index : -1;
          if (event.type === "message_start") {
            const usage = (event.message as Record<string, unknown> | undefined)?.usage as
              Record<string, unknown> | undefined;
            inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : inputTokens;
            cacheRead = typeof usage?.cache_read_input_tokens === "number"
              ? usage.cache_read_input_tokens : cacheRead;
            cacheWrite = typeof usage?.cache_creation_input_tokens === "number"
              ? usage.cache_creation_input_tokens : cacheWrite;
          } else if (event.type === "content_block_start" && index >= 0) {
            const block = { ...event.content_block as Block };
            blocks.set(index, block);
            if (block.type === "compaction") {
              yield { type: "opaque_checkpoint", compaction: "running" };
            }
          } else if (event.type === "content_block_delta" && index >= 0) {
            const block = blocks.get(index);
            if (!block) throw new Error("Claude returned a delta before its content block");
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              block.text = String(block.text ?? "") + delta.text;
              yield { type: "text_delta", text: delta.text, block: index };
            } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              block.thinking = String(block.thinking ?? "") + delta.thinking;
              yield { type: "reasoning_delta", text: delta.thinking, block: index };
            } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
              block.signature = String(block.signature ?? "") + delta.signature;
            } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              const argumentsJson = (argumentsByBlock.get(index) ?? "") + delta.partial_json;
              if (Buffer.byteLength(argumentsJson) > MAX_PROVIDER_TOOL_ARGUMENT_BYTES)
                throw new Error("Provider tool calls exceeded the input limit");
              argumentsByBlock.set(index, argumentsJson);
            } else if (delta?.type === "compaction_delta" && typeof delta.content === "string") {
              block.content = String(block.content ?? "") + delta.content;
            }
            blocks.set(index, block);
          } else if (event.type === "content_block_stop" && index >= 0) {
            const block = blocks.get(index);
            if (block?.type === "tool_use") {
              const rawInput = argumentsByBlock.has(index)
                ? JSON.parse(argumentsByBlock.get(index) as string)
                : block.input;
              if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput) ||
                  typeof block.id !== "string" || typeof block.name !== "string") {
                throw new Error("Claude returned an invalid tool call");
              }
              const input = rawInput as Record<string, unknown>;
              block.input = input;
              yield {
                type: "tool_call",
                call: { id: block.id, name: block.name, input },
              };
            } else if (block?.type === "compaction") {
              yield {
                type: "opaque_checkpoint",
                public: {
                  provider: "claude",
                  content: String(block.content ?? ""),
                  block,
                },
                compaction: "completed",
              };
            }
          } else if (event.type === "message_delta") {
            const usage = event.usage as Record<string, unknown> | undefined;
            outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : outputTokens;
          }
        }
      } catch (error) {
        throw providerError(error);
      }

      const reported: NormalizedLlmUsage = {
        inputTokens,
        outputTokens,
        reasoningTokens: null,
        cacheReadInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
      };
      if (Object.values(reported).some((value) => value !== null)) {
        yield { type: "usage", usage: reported, usedTokens: inputTokens ?? undefined };
      }
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
      yield {
        type: "opaque_checkpoint",
        checkpoint: { messages: [...requestMessages, { role: "assistant", content }] } satisfies State,
      };
      yield { type: "done" };
    },
  };
}
