import { abortError, throwIfAborted } from "./abort";
import { modelContextWindow } from "./contextWindow";
import type { LlmContextRoundReceipt, NormalizedLlmUsage, NormalizedToolCall, NormalizedToolResult, ProviderContextCheckpoint, SteeringMessage, StreamChatParams, StreamChatResult, Tool } from "./types";

export type ProviderEvent =
  | { type: "text_delta"; text: string; block?: string | number }
  | { type: "reasoning_delta"; text: string; block?: string | number }
  | { type: "tool_call"; call: NormalizedToolCall }
  | { type: "usage"; usage: NormalizedLlmUsage; usedTokens?: number; serviceTier?: string }
  | { type: "opaque_checkpoint"; checkpoint?: unknown; public?: ProviderContextCheckpoint; compaction?: "running" | "completed" | "failed" }
  | { type: "done" };

export type ProviderStep = {
  iteration: number;
  tools: Tool[];
  newToolNames: string[];
  results: NormalizedToolResult[];
  steering: SteeringMessage[];
  checkpoint?: unknown;
  signal?: AbortSignal;
};

export type ProviderAdapter = {
  provider: string;
  events: (step: ProviderStep) => AsyncIterable<ProviderEvent>;
};

export const MAX_PROVIDER_STREAM_BYTES = 4 * 1024 * 1024;
export const MAX_PROVIDER_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const MAX_PROVIDER_TOOL_CALLS = 128;

const emptyUsage = (): NormalizedLlmUsage => ({
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cacheReadInputTokens: null,
  cacheWriteInputTokens: null,
});

function addUsage(
  target: NormalizedLlmUsage | null,
  value: NormalizedLlmUsage,
): NormalizedLlmUsage {
  const next = target ?? emptyUsage();
  for (const key of Object.keys(next) as (keyof NormalizedLlmUsage)[]) {
    if (value[key] !== null) next[key] = (next[key] ?? 0) + value[key];
  }
  return next;
}

function retryable(error: unknown): boolean {
  const current = error as { status?: unknown; status_code?: unknown; code?: unknown; cause?: unknown };
  const status = current?.status ?? current?.status_code;
  if (typeof status === "number" && [408, 409, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  return /overload|terminated|fetch failed|socket hang up|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_/iu.test(
    [String(error), String(current?.code ?? ""), String(current?.cause ?? "")].join(" "),
  );
}

async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  throwIfAborted(signal);
  if (!signal) return iterator.next();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort));
  });
}

export async function runProviderLoop(
  params: StreamChatParams,
  adapter: ProviderAdapter,
): Promise<StreamChatResult> {
  const callbacks = params.callbacks ?? {};
  const initialTools = params.tools ?? [];
  const contextWindowTokens = modelContextWindow(params.model);
  const contextRounds: LlmContextRoundReceipt[] = [];
  let checkpoint: unknown;
  let pendingResults: NormalizedToolResult[] = [];
  let pendingSteering: SteeringMessage[] = [];
  let declaredTools = new Set<string>();
  let fullText = "";
  let usage: NormalizedLlmUsage | null = null;
  let serviceTier: string | undefined;
  let streamedBytes = 0, providerToolCalls = 0, providerToolArgumentBytes = 0;

  const maxIterations = params.maxIterations ?? 32;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      throwIfAborted(params.abortSignal);
      const tools = params.resolveTools?.() ?? initialTools;
      const newToolNames = iteration
        ? tools.map(({ name }) => name).filter((name) => !declaredTools.has(name))
        : [];
      const input = iteration
        ? { continuation: checkpoint === undefined ? null : "opaque", results: pendingResults, steering: pendingSteering }
        : { messages: params.messages };
      const inputJson = JSON.stringify(input);
      const toolsJson = JSON.stringify(tools);
      const round: LlmContextRoundReceipt = {
        iteration,
        requestAttempts: 0,
        instructionsBytes: Buffer.byteLength(params.systemPrompt),
        inputItems: iteration ? pendingResults.length + pendingSteering.length : params.messages.length,
        inputBytes: Buffer.byteLength(inputJson),
        toolCount: tools.length,
        toolBytes: Buffer.byteLength(toolsJson),
        toolCallCount: 0,
        toolArgumentBytes: 0,
        toolResultBytes: 0,
        usage: emptyUsage(),
      };
      contextRounds.push(round);

      let toolCalls: NormalizedToolCall[] = [];
      let attemptUsage: NormalizedLlmUsage | null = null;
      let attemptCheckpoint = checkpoint;
      let contextUsed: number | undefined;
      let done = false;
      let visible = false;
      let reasoningBlock: string | number | undefined;
      let reasoningOpen = false;
      let contentBlock: string | number | undefined;
      let contentOpen = false;
      const closeReasoning = () => {
        if (reasoningOpen) callbacks.onReasoningBlockEnd?.();
        reasoningOpen = false; reasoningBlock = undefined;
      };
      const closeContent = () => {
        if (contentOpen) callbacks.onContentBlockEnd?.();
        contentOpen = false; contentBlock = undefined;
      };

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        round.requestAttempts += 1;
        toolCalls = [];
        attemptUsage = null;
        attemptCheckpoint = checkpoint;
        contextUsed = undefined;
        done = false;
        visible = false;
        let iterator: AsyncIterator<ProviderEvent> | undefined;
        try {
          iterator = adapter.events({
            iteration,
            tools,
            newToolNames,
            results: pendingResults,
            steering: pendingSteering,
            checkpoint,
            signal: params.abortSignal,
          })[Symbol.asyncIterator]();
          while (true) {
            const item = await nextEvent(iterator, params.abortSignal);
            if (item.done) break;
            const event = item.value;
            if (event.type === "reasoning_delta") {
              if (!event.text) continue;
              streamedBytes += Buffer.byteLength(event.text);
              if (streamedBytes > MAX_PROVIDER_STREAM_BYTES)
                throw new Error("Provider stream exceeded the output limit");
              closeContent();
              if (reasoningOpen && event.block !== reasoningBlock) closeReasoning();
              reasoningOpen = true;
              reasoningBlock = event.block;
              visible = true;
              callbacks.onReasoningDelta?.(event.text);
            } else if (event.type === "text_delta") {
              if (!event.text) continue;
              streamedBytes += Buffer.byteLength(event.text);
              if (streamedBytes > MAX_PROVIDER_STREAM_BYTES)
                throw new Error("Provider stream exceeded the output limit");
              closeReasoning();
              if (contentOpen && event.block !== contentBlock) closeContent();
              contentOpen = true;
              contentBlock = event.block;
              visible = true;
              fullText += event.text;
              callbacks.onContentDelta?.(event.text);
            } else if (event.type === "tool_call") {
              providerToolCalls += 1;
              providerToolArgumentBytes += Buffer.byteLength(JSON.stringify(event.call.input));
              if (providerToolCalls > MAX_PROVIDER_TOOL_CALLS ||
                  providerToolArgumentBytes > MAX_PROVIDER_TOOL_ARGUMENT_BYTES)
                throw new Error("Provider tool calls exceeded the input limit");
              closeReasoning();
              closeContent();
              visible = true;
              toolCalls.push(event.call);
              callbacks.onToolCallStart?.(event.call);
            } else if (event.type === "usage") {
              if (Object.values(event.usage).some((value) => value !== null)) {
                attemptUsage = addUsage(attemptUsage, event.usage);
              }
              contextUsed = event.usedTokens ?? contextUsed;
              serviceTier = event.serviceTier ?? serviceTier;
            } else if (event.type === "opaque_checkpoint") {
              if (event.checkpoint !== undefined) attemptCheckpoint = event.checkpoint;
              visible ||= Boolean(event.compaction || event.public);
              if (event.compaction) callbacks.onCompaction?.(event.compaction);
              if (event.public) callbacks.onContextCheckpoint?.(event.public);
            } else {
              done = true;
              closeReasoning();
              closeContent();
            }
          }
          if (!done) throw new Error(`${adapter.provider} stream ended without a done event`);
          break;
        } catch (error) {
          closeReasoning();
          closeContent();
          if (params.abortSignal?.aborted) throw abortError();
          if (visible || attempt === 3 || !retryable(error)) throw error;
          await iterator?.return?.().catch(() => undefined);
        }
      }

      checkpoint = attemptCheckpoint;
      declaredTools = new Set(tools.map(({ name }) => name));
      if (attemptUsage) {
        usage = addUsage(usage, attemptUsage);
        round.usage = attemptUsage;
      }
      if (contextWindowTokens && contextUsed !== undefined) {
        callbacks.onContextUsage?.({ usedTokens: contextUsed, contextWindowTokens });
      }
      const results = toolCalls.length && params.runTools
        ? await params.runTools(toolCalls)
        : [];
      throwIfAborted(params.abortSignal);
      round.toolCallCount = toolCalls.length;
      round.toolArgumentBytes = toolCalls.reduce(
        (total, call) => total + Buffer.byteLength(JSON.stringify(call.input)), 0,
      );
      round.toolResultBytes = results.reduce(
        (total, result) => total + Buffer.byteLength(result.content), 0,
      );
      if (results.some(({ terminal }) => terminal)) break;
      const steering = params.takeSteering?.() ?? [];
      if (!results.length && !steering.length) break;
      pendingResults = results;
      pendingSteering = steering;
  }

  return {
    fullText,
    ...(usage ? { usage } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    contextRounds,
  };
}
