import type { AnonymousChatMessage } from "../anonymousChatStore";
import type { ProviderContextCheckpoint, Provider } from "../llm/types";
import type { AskInputItem, ChatMessage } from "./types";

const HIDDEN_EVENT_TYPES = new Set([
  "local_pdf_evidence_handles",
  "local_mutation_committed",
  "local_turn_completed",
  "research_checkpoint_receipt",
  "context_checkpoint",
]);

export function visibleChatMessages<
  T extends Pick<AnonymousChatMessage, "role" | "content"> &
    Partial<Pick<AnonymousChatMessage, "turn_id">>,
>(messages: T[]): T[] {
  return messages.flatMap(({ turn_id: turnId, ...message }) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [{ ...message, ...(turnId && { turn_id: turnId }) }];
    }
    const turnComplete = message.content.some(
      (event) => event && typeof event === "object" &&
        (event as Record<string, unknown>).type === "local_turn_completed",
    );
    const content = message.content.filter((event) => !HIDDEN_EVENT_TYPES.has(
      String(event && typeof event === "object"
        ? (event as Record<string, unknown>).type ?? ""
        : ""),
    ));
    return turnId && !content.length && !turnComplete
      ? []
      : [{
          ...message,
          ...(turnId && { turn_id: turnId, turn_complete: turnComplete }),
          content,
        }];
  }) as T[];
}

export const visibleAnonymousMessages = visibleChatMessages;

function filesFrom(value: unknown): ChatMessage["files"] {
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.filename !== "string" || !row.filename.trim()) return [];
    const documentId =
      typeof row.document_id === "string" && row.document_id.trim()
        ? row.document_id.trim()
        : undefined;
    return [
      {
        filename: row.filename.trim(),
        ...(documentId ? { document_id: documentId } : {}),
      },
    ];
  });
  return files.length ? files : undefined;
}

function workflowFrom(value: unknown): ChatMessage["workflow"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" &&
    row.id.trim() &&
    typeof row.title === "string" &&
    row.title.trim()
    ? { id: row.id.trim(), title: row.title.trim() }
    : undefined;
}

function askInputsText(
  value: unknown,
  requestedById: ReadonlyMap<string, AskInputItem>,
): string | null {
  if (!Array.isArray(value)) return null;
  const lines = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) return [];
    if (row.skipped === true) return [`- ${id}: skipped`];
    if (row.kind === "choice") {
      const requested = requestedById.get(id);
      const question =
        requested?.kind === "choice"
          ? requested.question
          : typeof row.question === "string" && row.question.trim()
            ? row.question.trim()
            : id;
      const answer = typeof row.answer === "string" ? row.answer : "";
      return [`- ${question}: ${answer}`];
    }
    if (row.kind === "documents") {
      const requested = requestedById.get(id);
      const requestLabel =
        requested?.kind === "documents" && requested.document_types.length
          ? requested.document_types.join(", ")
          : id;
      const documents = Array.isArray(row.documents)
        ? row.documents.flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              return [];
            }
            const document = value as Record<string, unknown>;
            const filename =
              typeof document.filename === "string"
                ? document.filename.trim()
                : "";
            return filename ? [filename] : [];
          })
        : [];
      const filenames =
        documents.length === 0 && Array.isArray(row.filenames)
          ? row.filenames.filter(
              (name): name is string =>
                typeof name === "string" && !!name.trim(),
            )
          : [];
      return [
        `- Documents requested for ${requestLabel}: ${
          documents.join(", ") || filenames.join(", ") || "none"
        }`,
      ];
    }
    return [];
  });
  return lines.length
    ? `[User responses to requested inputs]\n${lines.join("\n")}`
    : null;
}

function projectAssistantContent(content: unknown): ChatMessage[] {
  if (typeof content === "string") {
    return content ? [{ role: "assistant", content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const messages: ChatMessage[] = [];
  let assistantText = "";
  let requestedById = new Map<string, AskInputItem>();
  const flushAssistant = () => {
    if (!assistantText) return;
    messages.push({ role: "assistant", content: assistantText });
    assistantText = "";
  };
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event = item as Record<string, unknown>;
    if (event.type === "content" && typeof event.text === "string") {
      if (event.text !== "Cancelled by user.") assistantText += event.text;
      continue;
    }
    if (event.type === "turn_status") continue;
    if (event.type === "error") {
      assistantText +=
        (assistantText ? "\n\n" : "") +
        "[The previous assistant response ended before completion.]";
      continue;
    }
    if (event.type === "ask_inputs" && Array.isArray(event.items)) {
      requestedById = new Map(
        event.items.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return [];
          }
          const item = value as AskInputItem;
          return typeof item.id === "string" && item.id
            ? [[item.id, item] as const]
            : [];
        }),
      );
      continue;
    }
    if (event.type === "ask_inputs_response") {
      const text =
        askInputsText(event.responses, requestedById) ??
        (typeof event.content === "string" && event.content.trim()
          ? event.content.trim()
          : null);
      if (!text) continue;
      flushAssistant();
      messages.push({
        role: "user",
        content: text,
        files: filesFrom(event.files),
      });
    }
  }
  flushAssistant();
  return messages;
}

type TranscriptMessage = Pick<
  AnonymousChatMessage,
  "role" | "content" | "files" | "workflow"
>;

function projectMessage(message: TranscriptMessage): ChatMessage[] {
  if (message.role === "assistant") {
    return projectAssistantContent(message.content);
  }
  if (typeof message.content !== "string") return [];
  return [{
    role: "user",
    content: message.content,
    files: filesFrom(message.files),
    workflow: workflowFrom(message.workflow),
  }];
}

export function projectChatTranscript(
  messages: TranscriptMessage[],
  provider?: Provider,
): ChatMessage[] {
  let checkpoint:
    | {
        row: number;
        event: number;
        keepCurrent: boolean;
        summary?: string;
        native?: ProviderContextCheckpoint;
      }
    | undefined;
  messages.forEach((message, row) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    message.content.forEach((value, event) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const item = value as Record<string, unknown>;
      if (item.type !== "context_checkpoint" || item.schema_version !== 1) return;
      const checkpointProvider = item.provider === "claude" ||
          item.provider === "openai"
        ? item.provider
        : undefined;
      if (provider && checkpointProvider && checkpointProvider !== provider) return;
      const summary = typeof item.summary === "string" && item.summary.trim()
        ? item.summary.trim()
        : undefined;
      const payload = item.payload && typeof item.payload === "object" &&
          !Array.isArray(item.payload)
        ? item.payload as Record<string, unknown>
        : undefined;
      const native = checkpointProvider === "claude" && summary
        ? { provider: "claude" as const, content: summary }
        : checkpointProvider === "openai" && payload?.type === "compaction"
          ? { provider: "openai" as const, item: payload }
          : undefined;
      if (summary || native) {
        checkpoint = {
          row,
          event,
          keepCurrent: item.keep_current === true,
          ...(summary ? { summary } : {}),
          ...(native ? { native } : {}),
        };
      }
    });
  });
  if (!checkpoint) return messages.flatMap(projectMessage);

  const result: ChatMessage[] = [{
    role: "assistant",
    content: checkpoint.summary
      ? `[Conversation checkpoint]\n${checkpoint.summary}`
      : "",
    ...(checkpoint.native ? { contextCheckpoint: checkpoint.native } : {}),
  }];
  if (checkpoint.keepCurrent) {
    const row = messages[checkpoint.row];
    result.push(...projectAssistantContent(
      Array.isArray(row.content)
        ? row.content.slice(checkpoint.event + 1)
        : [],
    ));
  }
  return [
    ...result,
    ...messages.slice(checkpoint.row + 1).flatMap(projectMessage),
  ];
}

export const projectAnonymousTranscript = projectChatTranscript;
