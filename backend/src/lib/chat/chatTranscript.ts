import type { ChatMessageRecord } from "../chatStore";
import type { Provider, ProviderContextCheckpoint } from "../llm/types";
import type { AskInputItem, ChatMessage } from "./types";

const HIDDEN = new Set([
  "pdf_evidence_handles",
  "local_mutation_committed",
  "local_turn_completed",
  "research_checkpoint_receipt",
  "context_checkpoint",
]);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function visibleChatMessages<
  T extends Pick<ChatMessageRecord, "role" | "content"> &
    Partial<Pick<ChatMessageRecord, "turn_id">>,
>(messages: T[]): T[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
    const complete = message.content.some((value) => record(value)?.type === "local_turn_completed");
    const content = message.content.filter((value) => !HIDDEN.has(String(record(value)?.type ?? "")));
    return message.turn_id && !content.length && !complete ? [] : [{
      ...message,
      ...(message.turn_id && { turn_complete: complete }),
      content,
    }];
  }) as T[];
}

const files = (value: unknown): ChatMessage["files"] => {
  const parsed = Array.isArray(value) ? value.flatMap((item) => {
    const row = record(item), filename = text(row?.filename);
    if (!filename) return [];
    const documentId = text(row?.document_id);
    return [{ filename, ...(documentId && { document_id: documentId }) }];
  }) : [];
  return parsed.length ? parsed : undefined;
};
const workflow = (value: unknown): ChatMessage["workflow"] => {
  const row = record(value), id = text(row?.id), title = text(row?.title);
  return id && title ? { id, title } : undefined;
};

function responseText(value: unknown, requested: ReadonlyMap<string, AskInputItem>) {
  const lines = Array.isArray(value) ? value.flatMap((item) => {
    const row = record(item), id = text(row?.id);
    if (!row || !id) return [];
    if (row.skipped === true) return [`- ${id}: skipped`];
    const request = requested.get(id);
    if (row.kind === "choice") {
      const question = request?.kind === "choice" ? request.question : text(row.question) || id;
      return [`- ${question}: ${typeof row.answer === "string" ? row.answer : ""}`];
    }
    if (row.kind !== "documents") return [];
    const label = request?.kind === "documents" && request.document_types.length
      ? request.document_types.join(", ") : id;
    const selected = files(row.documents)?.map(({ filename }) => filename) ?? [];
    const names = selected.length ? selected
      : Array.isArray(row.filenames) ? row.filenames.map(text).filter(Boolean) : [];
    return [`- Documents requested for ${label}: ${names.join(", ") || "none"}`];
  }) : [];
  return lines.length ? `[User responses to requested inputs]\n${lines.join("\n")}` : null;
}

function projectAssistant(content: unknown): ChatMessage[] {
  if (typeof content === "string") return content ? [{ role: "assistant", content }] : [];
  if (!Array.isArray(content)) return [];
  const messages: ChatMessage[] = [];
  let pending = "";
  let requested = new Map<string, AskInputItem>();
  const flush = () => {
    if (pending) messages.push({ role: "assistant", content: pending });
    pending = "";
  };
  for (const value of content) {
    const event = record(value);
    if (!event) continue;
    if (event.type === "content" && typeof event.text === "string") {
      if (event.text !== "Cancelled by user.") pending += event.text;
    } else if (event.type === "error") {
      pending += `${pending ? "\n\n" : ""}[The previous assistant response ended before completion.]`;
    } else if (event.type === "ask_inputs" && Array.isArray(event.items)) {
      requested = new Map(event.items.flatMap((item) => {
        const row = record(item);
        return typeof row?.id === "string" && row.id
          ? [[row.id, row as AskInputItem] as const] : [];
      }));
    } else if (event.type === "ask_inputs_response") {
      const content = responseText(event.responses, requested) || text(event.content);
      if (content) {
        flush();
        messages.push({ role: "user", content, files: files(event.files) });
      }
    }
  }
  flush();
  return messages;
}

type TranscriptMessage = Pick<ChatMessageRecord, "role" | "content" | "files" | "workflow">;
const project = (message: TranscriptMessage): ChatMessage[] =>
  message.role === "assistant" ? projectAssistant(message.content)
    : typeof message.content === "string" ? [{
        role: "user",
        content: message.content,
        files: files(message.files),
        workflow: workflow(message.workflow),
      }] : [];

type Checkpoint = {
  row: number;
  event: number;
  keepCurrent: boolean;
  summary?: string;
  native?: ProviderContextCheckpoint;
};
function latestCheckpoint(messages: TranscriptMessage[], provider?: Provider): Checkpoint | null {
  let latest: Checkpoint | null = null;
  messages.forEach((message, row) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    message.content.forEach((value, event) => {
      const item = record(value), kind = item?.provider;
      if (item?.type !== "context_checkpoint" || item.schema_version !== 1 ||
          (provider && (kind === "claude" || kind === "openai") && kind !== provider)) return;
      const summary = text(item.summary) || undefined;
      const payload = record(item.payload);
      const native = kind === "claude" && summary && payload?.type === "compaction"
        ? { provider: "claude" as const, content: summary, block: payload }
        : kind === "openai" && payload?.type === "compaction"
          ? { provider: "openai" as const, item: payload } : undefined;
      if (summary || native) latest = {
        row, event, keepCurrent: item.keep_current === true,
        ...(summary && { summary }), ...(native && { native }),
      };
    });
  });
  return latest;
}

export function projectChatTranscript(
  messages: TranscriptMessage[],
  provider?: Provider,
): ChatMessage[] {
  const checkpoint = latestCheckpoint(messages, provider);
  if (!checkpoint) return messages.flatMap(project);
  const result: ChatMessage[] = [{
    role: "assistant",
    content: checkpoint.summary ? `[Conversation checkpoint]\n${checkpoint.summary}` : "",
    ...(checkpoint.native && { contextCheckpoint: checkpoint.native }),
  }];
  if (checkpoint.keepCurrent) result.push(...projectAssistant(
    (messages[checkpoint.row].content as unknown[]).slice(checkpoint.event + 1),
  ));
  return [...result, ...messages.slice(checkpoint.row + 1).flatMap(project)];
}
