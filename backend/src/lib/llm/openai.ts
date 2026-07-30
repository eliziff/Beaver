import { throwIfAborted } from "./abort";
import { requireApiKey } from "./apiKeys";
import { encodeToolV3, schemaEncodingVariant } from "./schemaEncoding";
import type {
  LlmMessage,
  NormalizedLlmUsage,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createLlmTrace } from "./rawStreamLog";

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
            | { type: "input_text"; text: string }
            | { type: "input_image"; image_url: string }
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
    error?: { code?: string; message?: string } | null;
    usage?: ResponseUsage;
  };
  error?: { code?: string; message?: string } | null;
  item?: ResponseFunctionCallItem;
};

type ResponseUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

export type ResponsesAdapterConfig = {
  endpoint: string;
  provider: string;
  apiKey: string;
  persistent: boolean;
  reasoningSummary?: boolean;
  defaultReasoningEffort?: string;
  /** Extra request headers (e.g. ChatGPT-Account-ID for the Codex backend). */
  headers?: Record<string, string>;
  /**
   * The Codex subscription backend's Responses dialect: store must be false
   * and max_output_tokens is rejected as unsupported.
   */
  codexBackend?: boolean;
};

function apiKey(override?: string | null): string {
  return requireApiKey(override, ["OPENAI_API_KEY"], "OpenAI");
}

function toResponseTools(tools: OpenAIToolSchema[]): ResponseFunctionTool[] {
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
  const maxIter = params.maxIterations ?? 10;
  const responseTools = toResponseTools(tools);
  let input = toResponseInput(params.messages);
  let previousResponseId: string | undefined;
  let fullText = "";
  let needsCourtlistenerCitationReminder = false;
  // Accumulated across tool-loop iterations; null until a response reports it.
  let usage: NormalizedLlmUsage | null = null;
  const addUsage = (reported: ResponseUsage) => {
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
  };
  const trace = createLlmTrace({ provider: config.provider, model });

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);
      let toolCalls: NormalizedToolCall[] = [];
      let outputItems: ResponseInputItem[] = [];
      let reasoningBlockOpen = false;
      let emitted = false;
      const runAttempt = async () => {
        toolCalls = [];
        outputItems = [];
        reasoningBlockOpen = false;
        emitted = false;
        const response = await createResponse({
          endpoint: config.endpoint,
          provider: config.provider,
          model,
          instructions: responseInstructions(
            systemPrompt,
            needsCourtlistenerCitationReminder,
          ),
          input,
          tools: responseTools,
          stream: true,
          previousResponseId: config.persistent ? previousResponseId : undefined,
          reasoning:
            enableThinking || params.reasoningEffort
              ? {
                  summary:
                    enableThinking && config.reasoningSummary
                      ? "auto"
                      : undefined,
                  effort:
                    params.reasoningEffort ?? config.defaultReasoningEffort,
                }
              : undefined,
          apiKey: config.apiKey,
          headers: config.headers,
          codexBackend: config.codexBackend,
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
      if (results.some((result) => result.terminal)) break;
      // The round budget is enforced silently by this loop; at halfway the
      // model gets told, so the remaining rounds are planned, not spent.
      if (results.length && iter + 1 === Math.floor(maxIter / 2)) {
        const last = results[results.length - 1];
        results[results.length - 1] = {
          ...last,
          content: `${last.content}\n\n[Tool budget: ${iter + 1} of ${maxIter} rounds used. Plan the remaining rounds to end with the final answer.]`,
        };
      }
      const resultItems: ResponseInputItem[] = results.map((result) => ({
        type: "function_call_output",
        call_id: result.tool_use_id,
        output: result.content,
      }));
      input = config.persistent
        ? resultItems
        : [...input, ...outputItems, ...resultItems];
    }

    await trace.flush("completed");
    return usage ? { fullText, usage } : { fullText };
  } catch (error) {
    await trace.flush("error", error);
    throw error;
  }
}

export async function streamOpenAI(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  return streamResponsesApi(params, {
    endpoint: OPENAI_RESPONSES_URL,
    provider: "OpenAI",
    apiKey: apiKey(params.apiKeys?.openai),
    persistent: true,
    reasoningSummary: true,
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
