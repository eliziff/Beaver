import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { streamDeepSeek, completeDeepSeekText } from "./deepseek";
import { streamOpenRouter, completeOpenRouterText } from "./openrouter";
import { streamCodex, completeCodexText } from "./codex";
import { appendContextManifest, buildContextManifest } from "./contextManifest";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";
export { streamCodex };

export async function streamChatWithTools(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const provider = providerForModel(params.model);
  const dispatch =
    provider === "claude"
      ? streamClaude
      : provider === "openai"
        ? streamOpenAI
        : provider === "deepseek"
          ? streamDeepSeek
          : provider === "openrouter"
            ? streamOpenRouter
            : provider === "codex"
              ? streamCodex
              : streamGemini;
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
    const result = await dispatch(measuredParams);
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
  if (provider === "claude") return completeClaudeText(params);
  if (provider === "openai") return completeOpenAIText(params);
  if (provider === "deepseek") return completeDeepSeekText(params);
  if (provider === "openrouter") return completeOpenRouterText(params);
  if (provider === "codex") return completeCodexText(params);
  return completeGeminiText(params);
}
