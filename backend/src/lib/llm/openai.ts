import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { throwIfAborted } from "./abort";
import { requireApiKey } from "./apiKeys";
import type {
  LlmContextRoundReceipt,
  LlmMessage,
  NormalizedLlmUsage,
  NormalizedToolCall,
  Tool,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createLlmTrace } from "./rawStreamLog";
import { sha256 } from "../hash";
import { modelContextWindow } from "./contextWindow";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const MAX_OUTPUT_TOKENS = 16384;

type ResponseInputItem =
  | {
      role: "user" | "assistant";
      content:
        | string
        | (
            | {
                type: "input_text";
                text: string;
              }
            | {
                type: "input_image";
                image_url: string;
              }
          )[];
    }
  | { type: "function_call_output"; call_id: string; output: string }
  | Record<string, unknown>;

type ResponseFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

type ResponseFunctionCallItem = {
  type: "function_call";
  call_id?: string;
  name?: string;
  arguments?: string;
  [key: string]: unknown;
};

type ResponseStreamEvent = {
  type?: string;
  delta?: string;
  response?: {
    id?: string;
    output_text?: string;
    status?: string;
    service_tier?: string;
    error?: { code?: string; message?: string } | null;
    usage?: ResponseUsage;
  };
  error?: { code?: string; message?: string } | null;
  item?: ResponseFunctionCallItem | Record<string, unknown>;
};

type ResponseUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: { reasoning_tokens?: number };
};

export type ResponsesAdapterConfig = {
  baseURL: string;
  provider: string;
  apiKey: string;
  persistent: boolean;
  reasoningSummary?: boolean;
  defaultReasoningEffort?: string;
  /** Provider request value, after host-side capability validation. */
  serviceTier?: string;
  /** This endpoint implements Responses `context_management.compaction`. */
  nativeCompaction?: boolean;
};

function apiKey(override?: string | null): string {
  return requireApiKey(override, ["OPENAI_API_KEY"], "OpenAI");
}

export function toResponseTools(
  tools: Tool[],
): ResponseFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function toResponseInput(messages: LlmMessage[]): ResponseInputItem[] {
  return messages.map((message) => {
    if (message.contextCheckpoint?.provider === "openai") {
      return message.contextCheckpoint.item;
    }
    if (!message.images?.length || message.role !== "user") {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [
        { type: "input_text", text: message.content },
        ...message.images.map((image) => ({
          type: "input_image" as const,
          image_url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
    };
  });
}

function parseFunctionCall(item: ResponseFunctionCallItem): NormalizedToolCall {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(item.arguments || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    input = {};
  }

  return {
    id: item.call_id ?? item.name ?? "function_call",
    name: item.name ?? "",
    input,
  };
}

function openAIStreamFailureMessage(event: ResponseStreamEvent): string | null {
  const error = event.response?.error ?? event.error ?? null;
  const failed =
    event.type === "response.failed" ||
    event.response?.status === "failed" ||
    !!error;
  if (!failed) return null;

  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : "OpenAI response failed.";
  const code =
    typeof error?.code === "string" && error.code.trim()
      ? error.code.trim()
      : null;
  return code ? `OpenAI error (${code}): ${message}` : message;
}


export async function streamResponsesApi(
  params: StreamChatParams,
  config: ResponsesAdapterConfig,
): Promise<StreamChatResult> {
  const {
    model,
    systemPrompt,
    tools = [],
    callbacks = {},
    runTools,
    enableThinking,
  } = params;
  const maxIter = params.maxIterations;
  // Recomputed per iteration when `resolveTools` is supplied: a tool revealed
  // by a discovery call in iteration N must be callable in iteration N+1.
  let responseTools = toResponseTools(tools);
  let input = toResponseInput(params.messages);
  let previousResponseId: string | undefined;
  let fullText = "";
  let reportedServiceTier: string | undefined;
  const contextRounds: LlmContextRoundReceipt[] = [];
  const promptCacheKey = params.promptCacheKey?.trim() || randomUUID();
  const promptCacheKeySha256 = sha256(promptCacheKey);
  let activeRound: LlmContextRoundReceipt | null = null;
  // Accumulated across tool-loop iterations; null until a response reports it.
  let usage: NormalizedLlmUsage | null = null;
  const addUsage = (
    reported: ResponseUsage,
    round: LlmContextRoundReceipt | null = activeRound,
  ) => {
    // An all-zero report is "not reported", not a free request.
    if (!reported.input_tokens && !reported.output_tokens) return;
    usage ??= {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: null,
    };
    usage.inputTokens = (usage.inputTokens ?? 0) + (reported.input_tokens ?? 0);
    usage.outputTokens =
      (usage.outputTokens ?? 0) + (reported.output_tokens ?? 0);
    usage.reasoningTokens =
      (usage.reasoningTokens ?? 0) +
      (reported.output_tokens_details?.reasoning_tokens ?? 0);
    usage.cacheReadInputTokens =
      (usage.cacheReadInputTokens ?? 0) +
      (reported.input_tokens_details?.cached_tokens ?? 0);
    const cacheWrite = reported.input_tokens_details?.cache_write_tokens;
    if (cacheWrite != null) {
      usage.cacheWriteInputTokens =
        (usage.cacheWriteInputTokens ?? 0) + cacheWrite;
    }
    if (round) {
      round.usage.inputTokens =
        (round.usage.inputTokens ?? 0) + (reported.input_tokens ?? 0);
      round.usage.outputTokens =
        (round.usage.outputTokens ?? 0) + (reported.output_tokens ?? 0);
      round.usage.reasoningTokens =
        (round.usage.reasoningTokens ?? 0) +
        (reported.output_tokens_details?.reasoning_tokens ?? 0);
      round.usage.cacheReadInputTokens =
        (round.usage.cacheReadInputTokens ?? 0) +
        (reported.input_tokens_details?.cached_tokens ?? 0);
      if (cacheWrite != null) {
        round.usage.cacheWriteInputTokens =
          (round.usage.cacheWriteInputTokens ?? 0) + cacheWrite;
      }
    }
  };
  const trace = createLlmTrace({ provider: config.provider, model });
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
  });

  try {
    for (let iter = 0; maxIter === undefined || iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);
      if (params.resolveTools) responseTools = toResponseTools(params.resolveTools());
      const instructions = systemPrompt;
      const reasoning =
        enableThinking || params.reasoningEffort
          ? {
              summary:
                enableThinking && config.reasoningSummary ? "auto" as const : undefined,
              effort: params.reasoningEffort ?? config.defaultReasoningEffort,
            }
          : undefined;
      const inputJson = JSON.stringify(input);
      const toolsJson = JSON.stringify(responseTools);
      activeRound = {
        iteration: iter,
        requestAttempts: 0,
        continuation: config.persistent && previousResponseId ? "provider" : "none",
        instructionsBytes: Buffer.byteLength(instructions),
        instructionsSha256: sha256(instructions),
        inputItems: input.length,
        inputBytes: Buffer.byteLength(inputJson),
        inputSha256: sha256(inputJson),
        toolCount: responseTools.length,
        toolBytes: Buffer.byteLength(toolsJson),
        toolSha256: sha256(toolsJson),
        toolCallCount: 0,
        toolArgumentBytes: 0,
        toolResultBytes: 0,
        usage: {
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          cacheReadInputTokens: null,
          cacheWriteInputTokens: null,
        },
      };
      contextRounds.push(activeRound);
      let toolCalls: NormalizedToolCall[] = [];
      let outputItems: ResponseInputItem[] = [];
      let reasoningBlockOpen = false;
      let emitted = false;
      const runAttempt = async () => {
        if (activeRound) activeRound.requestAttempts += 1;
        toolCalls = [];
        outputItems = [];
        reasoningBlockOpen = false;
        emitted = false;
        const stream = await client.responses.create({
          model,
          max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
          instructions: instructions || undefined,
          input: input as OpenAI.Responses.ResponseInput,
          tools: responseTools as OpenAI.Responses.Tool[],
          stream: true,
          previous_response_id:
            config.persistent ? previousResponseId : undefined,
          reasoning: reasoning as OpenAI.Responses.ResponseCreateParams["reasoning"],
          service_tier:
            config.serviceTier as OpenAI.Responses.ResponseCreateParams["service_tier"],
          prompt_cache_key: promptCacheKey,
          ...(config.nativeCompaction && params.compactThreshold
            ? {
                context_management: [{
                  type: "compaction",
                  compact_threshold: params.compactThreshold,
                }],
              }
            : {}),
        }, {
          signal: params.abortSignal,
          maxRetries: 0,
        });

        for await (const rawEvent of stream) {
          throwIfAborted(params.abortSignal);
          const event = rawEvent as ResponseStreamEvent;
            trace.record({ iteration: iter, label: "sse_event", payload: event });

            if (
              typeof event.response?.service_tier === "string" &&
              event.response.service_tier.trim()
            ) {
              reportedServiceTier = event.response.service_tier.trim();
            }

            if (config.persistent && event.response?.id) {
              previousResponseId = event.response.id;
            }

            if (
              (event.type === "response.completed" ||
                event.type === "response.incomplete" ||
                event.type === "response.failed") &&
              event.response?.usage
            ) {
              addUsage(event.response.usage);
              const contextWindowTokens = modelContextWindow(model);
              if (contextWindowTokens) {
                callbacks.onContextUsage?.({
                  usedTokens: event.response.usage.input_tokens ?? 0,
                  contextWindowTokens,
                });
              }
            }

            if (
              event.type === "response.output_item.added" &&
              event.item?.type === "compaction"
            ) {
              callbacks.onCompaction?.("running");
            }

            const failureMessage = openAIStreamFailureMessage(event);
            if (failureMessage) {
              throw new Error(failureMessage);
            }

            if (
              (event.type === "response.reasoning_summary_text.delta" ||
                event.type === "response.reasoning_text.delta") &&
              typeof event.delta === "string"
            ) {
              reasoningBlockOpen = true;
              emitted = true;
              callbacks.onReasoningDelta?.(event.delta);
            }

            if (
              (event.type === "response.reasoning_summary_text.done" ||
                event.type === "response.reasoning_text.done") &&
              reasoningBlockOpen
            ) {
              reasoningBlockOpen = false;
              callbacks.onReasoningBlockEnd?.();
            }

            if (
              event.type === "response.output_text.delta" &&
              typeof event.delta === "string"
            ) {
              fullText += event.delta;
              emitted = true;
              callbacks.onContentDelta?.(event.delta);
            }

            if (
              event.type === "response.output_item.done" &&
              event.item
            ) {
              outputItems.push(event.item);
              if (event.item.type === "compaction") {
                callbacks.onContextCheckpoint?.({
                  provider: "openai",
                  item: event.item,
                });
                callbacks.onCompaction?.("completed");
              }
              if (event.item.type === "function_call") {
                const call = parseFunctionCall(
                  event.item as ResponseFunctionCallItem,
                );
                emitted = true;
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
              }
            }
        }
      };

      // Retry upstream capacity failures only before output reaches the
      // caller; replaying emitted deltas would duplicate output.
      let overloadAttempts = 0;
      for (;;) {
        const checkpointResponseId = previousResponseId;
        try {
          await runAttempt();
          break;
        } catch (error) {
          const overloaded =
            overloadAttempts < 2 &&
            !emitted &&
            error instanceof Error &&
            error.message.includes("server_is_overloaded");
          if (!overloaded) throw error;
          overloadAttempts += 1;
          previousResponseId = checkpointResponseId;
          trace.record({
            iteration: iter,
            label: "overload_retry",
            payload: { attempt: overloadAttempts },
          });
          await new Promise((resolve) =>
            setTimeout(resolve, 20_000 * overloadAttempts),
          );
          throwIfAborted(params.abortSignal);
        }
      }

      if (reasoningBlockOpen) callbacks.onReasoningBlockEnd?.();
      throwIfAborted(params.abortSignal);

      const results = toolCalls.length && runTools
        ? await runTools(toolCalls)
        : [];
      throwIfAborted(params.abortSignal);
      activeRound.toolCallCount = toolCalls.length;
      activeRound.toolArgumentBytes = toolCalls.reduce(
        (total, call) => total + Buffer.byteLength(JSON.stringify(call.input)),
        0,
      );
      activeRound.toolResultBytes = results.reduce(
        (total, result) => total + Buffer.byteLength(result.content),
        0,
      );
      if (results.some((result) => result.terminal)) break;
      const steering = params.takeSteering?.() ?? [];
      if (!results.length && !steering.length) break;
      const resultItems: ResponseInputItem[] = results.map((result) => ({
        type: "function_call_output",
        call_id: result.tool_use_id,
        output: result.content,
      }));
      const steeringItems: ResponseInputItem[] = steering.map(({ text }) => ({
        role: "user",
        content: text,
      }));
      const nextInput = config.persistent
        ? [...resultItems, ...steeringItems]
        : [
            ...input,
            ...outputItems,
            ...resultItems,
            ...steeringItems,
          ];
      input = nextInput;
    }

    await trace.flush("completed");
    return {
      fullText,
      ...(usage ? { usage } : {}),
      ...(reportedServiceTier ? { serviceTier: reportedServiceTier } : {}),
      contextRounds,
      promptCacheKeySha256,
    };
  } catch (error) {
    await trace.flush("error", error);
    throw error;
  }
}

export async function streamOpenAI(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const requestedTier = params.serviceTier?.trim().toLowerCase();
  return streamResponsesApi(params, {
    baseURL: OPENAI_BASE_URL,
    provider: "OpenAI",
    apiKey: apiKey(params.apiKeys?.openai),
    persistent: true,
    reasoningSummary: true,
    nativeCompaction: true,
    ...(requestedTier
      ? { serviceTier: requestedTier === "fast" ? "priority" : requestedTier }
      : {}),
  });
}
