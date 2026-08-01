import { appendContextManifest, buildContextManifest } from "./contextManifest";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const provider = providerForModel(params.model);
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  let firstContentAt: number | null = null;
  let streamedOutputBytes = 0;
  // Progressive disclosure mutates the caller's active array between tool
  // iterations. Telemetry describes the first request, so retain that exact
  // schema inventory rather than observing the expanded array after return.
  const manifestParams: StreamChatParams = {
    ...params,
    tools: params.tools ? [...params.tools] : params.tools,
  };
  const measuredParams: StreamChatParams = {
    ...params,
    callbacks: {
      ...params.callbacks,
      onContentDelta(text) {
        if (text && firstContentAt === null) firstContentAt = performance.now();
        streamedOutputBytes += Buffer.byteLength(text);
        params.callbacks?.onContentDelta?.(text);
      },
    },
  };

  try {
    const result =
      provider === "claude"
        ? await (await import("./claude")).streamClaude(measuredParams)
        : provider === "openai"
          ? await (await import("./openai")).streamOpenAI(measuredParams)
          : provider === "deepseek"
            ? await (await import("./deepseek")).streamDeepSeek(measuredParams)
            : provider === "openrouter"
              ? await (
                  await import("./openrouter")
                ).streamOpenRouter(measuredParams)
              : provider === "codex"
                ? await (await import("./codexApi")).streamCodexApi(
                    measuredParams,
                  )
                : provider === "claude-p"
                  ? await (await import("./claudeP")).streamClaudeP(
                      measuredParams,
                    )
                  : provider === "ollama"
                    ? await (await import("./ollamaApi")).streamOllama(
                        measuredParams,
                      )
                    : await (
                        await import("./gemini")
                      ).streamGemini(measuredParams);
    const finishedAt = performance.now();
    await recordManifest({
      params: manifestParams,
      provider,
      startedAt: startedAtIso,
      firstContentLatencyMs:
        firstContentAt === null ? null : firstContentAt - startedAt,
      totalLatencyMs: finishedAt - startedAt,
      outputBytes: Buffer.byteLength(result.fullText),
      status: "completed",
      result,
    });
    return result;
  } catch (error) {
    const finishedAt = performance.now();
    await recordManifest({
      params: manifestParams,
      provider,
      startedAt: startedAtIso,
      firstContentLatencyMs:
        firstContentAt === null ? null : firstContentAt - startedAt,
      totalLatencyMs: finishedAt - startedAt,
      outputBytes: streamedOutputBytes,
      status:
        params.abortSignal?.aborted ||
        (error as { name?: unknown })?.name === "AbortError"
          ? "aborted"
          : "error",
    });
    throw error;
  }
}

async function recordManifest(
  args: Parameters<typeof buildContextManifest>[0],
): Promise<void> {
  try {
    await appendContextManifest(buildContextManifest(args));
  } catch (error) {
    console.warn("[llm-context-manifest] Could not append telemetry.", error);
  }
}

export async function completeText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  reasoningEffort?: string;
  apiKeys?: UserApiKeys;
}): Promise<string> {
  const provider = providerForModel(params.model);
  if (provider === "claude")
    return (await import("./claude")).completeClaudeText(params);
  if (provider === "openai")
    return (await import("./openai")).completeOpenAIText(params);
  if (provider === "deepseek")
    return (await import("./deepseek")).completeDeepSeekText(params);
  if (provider === "openrouter")
    return (await import("./openrouter")).completeOpenRouterText(params);
  if (provider === "codex") {
    const result = await (await import("./codexApi")).streamCodexApi({
      model: params.model,
      systemPrompt: params.systemPrompt ?? "",
      messages: [{ role: "user", content: params.user }],
      ...(params.reasoningEffort
        ? { reasoningEffort: params.reasoningEffort }
        : {}),
    });
    return result.fullText;
  }
  if (provider === "claude-p")
    return (await import("./claudeP")).completeClaudePText(params);
  if (provider === "ollama")
    return (await import("./ollamaApi")).completeOllamaText(params);
  return (await import("./gemini")).completeGeminiText(params);
}
