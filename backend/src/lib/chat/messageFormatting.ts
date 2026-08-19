import type { ChatMessage } from "./types";

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
