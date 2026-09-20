import type { LanguageModel } from "ai" with { "resolution-mode": "import" };
import type { JSONValue } from "ai" with { "resolution-mode": "import" };
import { requireApiKey } from "./apiKeys";
import { providerForModel } from "./models";
import { openCodeGoConnection } from "./openCodeGo";
import { ollamaBaseUrl } from "./ollamaModels";
import type { StreamChatParams } from "./types";

export type HostedModel = { model: LanguageModel; options: Record<string, Record<string, JSONValue>>;
  maxTokens?: number };
const effort = (value: string | undefined, allowed: readonly string[]) => {
  if (value && !allowed.includes(value)) throw new Error(`Unsupported reasoning effort: ${value}`);
  return value;
};

/** SDK providers own wire protocols. Only endpoint/authentication and supported options belong here. */
export async function hostedModel(params: StreamChatParams): Promise<HostedModel> {
  const provider = providerForModel(params.model), keys = params.apiKeys;
  const go = provider === "opencode-go" ? openCodeGoConnection(params) : undefined;
  const model = go?.model ?? params.model.replace(/^ollama:/u, "");
  const requested = params.reasoningEffort?.toLowerCase();
  const thinking = params.enableThinking === true || Boolean(requested);
  const summaries = params.reasoningSummary !== "none";
  if (provider === "claude" || go?.protocol === "messages") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const options: Record<string, JSONValue> = {};
    if (provider === "claude") {
      options.cacheControl = { type: "ephemeral" };
      if (thinking) {
        const level = effort(requested, ["low", "medium", "high", "xhigh", "max"]) ?? "high";
        if (model.includes("haiku")) {
          options.thinking = { type: "enabled", budgetTokens: { low: 1024, medium: 4096,
            high: 8192, xhigh: 12288, max: 16384 }[level]! };
        } else {
          options.thinking = { type: "adaptive" };
          options.effort = level;
        }
      }
      if (params.compactThreshold && !model.includes("haiku")) options.contextManagement = {
        edits: [{ type: "compact_20260112", trigger: { type: "input_tokens",
          value: Math.max(50_000, params.compactThreshold) } }],
      };
    }
    return { model: createAnthropic({ apiKey: go?.apiKey ?? requireApiKey(keys?.claude,
      "ANTHROPIC_API_KEY", "Claude"), ...(go && { baseURL: go.baseURL, headers: go.headers }) })(model),
      options: { anthropic: options } };
  }
  if (provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const level = effort(requested, ["minimal", "low", "medium", "high"]);
    const thinkingConfig = model.startsWith("gemini-3")
      ? { includeThoughts: thinking && summaries,
          ...(level ? { thinkingLevel: level } : !thinking
            ? { thinkingLevel: model.includes("pro") ? "low" : "minimal" } : {}) }
      : { includeThoughts: thinking && summaries, ...(!thinking ? { thinkingBudget: 0 } : {}) };
    return { model: createGoogleGenerativeAI({ apiKey: requireApiKey(keys?.gemini,
      "GEMINI_API_KEY", "Gemini") })(model), options: { google: { thinkingConfig } } };
  }
  if (["openai", "openrouter", "meta"].includes(provider) || go?.protocol === "responses") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const config = provider === "openrouter" ? { baseURL: "https://openrouter.ai/api/v1",
      apiKey: requireApiKey(keys?.openrouter, "OPENROUTER_API_KEY", "OpenRouter") }
      : provider === "meta" ? { baseURL: "https://api.meta.ai/v1",
        apiKey: requireApiKey(keys?.meta, "META_API_KEY", "Meta") }
      : go ?? { apiKey: requireApiKey(keys?.openai, "OPENAI_API_KEY", "OpenAI") };
    return { model: createOpenAI(config).responses(model), options: { openai: {
      store: false, strictJsonSchema: false,
      reasoningSummary: provider === "openai" && thinking && summaries ? "auto" : null,
      ...(requested && { reasoningEffort: requested }),
      ...(params.promptCacheKey && { promptCacheKey: params.promptCacheKey }),
      ...(provider === "openai" ? {
        include: ["reasoning.encrypted_content"],
        ...(params.serviceTier && { serviceTier: params.serviceTier }),
        ...(params.compactThreshold && { contextManagement: [{ type: "compaction",
          compactThreshold: params.compactThreshold }] }),
      } : {}),
    } } };
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  if (provider === "deepseek") {
    const level = effort(requested, ["low", "medium", "high", "max"]);
    return { model: createOpenAICompatible({ name: "deepseek", baseURL: "https://api.deepseek.com",
      apiKey: requireApiKey(keys?.deepseek, "DEEPSEEK_API_KEY", "DeepSeek"),
      transformRequestBody: body => ({ ...body, thinking: { type: thinking ? "enabled" : "disabled" },
        ...(thinking && level && { reasoning_effort: level }) }),
    })(model), options: {}, maxTokens: Number(process.env.MIKE_DEEPSEEK_MAX_TOKENS) || 32_768 };
  }
  if (provider === "ollama") {
    const level = effort(requested === "max" ? "high" : requested, ["low", "medium", "high", "none"]);
    return { model: createOpenAICompatible({ name: "ollama", baseURL: `${ollamaBaseUrl()}/v1`,
      apiKey: "ollama", headers: process.env.OLLAMA_HOST_HEADER ? { Host: process.env.OLLAMA_HOST_HEADER } : undefined,
    })(model), options: { ollama: { reasoningEffort: thinking ? level ?? "high" : "none" } }, maxTokens: 32_768 };
  }
  if (go) return { model: createOpenAICompatible({ name: "opencodeGo", ...go })(model), options: {} };
  throw new Error(`Not an API-backed model: ${params.model}`);
}
