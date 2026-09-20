import type { LanguageModelUsage, ModelMessage, ToolSet, ToolResultPart } from "ai" with { "resolution-mode": "import" };
import { validateModelOutput } from "./structured";
import { hostedModel, type HostedModel } from "./sdkProviders";
import { modelContextWindow, estimateContextTokens } from "./contextWindow";
import { modelSupportsImageInput, providerForModel } from "./models";
import { throwIfAborted } from "./abort";
import { jsonRecord } from "../value";
import type { LlmMessage, NormalizedLlmUsage, NormalizedToolCall, NormalizedToolResult,
  StreamChatParams, StreamChatResult, LlmContextRoundReceipt, Tool } from "./types";

const sdk = import("ai");
const MAX_STREAM_BYTES = 4 * 1024 * 1024, MAX_ARGUMENT_BYTES = 1024 * 1024;
const usage = (value: LanguageModelUsage): NormalizedLlmUsage => ({
  inputTokens: value.inputTokens ?? null, outputTokens: value.outputTokens ?? null,
  reasoningTokens: value.outputTokenDetails.reasoningTokens ?? null,
  cacheReadInputTokens: value.inputTokenDetails.cacheReadTokens ?? null,
  cacheWriteInputTokens: value.inputTokenDetails.cacheWriteTokens ?? null,
});
const compactionPart = (part: unknown) => {
  const row = jsonRecord(part);
  return row?.kind === "openai.compaction" ||
    jsonRecord(jsonRecord(row?.providerOptions)?.anthropic)?.type === "compaction";
};

/** Retain the SDK's native checkpoint and the output after it, not the prefix it replaces. */
function compactedMessages(messages: ModelMessage[]): ModelMessage[] | null {
  for (let row = messages.length - 1; row >= 0; row--) {
    const message = messages[row];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    let at = message.content.length - 1;
    while (at >= 0 && !compactionPart(message.content[at])) at--;
    if (at >= 0) return [{ ...message, content: message.content.slice(at) }, ...messages.slice(row + 1)];
  }
  return null;
}

/** Replay SDK messages unchanged on their model. Foreign reasoning/signatures are not portable. */
export function modelMessages(messages: LlmMessage[], model: string): ModelMessage[] {
  return messages.flatMap<ModelMessage>(message => {
    if (message.modelState) return message.modelState.messages.flatMap<ModelMessage>(stored => {
      if (message.modelState!.model === model) return [structuredClone(stored)];
      const { providerOptions: _options, ...plain } = stored;
      if (!Array.isArray(plain.content)) return [plain as ModelMessage];
      const content = plain.content.filter(part => !["reasoning", "custom"].includes(part.type) && !compactionPart(part))
        .map(part => { const copy = { ...part }; if ("providerOptions" in copy) delete copy.providerOptions; return copy; });
      return content.length ? [{ ...plain, content } as ModelMessage] : [];
    });
    const checkpoint = message.contextCheckpoint;
    if (checkpoint?.provider === "claude") return [{ role: "assistant", content: [{ type: "text",
      text: checkpoint.content, providerOptions: { anthropic: { type: "compaction" } } }] }];
    if (checkpoint?.provider === "openai") return [{ role: "assistant", content: [{ type: "custom",
      kind: "openai.compaction", providerOptions: { openai: { itemId: checkpoint.item.id as string,
        encryptedContent: checkpoint.item.encrypted_content as string } } }] }];
    if (message.role === "user" && message.images?.length) return [{ role: "user", content: [
      { type: "text", text: message.content }, ...message.images.map(image => ({ type: "image" as const,
        image: image.data, mediaType: image.mimeType })),
    ] }];
    return message.content ? [{ role: message.role, content: message.content }] : [];
  });
}

export class IncompleteGenerationError extends Error {
  constructor(readonly finishReason: string, readonly fullText: string) {
    super(finishReason === "length" ? "The model reached its output limit before finishing."
      : finishReason === "step-limit" ? "The assistant reached its tool-round limit before finishing."
        : `The model stopped before completing the response (${finishReason}).`);
    this.name = "IncompleteGenerationError";
  }
}

/** SDK owns the multi-step loop. The registry remains the single ordered-effects boundary. */
export async function streamHosted(params: StreamChatParams, configured?: HostedModel): Promise<StreamChatResult> {
  const { streamText, jsonSchema, Output, pruneMessages, isStepCount } = await sdk;
  const config = configured ?? await hostedModel(params), callbacks = params.callbacks ?? {};
  const controller = new AbortController();
  // Cancellation interrupts inference immediately; an already-running tool batch settles and is saved first.
  let generating = true, compacting = false;
  const abort = () => { if (generating) controller.abort(params.abortSignal?.reason); };
  let messages = modelMessages(params.messages, params.model);
  messages = compactedMessages(messages) ?? messages;
  const rounds: LlmContextRoundReceipt[] = [], totals: LanguageModelUsage[] = [];
  const maxIterations = params.maxIterations ?? 32, window = modelContextWindow(params.model);
  const images = modelSupportsImageInput(params.model);
  const output = params.outputSchema && Output.object({ schema: jsonSchema(params.outputSchema, {
    validate: value => validateModelOutput(params.outputSchema!, value),
  }) });
  const tools: ToolSet = {}, definitions = new Map<string, Tool>();
  let fullText = "", streamBytes = 0, generatedBytes = 0, argumentBytes = 0, callCount = 0, terminal = false;
  let failure: unknown, serviceTier: string | undefined, structured: unknown;
  let calls: NormalizedToolCall[] = [], batch: Promise<Map<string, NormalizedToolResult>> | undefined;
  const modelOutput = (result: NormalizedToolResult): ToolResultPart["output"] => {
    const text = result.content + (!images && result.images?.length ? "\n[This model cannot see the returned images.]" : "");
    return images && result.images?.length ? { type: "content", value: [
      { type: "text", text }, ...result.images.map(image => ({ type: "image-data" as const,
        data: image.data, mediaType: image.mimeType })),
    ] } : { type: result.status === "error" ? "error-text" : "text", value: text };
  };
  const execute = async (_input: unknown, { toolCallId }: { toolCallId: string }) => {
    if (failure) throw failure;
    batch ??= Promise.resolve().then(async () => {
      throwIfAborted(params.abortSignal);
      const results = await params.runTools!(calls);
      const byId = new Map(results.map(result => [result.tool_use_id, result]));
      for (const call of calls) if (!byId.has(call.id)) throw new Error(`No result for tool call ${call.id}`);
      terminal ||= results.some(result => result.terminal);
      rounds.at(-1)!.toolResultBytes = Buffer.byteLength(JSON.stringify(results));
      return byId;
    }).catch(error => { failure = error; throw error; });
    return (await batch).get(toolCallId)!;
  };
  if (!images && params.messages.some(message => message.images?.length))
    throw new Error("This model does not support image input.");
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1)
    throw new Error("maxIterations must be a positive integer");
  params.abortSignal?.addEventListener("abort", abort);
  try {
    do {
      throwIfAborted(params.abortSignal);
      const offset = rounds.length;
      const generated = streamText({ model: config.model, instructions: params.systemPrompt,
        messages, tools, toolChoice: "auto", providerOptions: config.options,
        ...(output && { output }), maxOutputTokens: params.maxTokens ?? config.maxTokens,
        maxRetries: Math.max(0, Math.min(2, (params.maxProviderAttempts ?? 3) - 1)),
        streamRetries: 0, abortSignal: controller.signal,
        stopWhen: [isStepCount(maxIterations - offset), () => terminal || Boolean(failure) || Boolean(params.abortSignal?.aborted)],
        prepareStep({ messages: history }) {
          if (failure) throw failure;
          throwIfAborted(params.abortSignal);
          generating = true;
          const visible = params.resolveTools?.() ?? params.tools ?? [];
          for (const tool of visible) {
            const previous = definitions.get(tool.name);
            if (previous?.inputSchema === tool.inputSchema && previous.description === tool.description && previous.strict === tool.strict) continue;
            definitions.set(tool.name, tool);
            tools[tool.name] = { description: tool.description,
              inputSchema: jsonSchema<Record<string, unknown>>(tool.inputSchema), strict: tool.strict ?? false,
              ...(params.runTools && { execute,
                toModelOutput: ({ output: result }: { output: unknown }) => modelOutput(result as NormalizedToolResult) }),
            };
          }
          const steering = rounds.length > offset ? params.takeSteering?.() ?? [] : [];
          messages = compactedMessages(history) ?? history;
          messages = [...messages, ...steering.map(({ text }) => ({ role: "user" as const, content: text }))];
          if (providerForModel(params.model) === "ollama" && window &&
              estimateContextTokens({ messages: [{ role: "user", content: JSON.stringify(messages) }], tools: visible }) > window * .9) {
            messages = pruneMessages({ messages, toolCalls: "before-last-message" });
            if (Buffer.byteLength(JSON.stringify({ messages, tools: visible })) / 3 > window * .9)
              throw new Error(`The request exceeds this local model's ${window}-token context.`);
          }
          rounds.push({ iteration: rounds.length, requestAttempts: 0,
            instructionsBytes: Buffer.byteLength(params.systemPrompt), inputItems: messages.length,
            inputBytes: Buffer.byteLength(JSON.stringify(messages)), toolCount: visible.length,
            toolBytes: Buffer.byteLength(JSON.stringify(visible)), toolCallCount: 0, toolArgumentBytes: 0,
            toolResultBytes: 0, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null,
              cacheReadInputTokens: null, cacheWriteInputTokens: null } });
          batch = undefined;
          return { messages, activeTools: visible.map(tool => tool.name) };
        },
        onLanguageModelCallStart() { rounds.at(-1)!.requestAttempts++; },
        onLanguageModelCallEnd(event) {
          generating = false;
          generatedBytes += event.content.reduce((n, part) => n +
            ((part.type === "text" || part.type === "reasoning") ? Buffer.byteLength(part.text) : 0), 0);
          if (generatedBytes > MAX_STREAM_BYTES) failure = new Error("Provider stream exceeded the output limit");
          calls = event.content.flatMap(part => part.type === "tool-call" && !part.invalid && !part.providerExecuted
            ? [{ id: part.toolCallId, name: part.toolName, input: jsonRecord(part.input) ?? {} }] : []);
          const size = calls.reduce((n, call) => n + Buffer.byteLength(JSON.stringify(call.input)), 0);
          callCount += calls.length; argumentBytes += size;
          if (callCount > 128 || argumentBytes > MAX_ARGUMENT_BYTES)
            failure = new Error("Provider tool calls exceeded the input limit");
          const round = rounds.at(-1)!;
          round.toolCallCount = calls.length; round.toolArgumentBytes = size; round.usage = usage(event.usage);
          if (window && round.usage.inputTokens !== null)
            callbacks.onContextUsage?.({ usedTokens: round.usage.inputTokens, contextWindowTokens: window });
          if (typeof event.providerMetadata?.openai?.serviceTier === "string") serviceTier = event.providerMetadata.openai.serviceTier;
        },
        async onStepEnd(step) {
          if (failure) return;
          try {
            const saved = [...step.response.messages];
            const answered = new Set(saved.flatMap(message => message.role === "tool"
              ? message.content.flatMap(part => part.type === "tool-result" ? [part.toolCallId] : []) : []));
            const unexecuted = step.toolCalls.filter(call => !answered.has(call.toolCallId) && !call.providerExecuted);
            if (unexecuted.length) saved.push({ role: "tool", content: unexecuted.map(call => ({
              type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName,
              output: { type: "error-text", value: `Tool not executed: generation stopped with ${step.finishReason}.` },
            })) });
            const compacted = compactedMessages(saved);
            messages = compacted ?? [...messages, ...saved];
            await callbacks.onModelMessages?.({ model: params.model, messages: compacted ?? saved,
              ...(compacted && { compacted: true }) });
            if (compacted) {
              compacting = false;
              const first = compacted[0].content;
              const summary = Array.isArray(first) ? first.find(part => part.type === "text" && compactionPart(part)) : undefined;
              callbacks.onCompaction?.("completed", { provider: providerForModel(params.model),
                ...(summary?.type === "text" && { summary: summary.text }) });
            }
          } catch (error) { failure = error; }
        },
        onError() {},
      });
      const compactions = new Set<string>();
      for await (const part of generated.fullStream) {
        if (part.type === "error") throw part.error;
        if (part.type === "abort") throwIfAborted(controller.signal);
        if (part.type === "text-start" && part.providerMetadata?.anthropic?.type === "compaction") {
          compactions.add(part.id); compacting = true; callbacks.onCompaction?.("running");
        }
        if (part.type === "text-delta" || part.type === "reasoning-delta") {
          streamBytes += Buffer.byteLength(part.text);
          if (streamBytes > MAX_STREAM_BYTES) throw new Error("Provider stream exceeded the output limit");
          if (part.type === "text-delta" && !compactions.has(part.id)) {
            fullText += part.text; callbacks.onContentDelta?.(part.text);
          } else if (part.type === "reasoning-delta") callbacks.onReasoningDelta?.(part.text);
        } else if (part.type === "text-end" && !compactions.has(part.id)) callbacks.onContentBlockEnd?.();
        else if (part.type === "reasoning-end") callbacks.onReasoningBlockEnd?.();
        else if (part.type === "tool-call") callbacks.onToolCallStart?.({ id: part.toolCallId,
          name: part.toolName, input: jsonRecord(part.input) ?? {} });
      }
      if (failure) throw failure;
      totals.push(await generated.totalUsage);
      const reason = await generated.finishReason;
      if (reason !== "stop" && reason !== "tool-calls") throw new IncompleteGenerationError(reason, fullText);
      if (params.outputSchema && !calls.length) structured = await generated.output;
      if (!terminal) throwIfAborted(params.abortSignal);
      if (!terminal && calls.length && rounds.length >= maxIterations) throw new IncompleteGenerationError("step-limit", fullText);
      const steering = terminal ? [] : params.takeSteering?.() ?? [];
      if (!steering.length) {
        const total = usage(totals[0]);
        for (const value of totals.slice(1).map(usage)) for (const key of Object.keys(total) as (keyof NormalizedLlmUsage)[])
          if (value[key] !== null) total[key] = (total[key] ?? 0) + value[key]!;
        return { fullText, output: structured, usage: total, serviceTier, contextRounds: rounds, finishReason: reason };
      }
      messages.push(...steering.map(({ text }) => ({ role: "user" as const, content: text })));
    } while (rounds.length < maxIterations);
    throw new IncompleteGenerationError("step-limit", fullText);
  } finally {
    if (compacting) callbacks.onCompaction?.("failed");
    params.abortSignal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
