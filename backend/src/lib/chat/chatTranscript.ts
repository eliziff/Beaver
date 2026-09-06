import type { ChatMessageRecord } from "../chatStore";
import type { Provider, ProviderContextCheckpoint } from "../llm/types";
import type { ChatMessage } from "./types";
import { publicAssistantEvent, type AssistantEvent, type AskInputItem,
  type AskInputResponseItem, type PublicTranscriptEvent } from "./assistantEvents";
import { jsonRecord as record, trimmedText as text } from "../value";

export type VisibleChatMessage = Omit<ChatMessageRecord, "content"> & {
  content: string | PublicTranscriptEvent[]; turn_complete?: boolean };
export function visibleChatMessages(messages: ChatMessageRecord[]): VisibleChatMessage[] {
  return messages.flatMap<VisibleChatMessage>((message) => {
    if (typeof message.content === "string") return [{ ...message, content: message.content }];
    const complete = message.content.some((value) => value.type === "local_turn_completed");
    const content = message.content.flatMap((value) => {
      const visible = publicAssistantEvent(value);
      return visible === null ? [] : [visible];
    });
    return message.turn_id && !content.length && !complete ? [] : [{
      ...message,
      ...(message.turn_id && { turn_complete: complete }),
      content,
    }];
  });
}

const files = (value: unknown): ChatMessage["files"] => {
  const parsed = Array.isArray(value) ? value.flatMap((item) => {
    const row = record(item), filename = text(row?.filename);
    const documentId = text(row?.document_id);
    return filename && documentId ? [{ filename, document_id: documentId }] : [];
  }) : [];
  return parsed.length ? parsed : undefined;
};
const workflow = (value: unknown): ChatMessage["workflow"] => {
  const row = record(value), id = text(row?.id), title = text(row?.title);
  const variantId = text(row?.variant_id);
  return id && title ? { id, ...(variantId && { variant_id: variantId }), title } : undefined;
};

function responseText(responses: AskInputResponseItem[], requested: ReadonlyMap<string, AskInputItem>) {
  const lines = responses.map((row) => {
    const id = row.id;
    const request = requested.get(id);
    if (row.kind === "choice") {
      if (!text(row.answer)) return `- ${id}: skipped`;
      const question = request?.kind === "choice" ? request.question : id;
      return `- ${question}: ${text(row.answer)}`;
    }
    const label = request?.kind === "documents" && request.document_types.length
      ? request.document_types.join(", ") : id;
    const selected = row.documents.map(({ filename }) => filename);
    return selected.length ? `- Documents requested for ${label}: ${selected.join(", ")}` : `- ${id}: skipped`;
  });
  return lines.length ? `[User responses to requested inputs]\n${lines.join("\n")}` : null;
}

const responseFiles = (responses: AskInputResponseItem[]) =>
  files(responses.flatMap((row) => row.kind === "documents" ? row.documents : []));

function projectAssistant(content: ChatMessageRecord["content"]): ChatMessage[] {
  if (typeof content === "string") return content ? [{ role: "assistant", content }] : [];
  const messages: ChatMessage[] = [];
  let pending = "";
  let requested = new Map<string, AskInputItem>();
  const flush = () => {
    if (pending) messages.push({ role: "assistant", content: pending });
    pending = "";
  };
  for (const event of content) {
    if (event.type === "content") {
      if (event.text !== "Cancelled by user.") pending += event.text;
    } else if (event.type === "document_artifact") {
      pending += `${pending ? "\n\n" : ""}[Created document: ${JSON.stringify(
        event.filename,
      )}; resource: document://${event.document_id}/version/${event.version_id}]`;
    } else if (event.type === "error") {
      pending += `${pending ? "\n\n" : ""}[The previous assistant response ended before completion.]`;
    } else if (event.type === "ask_inputs") {
      requested = new Map(event.items.map((item) => [item.id, item]));
    } else if (event.type === "ask_inputs_response") {
      const content = responseText(event.responses, requested);
      if (content) {
        flush();
        messages.push({ role: "user", content, files: responseFiles(event.responses) });
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
    message.content.forEach((item, event) => {
      if (item.type !== "context_checkpoint") return;
      const kind = item.provider;
      if (provider && (kind === "claude" || kind === "openai") && kind !== provider) return;
      const summary = text(item.summary) || undefined;
      const payload = item.payload;
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
    (messages[checkpoint.row].content as AssistantEvent[]).slice(checkpoint.event + 1),
  ));
  return [...result, ...messages.slice(checkpoint.row + 1).flatMap(project)];
}
