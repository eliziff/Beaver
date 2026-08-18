import type { ChatMessageRecord, ChatScope, ChatStore } from "../chatStore";
import {
  compactionThresholdForModel,
  estimateContextTokens,
  needsHostCheckpoint,
} from "../llm/contextWindow";
import { streamChatWithTools, type LlmMessage, type UserApiKeys } from "../llm";
import { providerForModel } from "../llm/models";
import type { Provider } from "../llm/types";
import { formatChatMessageContent } from "./messageFormatting";
import { projectChatTranscript } from "./chatTranscript";

const RECENT_TAIL_TOKENS = 20_000;
const CHECKPOINT_PROMPT = `Write a concise continuation checkpoint for an AI legal-work assistant.
Preserve the user's instructions and decisions, unfinished work, material conclusions, exact document names and identifiers, citations, changes already made, and the next concrete steps. Do not invent facts or reproduce long source passages. Return only the checkpoint.`;

export type ContextCheckpointEvent = {
  type: "context_checkpoint";
  schema_version: 1;
  summary: string;
  keep_current: boolean;
};

const checkpointRow = (message: ChatMessageRecord) =>
  message.role === "assistant" && Array.isArray(message.content) &&
  message.content.some((value) =>
    value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "context_checkpoint"
  );

function llmMessages(rows: ChatMessageRecord[], provider?: Provider): LlmMessage[] {
  return projectChatTranscript(rows, provider).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: formatChatMessageContent(message),
    images: message.images,
  }));
}

export function planContextCheckpoint(
  rows: ChatMessageRecord[],
  recentTailTokens = RECENT_TAIL_TOKENS,
  provider?: Provider,
) {
  let prior = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (checkpointRow(rows[index])) {
      prior = index;
      break;
    }
  }
  let boundary = -1;
  for (let index = rows.length - 1; index > prior; index -= 1) {
    if (rows[index].role !== "assistant") continue;
    const tail = llmMessages(rows.slice(index + 1), provider);
    if (estimateContextTokens({ messages: tail }) > recentTailTokens) break;
    boundary = index;
  }
  if (boundary < 0) return null;
  const source = llmMessages(rows.slice(0, boundary + 1), provider);
  return source.length
    ? { messageId: rows[boundary].id, source }
    : null;
}

async function summarize(
  model: string,
  messages: LlmMessage[],
  apiKeys: UserApiKeys | undefined,
  signal: AbortSignal | undefined,
) {
  const transcript = messages
    .map(({ role, content }) => `${role.toUpperCase()}: ${content}`)
    .join("\n\n");
  const result = await streamChatWithTools({
    model,
    systemPrompt: CHECKPOINT_PROMPT,
    messages: [{ role: "user", content: transcript }],
    maxIterations: 1,
    apiKeys,
    abortSignal: signal,
  });
  const summary = result.fullText.trim();
  if (!summary) throw new Error("Context compaction returned an empty checkpoint");
  return summary;
}

export async function compactChatContext(args: {
  store: ChatStore;
  scope: ChatScope;
  chatId: string;
  model: string;
  apiKeys?: UserApiKeys;
  signal?: AbortSignal;
  force?: boolean;
  onStatus?: (status: "running" | "completed" | "failed") => void;
}) {
  let rows = await args.store.transcript(args.scope, args.chatId);
  if (!rows) throw new Error("Chat not found");
  const provider = providerForModel(args.model);
  const messages = llmMessages(rows, provider);
  const threshold = compactionThresholdForModel(args.model);
  if (
    !args.force &&
    (!needsHostCheckpoint(args.model) || !threshold ||
      estimateContextTokens({ messages }) < threshold)
  ) {
    return { compacted: false, messages: projectChatTranscript(rows, provider) };
  }
  const plan = planContextCheckpoint(
    rows,
    Math.min(RECENT_TAIL_TOKENS, Math.floor((threshold ?? 80_000) / 4)),
    provider,
  );
  if (!plan) {
    return { compacted: false, messages: projectChatTranscript(rows, provider) };
  }
  args.onStatus?.("running");
  try {
    const summary = await summarize(
      args.model,
      plan.source,
      args.apiKeys,
      args.signal,
    );
    const event: ContextCheckpointEvent = {
      type: "context_checkpoint",
      schema_version: 1,
      summary,
      keep_current: false,
    };
    const appended = await args.store.appendAssistantEvent(
      args.scope,
      args.chatId,
      plan.messageId,
      event,
    );
    if (appended.status === "missing") {
      throw new Error("Context checkpoint boundary no longer exists");
    }
    if (appended.status === "conflict") {
      throw new Error("Chat changed while context was compacting");
    }
    rows = await args.store.transcript(args.scope, args.chatId);
    if (!rows) throw new Error("Chat not found");
    args.onStatus?.("completed");
    return { compacted: true, messages: projectChatTranscript(rows, provider) };
  } catch (error) {
    args.onStatus?.("failed");
    throw error;
  }
}
