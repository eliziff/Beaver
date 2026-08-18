import { providerForModel } from "./models";
import type { LlmMessage, Tool } from "./types";

const MILLION_TOKEN_WINDOW = 1_000_000;
const OPENAI_CONTEXT_WINDOW = 1_050_000;
const DEFAULT_OLLAMA_CONTEXT_WINDOW = 32_768;

export function modelContextWindow(model: string): number | null {
  const provider = providerForModel(model);
  if (provider === "codex") return null; // app-server reports the real value.
  if (provider === "claude" || provider === "claude-p") {
    return model.includes("claude-haiku-4-5") ? 200_000 : MILLION_TOKEN_WINDOW;
  }
  if (provider === "ollama") {
    const configured = Number(
      process.env.OLLAMA_NUM_CTX || DEFAULT_OLLAMA_CONTEXT_WINDOW,
    );
    return Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_OLLAMA_CONTEXT_WINDOW;
  }
  if (provider === "openai") {
    return model.endsWith("-lite") ? 400_000 : OPENAI_CONTEXT_WINDOW;
  }
  if (provider === "openrouter") return OPENAI_CONTEXT_WINDOW;
  return MILLION_TOKEN_WINDOW;
}

export function compactionThresholdForModel(model: string): number | undefined {
  const configured = Number(process.env.MIKE_COMPACT_THRESHOLD || 0);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.trunc(configured);
  }
  if (providerForModel(model) === "codex") return undefined;
  const window = modelContextWindow(model);
  return window ? Math.floor(window * 0.8) : undefined;
}

export function estimateContextTokens(args: {
  systemPrompt?: string;
  messages: LlmMessage[];
  tools?: Tool[];
}) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(args)) / 3);
}

export function hasNativeCompaction(model: string) {
  const provider = providerForModel(model);
  return provider === "codex" || provider === "openai" ||
    (provider === "claude" && model !== "claude-haiku-4-5");
}

/** Stateless transports need Beaver's durable transcript checkpoint. */
export function needsHostCheckpoint(model: string) {
  return !hasNativeCompaction(model);
}
