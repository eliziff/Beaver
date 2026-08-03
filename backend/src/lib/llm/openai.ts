import { randomUUID } from "node:crypto";
import { throwIfAborted } from "./abort";
import { requireApiKey } from "./apiKeys";
import { encodeToolV3, schemaEncodingVariant } from "./schemaEncoding";
import type {
  LlmCompactionReceipt,
  LlmContextRoundReceipt,
  LlmMessage,
  NormalizedLlmUsage,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createLlmTrace } from "./rawStreamLog";
import { sha256 } from "../hash";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS = 16384;
const COURTLISTENER_CITATION_REMINDER_TOOL_NAMES = new Set([
  "courtlistener_find_in_case",
  "courtlistener_read_case",
]);
const COURTLISTENER_CITATION_REMINDER = `COURTLISTENER CITATION REMINDER:
If your final answer relies on any CourtListener case, add an inline [N] marker. Do not construct a CourtListener link; Beaver attaches the verified link server-side.
Assign new refs in first-use order as much as possible: [1], then [2], then [3]. Reuse an existing ref when citing the same case/passage again, even if that means a later sentence cites [3] and then [1] again.
End the response with a <CITATIONS> block containing one matching case entry per [N] marker:
{"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact verbatim opinion text"}]}.
Do not use doc_id, page, top-level quote, case_name, or citation fields for CourtListener case entries.`;

type ResponseInputItem =
  | {
      role: "user" | "assistant";
      content:
        | string
        | (
            | {
                type: "input_text";
                text: string;
                prompt_cache_breakpoint?: { mode: "explicit" };
              }
            | {
                type: "input_image";
                image_url: string;
                prompt_cache_breakpoint?: { mode: "explicit" };
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
  item?: ResponseFunctionCallItem;
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
  endpoint: string;
  provider: string;
  apiKey: string;
  persistent: boolean;
  reasoningSummary?: boolean;
  defaultReasoningEffort?: string;
  /** Provider request value, after host-side capability validation. */
  serviceTier?: string;
  /** Extra request headers (e.g. ChatGPT-Account-ID for the Codex backend). */
  headers?: Record<string, string>;
  /** Optional native `/responses/compact` endpoint for explicit-history transports. */
  remoteCompactionEndpoint?: string;
  /**
   * The Codex subscription backend's Responses dialect: store must be false
   * and max_output_tokens is rejected as unsupported.
   */
  codexBackend?: boolean;
  /** GPT-5.6+ explicit prefix caching for stateless Codex tool loops. */
  explicitPromptCaching?: boolean;
};

const CACHE_CONTINUATION = "Continue from the tool results.";

function markCacheBreakpoint(items: ResponseInputItem[]): ResponseInputItem[] {
  const marked = [...items];
  for (let index = marked.length - 1; index >= 0; index--) {
    const item = marked[index] as {
      role?: string;
      content?: string | Array<Record<string, unknown>>;
    };
    if (!item.role || item.content === undefined) continue;
    const content =
      typeof item.content === "string"
        ? [{ type: "input_text", text: item.content }]
        : item.content.map((block) => ({ ...block }));
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      if (content[blockIndex].type === "input_text" || content[blockIndex].type === "input_image") {
        content[blockIndex].prompt_cache_breakpoint = { mode: "explicit" };
        marked[index] = { ...item, content } as ResponseInputItem;
        return marked;
      }
    }
  }
  return marked;
}

function cacheBoundaryItem(): ResponseInputItem {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text: CACHE_CONTINUATION,
        prompt_cache_breakpoint: { mode: "explicit" },
      },
    ],
  };
}

function cachePrefixReceipt(input: ResponseInputItem[]) {
  let count = 0;
  let last = -1;
  input.forEach((item, index) => {
    if (
      "content" in item &&
      Array.isArray(item.content) &&
      item.content.some((block) => block.prompt_cache_breakpoint?.mode === "explicit")
    ) {
      count += 1;
      last = index;
    }
  });
  if (last < 0) return { count: 0, bytes: 0, sha256: undefined };
  const prefix = JSON.stringify(input.slice(0, last + 1));
  return {
    count,
    bytes: Buffer.byteLength(prefix),
    sha256: sha256(prefix),
  };
}

function apiKey(override?: string | null): string {
  return requireApiKey(override, ["OPENAI_API_KEY"], "OpenAI");
}

export function toResponseTools(
  tools: OpenAIToolSchema[],
): ResponseFunctionTool[] {
  if (schemaEncodingVariant() === "v3") {
    return tools.map((tool) => ({ type: "function", ...encodeToolV3(tool) }));
  }
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    ...(tool.function.strict === undefined
      ? {}
      : { strict: tool.function.strict }),
  }));
}

export function toResponseInput(messages: LlmMessage[]): ResponseInputItem[] {
  return messages.map((message) => {
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

function extractSseJson(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";

  for (const chunk of chunks) {
    const dataLines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    for (const data of dataLines) {
      if (!data || data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        // Incomplete events stay buffered until the next read.
      }
    }
  }

  return { events, rest };
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


function responseInstructions(systemPrompt: string, includeReminder: boolean) {
  return includeReminder
    ? `${systemPrompt}\n\n${COURTLISTENER_CITATION_REMINDER}`
    : systemPrompt;
}

function shouldAppendCourtlistenerCitationReminder(call: NormalizedToolCall) {
  return COURTLISTENER_CITATION_REMINDER_TOOL_NAMES.has(call.name);
}

async function createResponse(params: {
  endpoint?: string;
  provider?: string;
  model: string;
  input: ResponseInputItem[];
  instructions?: string;
  tools?: ResponseFunctionTool[];
  stream?: boolean;
  maxTokens?: number;
  previousResponseId?: string;
  reasoning?: { summary?: "auto"; effort?: string };
  serviceTier?: string;
  compactThreshold?: number;
  promptCacheKey?: string;
  promptCacheOptions?: { mode: "explicit" };
  apiKey: string;
  headers?: Record<string, string>;
  codexBackend?: boolean;
  signal?: AbortSignal;
}): Promise<Response> {
  const response = await fetch(params.endpoint ?? OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify({
      model: params.model,
      instructions: params.instructions || undefined,
      input: params.input,
      tools: params.tools?.length ? params.tools : undefined,
      stream: params.stream,
      ...(params.codexBackend
        ? { store: false }
        : { max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS }),
      previous_response_id: params.previousResponseId,
      reasoning: params.reasoning,
      service_tier: params.serviceTier,
      prompt_cache_key: params.promptCacheKey,
      prompt_cache_options: params.promptCacheOptions,
      ...(!params.codexBackend && params.compactThreshold
        ? {
            context_management: [
              {
                type: "compaction",
                compact_threshold: params.compactThreshold,
              },
            ],
          }
        : {}),
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const provider = params.provider ?? "OpenAI";
    const err = new Error(
      `${provider} request failed (${response.status}): ${text || response.statusText}`,
    );
    (err as { status?: number }).status = response.status;
    throw err;
  }

  return response;
}

async function createCompactResponse(params: {
  endpoint: string;
  provider?: string;
  model: string;
  input: ResponseInputItem[];
  instructions?: string;
  tools?: ResponseFunctionTool[];
  reasoning?: { summary?: "auto"; effort?: string };
  serviceTier?: string;
  promptCacheKey?: string;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ output: ResponseInputItem[]; usage?: ResponseUsage }> {
  const response = await fetch(params.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify({
      model: params.model,
      input: params.input,
      instructions: params.instructions || undefined,
      tools: params.tools?.length ? params.tools : undefined,
      parallel_tool_calls: true,
      reasoning: params.reasoning,
      service_tier: params.serviceTier,
      prompt_cache_key: params.promptCacheKey,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const provider = params.provider ?? "OpenAI";
    const err = new Error(
      `${provider} compaction failed (${response.status}): ${text || response.statusText}`,
    );
    (err as { status?: number }).status = response.status;
    throw err;
  }

  const payload = (await response.json()) as {
    output?: unknown;
    usage?: ResponseUsage;
  };
  if (!Array.isArray(payload.output)) {
    throw new Error(`${params.provider ?? "OpenAI"} compaction returned no output`);
  }
  return {
    output: payload.output as ResponseInputItem[],
    ...(payload.usage ? { usage: payload.usage } : {}),
  };
}

function normalizedUsage(reported?: ResponseUsage): NormalizedLlmUsage {
  return {
    inputTokens: reported?.input_tokens ?? null,
    outputTokens: reported?.output_tokens ?? null,
    reasoningTokens: reported?.output_tokens_details?.reasoning_tokens ?? null,
    cacheReadInputTokens:
      reported?.input_tokens_details?.cached_tokens ?? null,
    cacheWriteInputTokens:
      reported?.input_tokens_details?.cache_write_tokens ?? null,
  };
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
  if (config.explicitPromptCaching) input = markCacheBreakpoint(input);
  let previousResponseId: string | undefined;
  let fullText = "";
  let reportedServiceTier: string | undefined;
  let needsCourtlistenerCitationReminder = false;
  const contextRounds: LlmContextRoundReceipt[] = [];
  const compactions: LlmCompactionReceipt[] = [];
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

  try {
    for (let iter = 0; maxIter === undefined || iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);
      if (params.resolveTools) responseTools = toResponseTools(params.resolveTools());
      const instructions = responseInstructions(
        systemPrompt,
        needsCourtlistenerCitationReminder,
      );
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
      const cachePrefix = cachePrefixReceipt(input);
      activeRound = {
        iteration: iter,
        requestAttempts: 0,
        continuation: config.persistent && previousResponseId ? "provider" : "none",
        instructionsBytes: Buffer.byteLength(instructions),
        instructionsSha256: sha256(instructions),
        inputItems: input.length,
        inputBytes: Buffer.byteLength(inputJson),
        inputSha256: sha256(inputJson),
        ...(config.explicitPromptCaching
          ? {
              cacheBreakpointCount: cachePrefix.count,
              cachePrefixBytes: cachePrefix.bytes,
              ...(cachePrefix.sha256
                ? { cachePrefixSha256: cachePrefix.sha256 }
                : {}),
            }
          : {}),
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
        const response = await createResponse({
          endpoint: config.endpoint,
          provider: config.provider,
          model,
          instructions,
          input,
          tools: responseTools,
          stream: true,
          previousResponseId: config.persistent ? previousResponseId : undefined,
          reasoning,
          apiKey: config.apiKey,
          headers: config.headers,
          codexBackend: config.codexBackend,
          serviceTier: config.serviceTier,
          compactThreshold: params.compactThreshold,
          promptCacheKey,
          promptCacheOptions: config.explicitPromptCaching
            ? { mode: "explicit" }
            : undefined,
          signal: params.abortSignal,
        });
        if (!response.body) throw new Error("OpenAI response had no body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          throwIfAborted(params.abortSignal);
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const extracted = extractSseJson(buffer);
          buffer = extracted.rest;

          for (const event of extracted.events as ResponseStreamEvent[]) {
            trace.record({ iteration: iter, label: "sse_event", payload: event });

            if (
              typeof event.response?.service_tier === "string" &&
              event.response.service_tier.trim()
            ) {
              reportedServiceTier = event.response.service_tier.trim();
            }

            const failureMessage = openAIStreamFailureMessage(event);
            if (failureMessage) {
              throw new Error(failureMessage);
            }

            if (config.persistent && event.response?.id) {
              previousResponseId = event.response.id;
            }

            if (
              (event.type === "response.completed" ||
                event.type === "response.incomplete") &&
              event.response?.usage
            ) {
              addUsage(event.response.usage);
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
              if (event.item.type === "function_call") {
                const call = parseFunctionCall(event.item);
                emitted = true;
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
              }
            }
          }
        }
      };

      // server_is_overloaded is upstream capacity, not a request defect —
      // it killed five benchmark turns in one day. Retry the attempt only
      // while nothing from it reached the caller; a replay after emitted
      // deltas would duplicate output.
      for (let attempt = 0; ; attempt++) {
        const checkpointResponseId = previousResponseId;
        try {
          await runAttempt();
          break;
        } catch (error) {
          const retryable =
            attempt < 2 &&
            !emitted &&
            error instanceof Error &&
            error.message.includes("server_is_overloaded");
          if (!retryable) throw error;
          previousResponseId = checkpointResponseId;
          trace.record({
            iteration: iter,
            label: "overload_retry",
            payload: { attempt: attempt + 1 },
          });
          await new Promise((resolve) =>
            setTimeout(resolve, 20_000 * (attempt + 1)),
          );
          throwIfAborted(params.abortSignal);
        }
      }

      if (reasoningBlockOpen) callbacks.onReasoningBlockEnd?.();
      throwIfAborted(params.abortSignal);

      if (!toolCalls.length || !runTools) {
        break;
      }

      if (toolCalls.some(shouldAppendCourtlistenerCitationReminder)) {
        needsCourtlistenerCitationReminder = true;
      }

      const results = await runTools(toolCalls);
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
      const resultItems: ResponseInputItem[] = results.map((result) => ({
        type: "function_call_output",
        call_id: result.tool_use_id,
        output: result.content,
      }));
      const nextInput = config.persistent
        ? resultItems
        : [
            ...input,
            ...outputItems,
            ...resultItems,
            ...(config.explicitPromptCaching ? [cacheBoundaryItem()] : []),
          ];
      const compactThreshold = params.compactThreshold;
      const triggerInputTokens = activeRound?.usage.inputTokens ?? 0;
      if (
        config.remoteCompactionEndpoint &&
        compactThreshold &&
        triggerInputTokens >= compactThreshold
      ) {
        const compactTools = params.resolveTools
          ? toResponseTools(params.resolveTools())
          : responseTools;
        const requestInputJson = JSON.stringify(nextInput);
        const requestToolsJson = JSON.stringify(compactTools);
        const requestInputBytes = Buffer.byteLength(requestInputJson);
        const requestInstructionsBytes = Buffer.byteLength(instructions);
        const requestToolBytes = Buffer.byteLength(requestToolsJson);
        const compactStarted = performance.now();
        const compacted = await createCompactResponse({
          endpoint: config.remoteCompactionEndpoint,
          provider: config.provider,
          model,
          input: nextInput,
          instructions,
          tools: compactTools,
          reasoning,
          serviceTier: config.serviceTier,
          promptCacheKey,
          apiKey: config.apiKey,
          headers: config.headers,
          signal: params.abortSignal,
        });
        const outputJson = JSON.stringify(compacted.output);
        const receipt: LlmCompactionReceipt = {
          iteration: iter,
          thresholdTokens: compactThreshold,
          triggerInputTokens,
          requestInputItems: nextInput.length,
          requestInputBytes,
          requestInputSha256: sha256(requestInputJson),
          requestInstructionsBytes,
          requestInstructionsSha256: sha256(instructions),
          requestToolCount: compactTools.length,
          requestToolBytes,
          requestToolSha256: sha256(requestToolsJson),
          outputItems: compacted.output.length,
          outputBytes: Buffer.byteLength(outputJson),
          outputSha256: sha256(outputJson),
          estimatedInputTokens: Math.ceil(
            (requestInputBytes + requestInstructionsBytes + requestToolBytes) / 4,
          ),
          estimatedOutputTokens: Math.ceil(Buffer.byteLength(outputJson) / 4),
          latencyMs: performance.now() - compactStarted,
          usage: normalizedUsage(compacted.usage),
        };
        compactions.push(receipt);
        if (compacted.usage) addUsage(compacted.usage, null);
        trace.record({
          iteration: iter,
          label: "compaction",
          payload: receipt,
        });
        input = compacted.output;
      } else {
        input = nextInput;
      }
    }

    await trace.flush("completed");
    return {
      fullText,
      ...(usage ? { usage } : {}),
      ...(reportedServiceTier ? { serviceTier: reportedServiceTier } : {}),
      contextRounds,
      compactions,
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
    endpoint: OPENAI_RESPONSES_URL,
    provider: "OpenAI",
    apiKey: apiKey(params.apiKeys?.openai),
    persistent: true,
    reasoningSummary: true,
    ...(requestedTier
      ? { serviceTier: requestedTier === "fast" ? "priority" : requestedTier }
      : {}),
  });
}

export async function completeResponsesText(
  params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
  },
  config: Pick<
    ResponsesAdapterConfig,
    "endpoint" | "provider" | "apiKey"
  >,
): Promise<string> {
  const response = await createResponse({
    endpoint: config.endpoint,
    provider: config.provider,
    model: params.model,
    instructions: params.systemPrompt,
    input: [{ role: "user", content: params.user }],
    maxTokens: params.maxTokens ?? 512,
    apiKey: config.apiKey,
  });
  const json = (await response.json()) as {
    output_text?: string;
    output?: {
      content?: { type?: string; text?: string }[];
    }[];
  };

  if (typeof json.output_text === "string") return json.output_text;

  return (
    json.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content) => content.type === "output_text")
      .map((content) => content.text ?? "")
      .join("") ?? ""
  );
}

export async function completeOpenAIText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { openai?: string | null };
}): Promise<string> {
  return completeResponsesText(params, {
    endpoint: OPENAI_RESPONSES_URL,
    provider: "OpenAI",
    apiKey: apiKey(params.apiKeys?.openai),
  });
}

export type { NormalizedToolResult };
