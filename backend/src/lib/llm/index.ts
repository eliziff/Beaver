import { appendContextManifest, buildContextManifest } from "./contextManifest";
import { requireApiKey } from "./apiKeys";
import { providerForModel } from "./models";
import type {
  Provider,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";

export * from "./types";
export * from "./models";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const META_BASE_URL = "https://api.meta.ai/v1";

async function streamProvider(
  provider: Provider,
  params: StreamChatParams,
): Promise<StreamChatResult> {
  switch (provider) {
    case "claude":
      return (await import("./claude")).streamClaude(params);
    case "openai":
      return (await import("./openai")).streamOpenAI(params);
    case "deepseek":
      return (await import("./deepseek")).streamDeepSeek(params);
    case "openrouter":
    case "meta": {
      const isOpenRouter = provider === "openrouter";
      return (await import("./openai")).streamResponsesApi(params, {
        baseURL: isOpenRouter ? OPENROUTER_BASE_URL : META_BASE_URL,
        provider: isOpenRouter ? "OpenRouter" : "Meta",
        apiKey: requireApiKey(
          isOpenRouter ? params.apiKeys?.openrouter : params.apiKeys?.meta,
          isOpenRouter ? ["OPENROUTER_API_KEY"] : ["META_API_KEY", "MODEL_API_KEY"],
          isOpenRouter ? "OpenRouter" : "Meta",
        ),
        persistent: false,
        defaultReasoningEffort: "medium",
      });
    }
    case "codex":
      return (await import("./codex")).streamCodex(params);
    case "claude-p":
      return (await import("./claudeP")).streamClaudeP(params);
    case "ollama":
      return (await import("./ollamaApi")).streamOllama(params);
    case "gemini":
      return (await import("./gemini")).streamGemini(params);
  }
}

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
    tools:
      provider === "codex" && params.staticTools
        ? [...params.staticTools]
        : params.tools
          ? [...params.tools]
          : params.tools,
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
    const result = await streamProvider(provider, measuredParams);
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
  return (
    await streamProvider(provider, {
      model: params.model,
      systemPrompt: params.systemPrompt ?? "",
      messages: [{ role: "user", content: params.user }],
      maxTokens: params.maxTokens ?? 512,
      reasoningEffort: params.reasoningEffort,
      apiKeys: params.apiKeys,
    })
  ).fullText;
}

export const getOllamaModelCatalog = async () =>
  (await import("./ollamaApi")).getOllamaModelCatalog();
