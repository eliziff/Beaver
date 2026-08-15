import type {
  AskInputResponseItem,
  AskInputsResponseRequest,
  ChatMessage,
} from "./types";

export function formatChatMessageContent(
  message: ChatMessage,
  slugByDocumentId: ReadonlyMap<string, string> = new Map(),
) {
  let content = message.content ?? "";
  if (message.role !== "user") return content;
  if (message.workflow) {
    content = `[Workflow: ${message.workflow.title} (id: ${message.workflow.id})]\n\n${content}`;
  }
  if (message.files?.length) {
    const lines = message.files.map((file) => {
      const slug = file.document_id
        ? slugByDocumentId.get(file.document_id)
        : undefined;
      if (slug && slug !== file.filename) return `- ${slug}: ${file.filename}`;
      return `- ${file.filename}`;
    });
    content = `[The user attached the following document(s) to this message:\n${lines.join("\n")}]\n\n${content}`;
  }
  return content;
}

function cleanAskInputResponseId(value: unknown) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.slice(0, 80);
}

export function parseAskInputsResponsePayload(
  value: unknown,
): AskInputsResponseRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rawResponses = Array.isArray(row.responses) ? row.responses : [];
  const responses = rawResponses
    .map((item): AskInputResponseItem | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const current = item as Record<string, unknown>;
      const id = cleanAskInputResponseId(current.id);
      const kind = current.kind;
      const skipped = current.skipped === true;
      if (!id || (kind !== "choice" && kind !== "documents")) return null;
      if (kind === "choice") {
        const question =
          typeof current.question === "string"
            ? current.question.trim().slice(0, 500)
            : "";
        const answer =
          typeof current.answer === "string"
            ? current.answer.trim().slice(0, 1000)
            : "";
        if (!question || (!answer && !skipped)) return null;
        return {
          id,
          kind,
          question,
          ...(answer ? { answer } : {}),
          ...(skipped ? { skipped: true } : {}),
        };
      }
      const rawFilenames = Array.isArray(current.filenames)
        ? current.filenames
        : [];
      const filenames = rawFilenames
        .filter((f): f is string => typeof f === "string")
        .map((f) => f.trim())
        .filter(Boolean)
        .slice(0, 50);
      return {
        id,
        kind,
        filenames,
        ...(skipped ? { skipped: true } : {}),
      };
    })
    .filter((item): item is AskInputResponseItem => !!item)
    .slice(0, 20);
  return responses.length > 0 ? { responses } : null;
}
