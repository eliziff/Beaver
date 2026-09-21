import type { LanguageModelUsage, ModelMessage, ToolSet } from "ai" with { "resolution-mode": "import" };
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { hostedModel, type HostedModel } from "./sdkProviders";
import { modelContextWindow, estimateContextTokens } from "./contextWindow";
import { modelSupportsImageInput, providerForModel } from "./models";
import { throwIfAborted } from "./abort";
import { jsonRecord } from "../value";
import type { LlmMessage, NormalizedLlmUsage, NormalizedToolCall, NormalizedToolResult,
  StreamChatParams, StreamChatResult, LlmContextRoundReceipt } from "./types";

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

function resultMessage(calls: NormalizedToolCall[], results: NormalizedToolResult[], images: boolean): ModelMessage[] {
  if (!calls.length) return [];
  const byId = new Map(results.map(result => [result.tool_use_id, result]));
  return [{ role: "tool", content: calls.map(call => {
    const result = byId.get(call.id);
    if (!result) throw new Error(`No result for tool call ${call.id}`);
    const text = result.content + (!images && result.images?.length ? "\n[This model cannot see the returned images.]" : "");
    return { type: "tool-result", toolCallId: call.id, toolName: call.name,
      output: images && result.images?.length ? { type: "content", value: [
        { type: "text", text }, ...result.images.map(image => ({ type: "image-data" as const,
          data: image.data, mediaType: image.mimeType })),
      ] } : { type: result.status === "error" ? "error-text" : "text", value: text } };
  }) }];
}

export class IncompleteGenerationError extends Error {
  constructor(readonly finishReason: string, readonly fullText: string) {
    super(finishReason === "length" ? "The model reached its output limit before finishing."
      : finishReason === "step-limit" ? "The assistant reached its tool-round limit before finishing."
        : `The model stopped before completing the response (${finishReason}).`);
    this.name = "IncompleteGenerationError";
  }
}

/** SDK owns streaming, retries, schemas and wire state. Beaver owns ordered tool effects and stopping. */
export async function streamHosted(params: StreamChatParams, configured?: HostedModel): Promise<StreamChatResult> {
  const { streamText, jsonSchema, Output, pruneMessages } = await sdk;
  const config = configured ?? await hostedModel(params), callbacks = params.callbacks ?? {};
  const controller = new AbortController(), signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, controller.signal]) : controller.signal;
  let messages = modelMessages(params.messages, params.model);
  messages = compactedMessages(messages) ?? messages;
  let fullText = "", streamBytes = 0, argumentBytes = 0, callCount = 0, compacting = false;
  const rounds: LlmContextRoundReceipt[] = [];
  let total: NormalizedLlmUsage | undefined, serviceTier: string | undefined;
  const maxIterations = params.maxIterations ?? 32, window = modelContextWindow(params.model);
  const images = modelSupportsImageInput(params.model);
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1)
    throw new Error("maxIterations must be a positive integer");
  const validate = params.outputSchema && new AjvJsonSchemaValidator().getValidator(params.outputSchema);
  const output = params.outputSchema && Output.object({ schema: jsonSchema(params.outputSchema, {
    validate(value) { const checked = validate!(value); return checked.valid
      ? { success: true, value } : { success: false, error: new Error(checked.errorMessage) }; },
  }) });
  if (!images && params.messages.some(message => message.images?.length))
    throw new Error("This model does not support image input.");
  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      throwIfAborted(signal);
      const definitions = params.resolveTools?.() ?? params.tools ?? [];
      const tools: ToolSet = Object.fromEntries(definitions.map(tool => [tool.name, {
        description: tool.description, inputSchema: jsonSchema<Record<string, unknown>>(tool.inputSchema),
        // Existing MCP contracts use optional fields; the host validates them before effects.
        strict: false,
      }]));
      if (providerForModel(params.model) === "ollama" && window &&
          estimateContextTokens({ systemPrompt: params.systemPrompt,
            messages: [{ role: "user", content: JSON.stringify(messages) }], tools: definitions }) > window * .9) {
        messages = pruneMessages({ messages, toolCalls: "before-last-message" });
        if (Buffer.byteLength(JSON.stringify({ systemPrompt: params.systemPrompt, messages, tools })) / 3 > window * .9)
          throw new Error(`The request exceeds this local model's ${window}-token context.`);
      }
      const round: LlmContextRoundReceipt = { iteration, requestAttempts: 0,
        instructionsBytes: Buffer.byteLength(params.systemPrompt), inputItems: messages.length,
        inputBytes: Buffer.byteLength(JSON.stringify(messages)), toolCount: definitions.length,
        toolBytes: Buffer.byteLength(JSON.stringify(definitions)), toolCallCount: 0, toolArgumentBytes: 0,
        toolResultBytes: 0, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null,
          cacheReadInputTokens: null, cacheWriteInputTokens: null } };
      rounds.push(round);
      const generated = streamText({ model: config.model, instructions: params.systemPrompt,
        messages, tools, toolChoice: "auto", providerOptions: config.options,
        ...(output && { output }),
        maxOutputTokens: params.maxTokens ?? config.maxTokens,
        maxRetries: Math.max(0, Math.min(2, (params.maxProviderAttempts ?? 3) - 1)),
        streamRetries: 0, abortSignal: signal,
        onLanguageModelCallStart() { round.requestAttempts++; }, onError() {},
      });
      const calls: NormalizedToolCall[] = [], invalid = new Map<string, NormalizedToolResult>();
      const compactions = new Set<string>();
      for await (const part of generated.fullStream) {
        throwIfAborted(signal);
        if (part.type === "error") throw part.error;
        if (part.type === "abort") throwIfAborted(signal);
        callbacks.onActivity?.();
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
        else if (part.type === "tool-call") {
          argumentBytes += Buffer.byteLength(JSON.stringify(part.input) ?? "");
          if (++callCount > 128 || argumentBytes > MAX_ARGUMENT_BYTES)
            throw new Error("Provider tool calls exceeded the input limit");
          const input = jsonRecord(part.input), call = { id: part.toolCallId, name: part.toolName, input: input ?? {} };
          calls.push(call); callbacks.onToolCallStart?.(call);
          if (part.invalid || !input) invalid.set(call.id, { tool_use_id: call.id,
            content: "Invalid tool arguments; correct them against the tool schema.", status: "error" });
        }
      }
      throwIfAborted(signal);
      const reason = await generated.finishReason, response = await generated.response;
      const normal = reason === "stop" || reason === "tool-calls";
      if (normal && params.outputSchema && !calls.length) await generated.output;
      if (new Set(calls.map(call => call.id)).size !== calls.length)
        throw new Error("Duplicate tool call IDs in model response");
      const executable = calls.filter(call => !invalid.has(call.id));
      const results: NormalizedToolResult[] = normal ? [
        ...invalid.values(), ...(executable.length && params.runTools ? await params.runTools(executable, callbacks.onActivity) : []),
      ] : calls.map(call => ({ tool_use_id: call.id, status: "error" as const,
        content: `Tool not executed: generation stopped with ${reason}.` }));
      const resultIds = new Set(results.map(result => result.tool_use_id));
      if (results.length !== calls.length || resultIds.size !== calls.length ||
          calls.some(call => !resultIds.has(call.id)))
        throw new Error("Tool results must pair exactly with the requested batch");
      // The SDK supplies error results for invalid calls; do not answer those calls twice.
      const answered = new Set(response.messages.flatMap(message => message.role === "tool"
        ? message.content.flatMap(part => part.type === "tool-result" ? [part.toolCallId] : []) : []));
      const step = [...response.messages, ...resultMessage(calls.filter(call => !answered.has(call.id)), results, images)];
      const compacted = compactedMessages(step);
      messages = compacted ?? [...messages, ...step];
      // A completed pair is saved even if a tool paused/cancelled the turn. Never persist an orphan tool call.
      await callbacks.onModelMessages?.({ model: params.model, messages: compacted ?? step,
        ...(compacted && { compacted: true }) });
      if (compacted) { compacting = false; callbacks.onCompaction?.("completed"); }
      round.usage = usage(await generated.usage);
      total ??= { ...round.usage };
      if (iteration) for (const key of Object.keys(total) as (keyof NormalizedLlmUsage)[]) {
        const value = round.usage[key];
        if (value !== null) total[key] = (total[key] ?? 0) + value;
      }
      const metadata = await generated.providerMetadata;
      if (typeof metadata?.openai?.serviceTier === "string") serviceTier = metadata.openai.serviceTier;
      round.toolCallCount = calls.length;
      round.toolArgumentBytes = calls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.input)), 0);
      round.toolResultBytes = Buffer.byteLength(JSON.stringify(results));
      if (window && round.usage.inputTokens !== null)
        callbacks.onContextUsage?.({ usedTokens: round.usage.inputTokens, contextWindowTokens: window });
      if (!normal) throw new IncompleteGenerationError(reason, fullText);
      throwIfAborted(signal);
      if (results.some(result => result.terminal)) return { fullText, usage: total, serviceTier,
        contextRounds: rounds, finishReason: reason };
      const steering = params.takeSteering?.() ?? [];
      messages.push(...steering.map(({ text }) => ({ role: "user" as const, content: text })));
      if (!calls.length && !steering.length) return { fullText, usage: total, serviceTier,
        contextRounds: rounds, finishReason: reason };
    }
    throw new IncompleteGenerationError("step-limit", fullText);
  } finally {
    if (compacting) callbacks.onCompaction?.("failed");
    controller.abort();
  }
}
