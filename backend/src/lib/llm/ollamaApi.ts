import { throwIfAborted } from "./abort";
import type {
  NormalizedLlmUsage,
  NormalizedToolCall,
  StreamChatParams,
  StreamChatResult,
} from "./types";

const DEFAULT_BASE_URL = "http://192.168.1.64:11434";
const CALL_TIMEOUT_MS = 900_000;
const ollamaBaseUrl = () =>
  (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/u, "");

export type OllamaModelCatalog = {
  source: "live" | "unavailable";
  models: { name: string; displayName: string; supportsThinking: boolean }[];
  error?: string;
};
let modelCatalog:
  | { expiresAt: number; value: OllamaModelCatalog }
  | undefined;
let modelCatalogRequest: Promise<OllamaModelCatalog> | undefined;

function modelLabel(name: string) {
  const [rawFamily, tag = ""] = name.split(":", 2);
  const family = rawFamily.replace(/^qwen(?=\d)/iu, "Qwen ");
  const size = /^(\d+(?:\.\d+)?)b(?:-(.+))?$/iu.exec(tag);
  if (!size) return tag ? `${family} ${tag}` : family;
  return `${family} ${size[1]}B${
    size[2] ? ` (${size[2].toUpperCase()})` : ""
  }`;
}

const configuredNames = (key: string) => [
  ...new Set(
    (process.env[key] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  ),
];

function configuredModels() {
  const thinking = new Set(configuredNames("OLLAMA_THINKING_MODELS"));
  return configuredNames("OLLAMA_MODELS").map((name) => ({
    name,
    displayName: modelLabel(name),
    supportsThinking: thinking.has(name),
  }));
}

export function configuredOllamaModelCatalog(): OllamaModelCatalog | null {
  const models = configuredModels();
  return models.length ? { source: "unavailable", models } : null;
}

export async function getOllamaModelCatalog(): Promise<OllamaModelCatalog> {
  if (modelCatalog && modelCatalog.expiresAt > Date.now())
    return modelCatalog.value;
  const configured = configuredOllamaModelCatalog();
  if (configured && !modelCatalog && !modelCatalogRequest)
    modelCatalog = { value: configured, expiresAt: Date.now() - 1 };
  modelCatalogRequest ??= (async () => {
    try {
      const timeout = Number(process.env.OLLAMA_CATALOG_TIMEOUT_MS) || 750;
      const response = await fetch(`${ollamaBaseUrl()}/api/tags`, {
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as {
        models?: {
          name?: unknown;
          model?: unknown;
          capabilities?: unknown;
        }[];
      };
      const installed = (payload.models ?? []).flatMap(
        ({ name, model, capabilities }) => {
          const id =
            typeof name === "string"
              ? name
              : typeof model === "string"
                ? model
                : "";
          return id
            ? [{
                name: id,
                supportsThinking:
                  Array.isArray(capabilities) &&
                  capabilities.includes("thinking"),
              }]
            : [];
        },
      );
      return {
        source: "live",
        models: installed
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((model) => ({
            ...model,
            displayName: modelLabel(model.name),
          })),
      } satisfies OllamaModelCatalog;
    } catch (error) {
      const models = modelCatalog?.value.models.length
        ? modelCatalog.value.models
        : configuredModels();
      return {
        source: "unavailable",
        models,
        error: error instanceof Error ? error.message : "Ollama unavailable",
      } satisfies OllamaModelCatalog;
    }
  })();
  const value = await modelCatalogRequest;
  modelCatalogRequest = undefined;
  modelCatalog = {
    value,
    expiresAt: Date.now() + (value.source === "live" ? 30_000 : 5_000),
  };
  return value;
}

export function ollamaModelSlug(model: string): string | null {
  return model.startsWith("ollama:")
    ? model.slice("ollama:".length).trim() || null
    : null;
}

type OllamaMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  tool_name?: string;
};

type OllamaChatReply = {
  message?: OllamaMessage & { thinking?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

function thinkingLevel(params: StreamChatParams) {
  if (!params.enableThinking) return false;
  const effort = params.reasoningEffort?.toLowerCase();
  if (["low", "medium", "high", "max"].includes(effort ?? ""))
    return effort;
  return false;
}

export async function streamOllama(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const slug = ollamaModelSlug(params.model);
  if (!slug) throw new Error(`Not an ollama model: ${params.model}`);
  const { callbacks = {}, runTools, tools = [] } = params;
  const numCtx = Number(process.env.OLLAMA_NUM_CTX || 32768);
  const maxIter = params.maxIterations ?? 10;

  // Images are not carried over this transport (fails closed).
  const messages: OllamaMessage[] = [
    { role: "system", content: params.systemPrompt },
    ...params.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  let fullText = "";
  let callCounter = 0;
  const callNames = new Map<string, string>();
  const usage: NormalizedLlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
  };

  for (let iter = 0; iter < maxIter; iter++) {
    throwIfAborted(params.abortSignal);
    const signals = [AbortSignal.timeout(CALL_TIMEOUT_MS)];
    if (params.abortSignal) signals.push(params.abortSignal);
    let response: Response;
    try {
      response = await fetch(`${ollamaBaseUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: slug,
          messages,
          // OpenAIToolSchema is already ollama's expected tool shape.
          tools,
          stream: false,
          think: thinkingLevel(params),
          options: { temperature: 0, num_ctx: numCtx },
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (params.abortSignal?.aborted) throw error;
      throw new Error(
        `Desktop Ollama is unreachable at ${ollamaBaseUrl()}. Start Ollama on the desktop and try again.`,
        { cause: error },
      );
    }
    if (!response.ok)
      throw new Error(`ollama /api/chat HTTP ${response.status}`);
    const reply = (await response.json()) as OllamaChatReply;
    if (reply.error) throw new Error(`ollama error: ${reply.error}`);
    const message = reply.message ?? { role: "assistant", content: "" };

    usage.inputTokens = (usage.inputTokens ?? 0) + (reply.prompt_eval_count ?? 0);
    usage.outputTokens = (usage.outputTokens ?? 0) + (reply.eval_count ?? 0);

    if (message.content) {
      fullText += message.content;
      callbacks.onContentDelta?.(message.content);
      callbacks.onContentBlockEnd?.();
    }

    const toolCalls: NormalizedToolCall[] = [];
    for (const raw of message.tool_calls ?? []) {
      const name = String(raw.function?.name ?? "");
      if (!name) continue;
      const rawArguments = raw.function?.arguments;
      let input: Record<string, unknown> = {};
      if (typeof rawArguments === "string") {
        try {
          input = JSON.parse(rawArguments) as Record<string, unknown>;
        } catch {
          input = {};
        }
      } else if (rawArguments && typeof rawArguments === "object") {
        input = rawArguments as Record<string, unknown>;
      }
      callCounter += 1;
      const id = `call_${callCounter}`;
      callNames.set(id, name);
      const call: NormalizedToolCall = { id, name, input };
      callbacks.onToolCallStart?.(call);
      toolCalls.push(call);
    }

    if (!toolCalls.length || !runTools) break;
    const results = await runTools(toolCalls);
    throwIfAborted(params.abortSignal);
    messages.push(message);
    for (const result of results) {
      messages.push({
        role: "tool",
        tool_name: callNames.get(result.tool_use_id) ?? result.tool_use_id,
        content: result.content,
      });
    }
  }

  return { fullText, usage };
}

export async function completeOllamaText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
}): Promise<string> {
  const result = await streamOllama({
    model: params.model,
    systemPrompt: params.systemPrompt ?? "",
    messages: [{ role: "user", content: params.user }],
  });
  return result.fullText;
}
