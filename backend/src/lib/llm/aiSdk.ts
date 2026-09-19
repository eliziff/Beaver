import { randomUUID } from "node:crypto";
import type { LanguageModel, ModelMessage, ToolSet } from "ai" with { "resolution-mode": "import" };
import { apiKeyError, requireApiKey } from "./apiKeys";
import { hasNativeCompaction } from "./contextWindow";
import { modelForProvider } from "./models";
import { MAX_PROVIDER_STREAM_BYTES, MAX_PROVIDER_TOOL_ARGUMENT_BYTES, runProviderLoop, type ProviderAdapter,
  type ProviderEvent } from "./providerLoop";
import type { Provider, StreamChatParams } from "./types";
import { configuredApiKey, configuredAvailable, getConfiguredModel } from "./registry";

type ApiProvider = Extract<Provider, "claude" | "openai" | "gemini" | "deepseek" | "openrouter" | "meta" | "configured">;
type Options = NonNullable<Parameters<typeof import("ai").streamText>[0]["providerOptions"]>;
type State = { messages: ModelMessage[]; calls: Record<string, string>; responseId?: string };

async function configuredModel(params: StreamChatParams, provider: ApiProvider): Promise<{
  model: LanguageModel; options: Options;
}> {
  const model = modelForProvider(params.model);
  if (provider === "configured") {
    const declaration = getConfiguredModel(params.model);
    if (!declaration) throw new Error("The selected model is not configured.");
    if (!configuredAvailable(declaration, params.apiKeys)) throw new Error("The selected model requires an API key.");
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const base = createOpenAICompatible({ name: declaration.id, baseURL: declaration.baseUrl,
      apiKey: configuredApiKey(declaration, params.apiKeys),
      ...(declaration.maxTokensField === "max_completion_tokens" ? {
        transformRequestBody: (body: Record<string, unknown>) => {
          const { max_tokens, ...rest } = body;
          return { ...rest, ...(max_tokens === undefined ? {} : { max_completion_tokens: max_tokens }) };
        },
      } : {}),
    })(declaration.apiModel ?? declaration.id);
    if (declaration.tolerateTextToolCalls ?? declaration.location === "local") {
      const [{ wrapLanguageModel }, { localModelToleranceMiddleware }] = await Promise.all([
        import("ai"), import("./localModelMiddleware"),
      ]);
      return { model: wrapLanguageModel({ model: base, middleware: localModelToleranceMiddleware() }), options: {} };
    }
    return { model: base, options: {} };
  }
  if (provider === "claude") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return { model: createAnthropic({ apiKey: requireApiKey(params.apiKeys?.claude,
      "ANTHROPIC_API_KEY", "Anthropic") })(model), options: { anthropic: {
      ...(params.enableThinking ? { thinking: { type: "adaptive" }, effort: params.reasoningEffort ?? "high" } : {}),
      ...(params.compactThreshold && hasNativeCompaction(params.model) ? { contextManagement: { edits: [{
        type: "compact_20260112", trigger: { type: "input_tokens", value: Math.max(50_000, params.compactThreshold) },
        instructions: "Summarize the transcript for continuing the task. Preserve user constraints, decisions, exact identifiers, unfinished work, and next steps. Do not call tools; return text only.",
      }] } } : {}),
    } } };
  }
  if (provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return { model: createGoogleGenerativeAI({ apiKey: requireApiKey(params.apiKeys?.gemini,
      "GEMINI_API_KEY", "Gemini"), fetch: async (url, init) => {
        if (typeof init?.body !== "string") return fetch(url, init);
        const body = JSON.parse(init.body);
        // The SDK's OpenAPI conversion drops maps/composition; Gemini accepts the original JSON Schema.
        const definitions = new Map((params.resolveTools?.() ?? params.tools ?? []).map((tool) => [tool.name, tool]));
        for (const group of body.tools ?? []) for (const declaration of group.functionDeclarations ?? []) {
          const definition = definitions.get(declaration.name);
          if (!definition) throw new Error("Gemini requested an undeclared function");
          delete declaration.parameters;
          declaration.parametersJsonSchema = definition.inputSchema;
        }
        if (params.outputSchema && body.generationConfig) {
          delete body.generationConfig.responseSchema;
          body.generationConfig.responseJsonSchema = params.outputSchema;
        }
        return fetch(url, { ...init, body: JSON.stringify(body) });
      } })(model), options: { google: {
      thinkingConfig: params.enableThinking ? { includeThoughts: true } : { thinkingBudget: 0 },
    } } };
  }
  if (provider === "deepseek") {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const effort = params.reasoningEffort?.toLowerCase();
    if (effort && !["low", "medium", "high", "max"].includes(effort))
      throw new Error(`Unsupported DeepSeek reasoning effort: ${effort}`);
    return { model: createOpenAICompatible({ name: "deepseek", baseURL: "https://api.deepseek.com",
      apiKey: requireApiKey(params.apiKeys?.deepseek, "DEEPSEEK_API_KEY", "DeepSeek"),
      includeUsage: true, supportsStructuredOutputs: true })(model), options: { deepseek: {
      thinking: { type: params.enableThinking ? "enabled" : "disabled" },
      ...(params.enableThinking && effort ? { reasoningEffort: effort } : {}),
    } } };
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  const configs = { openai: ["https://api.openai.com/v1", "OPENAI_API_KEY"],
    openrouter: ["https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"],
    meta: ["https://api.meta.ai/v1", "META_API_KEY"] } as const;
  const [baseURL, env] = configs[provider];
  return { model: createOpenAI({ baseURL, apiKey: requireApiKey(params.apiKeys?.[provider], env, provider) })
    .responses(model), options: { openai: {
      store: provider === "openai", strictJsonSchema: false,
      promptCacheKey: params.promptCacheKey?.trim() || randomUUID(),
      ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
      ...(params.enableThinking && provider === "openai" ? { reasoningSummary: params.reasoningSummary ?? "auto" } : {}),
      ...(provider === "openai" && params.serviceTier ? { serviceTier: params.serviceTier } : {}),
      ...(provider === "openai" && params.compactThreshold ? { contextManagement: [{
        type: "compaction", compactThreshold: params.compactThreshold,
      }] } : {}),
    } } };
}

function initialMessages(params: StreamChatParams, provider: ApiProvider): ModelMessage[] {
  return params.messages.map((message): ModelMessage => {
    const checkpoint = message.contextCheckpoint;
    if (checkpoint?.provider === "claude" && provider === "claude") return { role: "assistant", content: [{
      type: "text", text: checkpoint.content, providerOptions: { anthropic: { type: "compaction" } },
    }] };
    if (checkpoint?.provider === "openai" && provider === "openai") return { role: "assistant", content: [{
      type: "custom", kind: "openai.compaction", providerOptions: { openai: {
        type: "compaction", itemId: String(checkpoint.item.id),
        encryptedContent: String(checkpoint.item.encrypted_content ?? ""),
      } },
    }] };
    return message.role === "assistant" ? { role: "assistant", content: message.content }
      : { role: "user", content: [{ type: "text", text: message.content },
        ...(message.images ?? []).map((image) => ({ type: "image" as const,
          image: image.data, mediaType: image.mimeType }))] };
  });
}

export async function streamAiSdk(params: StreamChatParams, provider: ApiProvider) {
  const { streamText, jsonSchema, tool, Output } = await import("ai");
  const config = await configuredModel(params, provider);
  const adapter: ProviderAdapter = { provider, async *events(step): AsyncIterable<ProviderEvent> {
    const state = step.checkpoint as State | undefined;
    if (step.iteration && !state) throw new Error(`${provider} did not return continuation state`);
    const additions: ModelMessage[] = [];
    if (step.results.length) additions.push({ role: "tool", content: step.results.map((result) => ({
      type: "tool-result", toolCallId: result.tool_use_id,
      toolName: state?.calls[result.tool_use_id] ?? "unknown",
      output: result.images?.length ? { type: "content", value: [{ type: "text", text: result.content },
        ...result.images.map((image) => ({ type: "file" as const,
          data: { type: "data" as const, data: image.data }, mediaType: image.mimeType }))] }
        : { type: "text", value: result.content },
    })) });
    additions.push(...step.steering.map(({ text }): ModelMessage => ({ role: "user", content: text })));
    const messages = state ? provider === "openai" ? additions : [...state.messages, ...additions]
      : initialMessages(params, provider);
    const tools: ToolSet = Object.fromEntries(step.tools.map((definition) => [definition.name, tool({
      description: definition.description, inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema),
      strict: false,
    })]));
    const response = streamText({ model: config.model, system: params.systemPrompt || undefined,
      messages, tools, maxRetries: 0, abortSignal: step.signal, onError: () => undefined,
      maxOutputTokens: params.maxTokens ?? (provider === "deepseek"
        ? Number(process.env.MIKE_DEEPSEEK_MAX_TOKENS) || 32_768 : 16_384),
      ...(params.outputSchema ? { output: Output.object({ schema: jsonSchema(params.outputSchema) }) } : {}),
      providerOptions: { ...config.options, ...(provider === "openai" && state?.responseId
        ? { openai: { ...config.options.openai, previousResponseId: state.responseId } } : {}) },
      ...(provider === "gemini" && step.newToolNames.length
        ? { activeTools: step.newToolNames, toolChoice: "required" as const } : {}),
    });
    const calls: Record<string, string> = {};
    let compaction: { id: string; text: string } | undefined;
    let argumentBytes = 0;
    let checkpointBytes = 0;
    for await (const part of response.fullStream) {
      params.callbacks?.onActivity?.();
      if (part.type === "error") throw part.error;
      if (part.type === "abort") throw new Error("Provider stream aborted");
      if (part.type === "tool-input-delta") {
        argumentBytes += Buffer.byteLength(part.delta);
        if (argumentBytes > MAX_PROVIDER_TOOL_ARGUMENT_BYTES) throw new Error("Provider tool calls exceeded the input limit");
      }
      if (part.type === "text-start" && part.providerMetadata?.anthropic?.type === "compaction") {
        compaction = { id: part.id, text: "" };
        yield { type: "opaque_checkpoint", compaction: "running" };
      } else if (part.type === "text-delta") {
        if (compaction?.id === part.id) {
          checkpointBytes += Buffer.byteLength(part.text);
          if (checkpointBytes > MAX_PROVIDER_STREAM_BYTES) throw new Error("Provider checkpoint exceeded the output limit");
          compaction.text += part.text;
        }
        else yield { type: "text_delta", text: part.text, block: part.id };
      } else if (part.type === "text-end" && compaction?.id === part.id) {
        yield { type: "opaque_checkpoint", compaction: "completed", public: { provider: "claude",
          content: compaction.text, block: { type: "compaction", content: compaction.text } } };
        compaction = undefined;
      } else if (part.type === "reasoning-delta") {
        yield { type: "reasoning_delta", text: part.text, block: part.id };
      } else if (part.type === "custom" && part.kind === "openai.compaction") {
        const data = part.providerMetadata?.openai;
        if (typeof data?.itemId !== "string" || typeof data.encryptedContent !== "string")
          throw new Error("OpenAI returned an invalid compaction checkpoint");
        checkpointBytes += Buffer.byteLength(data.encryptedContent);
        if (checkpointBytes > MAX_PROVIDER_STREAM_BYTES) throw new Error("Provider checkpoint exceeded the output limit");
        yield { type: "opaque_checkpoint", compaction: "completed", public: { provider: "openai",
          item: { type: "compaction", id: data.itemId, encrypted_content: data.encryptedContent } } };
      } else if (part.type === "tool-call") {
        if (part.invalid || !part.input || typeof part.input !== "object" || Array.isArray(part.input))
          throw new Error(`${provider} returned invalid tool arguments`);
        calls[part.toolCallId] = part.toolName;
        yield { type: "tool_call", call: { id: part.toolCallId, name: part.toolName,
          input: part.input as Record<string, unknown> } };
      }
    }
    const [lastStep, generated] = await Promise.all([response.finalStep, response.responseMessages]);
    const { usage, providerMetadata: metadata, response: result, finishReason } = lastStep;
    if (!["stop", "length", "tool-calls"].includes(finishReason))
      throw new Error(`${provider} stopped without a successful finish: ${finishReason}`);
    const history = [...messages, ...generated];
    if (provider === "claude") {
      const lastCompaction = history.reduce((last, message, index) => message.role === "assistant" &&
        Array.isArray(message.content) && message.content.some((part) =>
          part.type === "text" && part.providerOptions?.anthropic?.type === "compaction") ? index : last, -1);
      if (lastCompaction >= 0) history.splice(0, lastCompaction);
    }
    yield { type: "usage", usage: { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
      reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? null,
      cacheReadInputTokens: provider === "deepseek" && typeof usage.raw?.prompt_cache_hit_tokens === "number"
        ? usage.raw.prompt_cache_hit_tokens : usage.inputTokenDetails.cacheReadTokens ?? null,
      cacheWriteInputTokens: provider === "deepseek" && typeof usage.raw?.prompt_cache_miss_tokens === "number"
        ? usage.raw.prompt_cache_miss_tokens : usage.inputTokenDetails.cacheWriteTokens ?? null }, usedTokens: usage.inputTokens,
      ...(typeof metadata?.openai?.serviceTier === "string" ? { serviceTier: metadata.openai.serviceTier } : {}) };
    if (provider === "openai" && !result.id) throw new Error("OpenAI did not return a response id");
    yield { type: "opaque_checkpoint", checkpoint: { messages: history, calls, responseId: result.id } satisfies State };
    yield { type: "done", finishReason };
  } };
  try { return await runProviderLoop(params, adapter); }
  catch (error) { throw apiKeyError(error, provider); }
}
