import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { validateModelOutput } from "./structured";
import { providerForModel } from "./models";
import type {
  Provider,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";

export * from "./types";
export * from "./models";
export { ollamaModelCatalogSnapshot } from "./ollamaModels";

async function streamProvider(
  provider: Provider,
  params: StreamChatParams,
): Promise<StreamChatResult> {
  if (provider === "codex") return (await import("./codex")).streamCodex(params);
  if (provider === "claude-p") return (await import("./claudeP")).streamClaudeP(params);
  return (await import("./sdk")).streamHosted(params);
}

export async function streamChatWithTools(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const provider = providerForModel(params.model);
  const result = await streamProvider(provider, params);
  await appendMetrics(result);
  if (params.outputSchema && result.output === undefined) {
    const checked = validateModelOutput(params.outputSchema, JSON.parse(result.fullText));
    if (!checked.success) throw checked.error;
    result.output = checked.value;
  }
  return result;
}

let metricsQueue = Promise.resolve();
async function appendMetrics(result: StreamChatResult) {
  const filename = process.env.MIKE_LLM_METRICS_PATH?.trim();
  if (!filename) return;
  const line = `${JSON.stringify({
    usage: result.usage ?? null,
    rounds: result.contextRounds ?? [],
  })}\n`;
  const write = metricsQueue.then(async () => {
    await mkdir(path.dirname(filename), { recursive: true });
    await appendFile(filename, line, { encoding: "utf8", mode: 0o600 });
  });
  metricsQueue = write.catch(() => undefined);
  try {
    await write;
  } catch { console.warn("[llm] Could not append local metrics."); }
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

