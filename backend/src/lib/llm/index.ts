import { appendContextManifest, buildContextManifest } from "./contextManifest";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

export async function streamCodex(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  // The app-server adapter owns the exec fallback, so this stays a single door.
  return (await import("./codexAppServer")).streamCodexAppServer(params);
}

export async function streamChatWithTools(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const provider = providerForModel(params.model);
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  let firstContentAt: number | null = null;
  let streamedOutputBytes = 0;
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
                ? await streamCodex(measuredParams)
                : await (await import("./gemini")).streamGemini(measuredParams);
    const finishedAt = performance.now();
    await recordManifest({
      params,
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
      params,
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
  if (provider === "codex")
    return (await import("./codex")).completeCodexText(params);
  return (await import("./gemini")).completeGeminiText(params);
}
