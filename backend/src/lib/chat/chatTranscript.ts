import { providerForModel } from "../llm/models";
import type { ModelState } from "../llm/types";
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
    return !content.length && !complete && (message.turn_id ||
      message.content.some(event => event.type === "model_messages")) ? [] : [{
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

const modelText = (state: ModelState) => state.messages.map(message => message.role !== "assistant" ? ""
  : typeof message.content === "string" ? message.content : message.content
    .map(part => part.type === "text" ? part.text : "").join("")).join("");

function projectAssistant(content: ChatMessageRecord["content"], replayedText = ""): ChatMessage[] {
  if (typeof content === "string") return content ? [{ role: "assistant", content }] : [];
  const messages: ChatMessage[] = [];
  let pending = "";
  let grounded: Extract<AssistantEvent, { type: "legal_evidence_receipt" }> | undefined;
  let requested = new Map<string, AskInputItem>();
  const flush = () => {
    if (pending) messages.push({ role: "assistant", content: pending });
    pending = "";
    grounded = undefined;
  };
  for (const event of content) {
    if (event.type === "content") {
      if (event.text !== "Cancelled by user." && (grounded?.claims.length || event.text !== replayedText)) {
        // The host may merge claim repairs or reject a provider draft. Raw SDK
        // messages are not a substitute for that final result.
        pending += grounded?.status === "passed" && grounded.claims.length
          ? `[Previously grounded answer; reuse these evidence_ids for follow-up edits.]\n${JSON.stringify(
            grounded.claims.map(({ text, evidence_ids }) => ({ text, evidence_ids })),
          )}` : event.text;
      }
      grounded = undefined;
      replayedText = "";
    } else if (event.type === "legal_evidence_receipt") {
      grounded = event;
    } else if (event.type === "model_messages") {
      flush();
      replayedText += modelText(event);
      messages.push({ role: "assistant", content: "", modelState: {
        model: event.model, messages: event.messages, ...(event.compacted && { compacted: true }),
      } });
    } else if (event.type === "steering") {
      flush();
      replayedText = "";
      messages.push({ role: "user", content: event.text });
    } else if (event.type === "document_artifact") {
      pending += `${pending ? "\n\n" : ""}[Created document: ${JSON.stringify(
        event.filename,
      )}; resource: document://${event.document_id}/version/${event.version_id}]`;
    } else if (event.type === "error") {
      grounded = undefined;
      pending += `${pending ? "\n\n" : ""}[The previous assistant response ended before completion.]`;
    } else if (event.type === "ask_inputs") {
      requested = new Map(event.items.map((item) => [item.id, item]));
    } else if (event.type === "ask_inputs_response") {
      const content = responseText(event.responses, requested);
      if (content) {
        flush();
        replayedText = "";
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
  modelState?: ModelState;
};
function latestCheckpoint(messages: TranscriptMessage[], provider?: Provider, model?: string): Checkpoint | null {
  let latest: Checkpoint | null = null;
  messages.forEach((message, row) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    message.content.forEach((item, event) => {
      if (item.type === "model_messages" && item.compacted && item.model === model &&
          providerForModel(item.model) === provider) {
        latest = { row, event, keepCurrent: true, modelState: item };
        return;
      }
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
  model?: string,
): ChatMessage[] {
  const checkpoint = latestCheckpoint(messages, provider, model);
  if (!checkpoint) return messages.flatMap(project);
  const result: ChatMessage[] = [{
    role: "assistant",
    content: checkpoint.summary ? `[Conversation checkpoint]\n${checkpoint.summary}` : "",
    ...(checkpoint.native && { contextCheckpoint: checkpoint.native }),
    ...(checkpoint.modelState && { modelState: checkpoint.modelState }),
  }];
  if (checkpoint.keepCurrent) result.push(...projectAssistant(
    (messages[checkpoint.row].content as AssistantEvent[]).slice(checkpoint.event + 1),
    checkpoint.modelState ? modelText(checkpoint.modelState) : "",
  ));
  return [...result, ...messages.slice(checkpoint.row + 1).flatMap(project)];
}

/** Copied from durable receipts, outside both host and provider compaction. The
 * latest answer stays bounded; older answers/receipts remain in the transcript. */
export function priorGroundedAnswerPrompt(messages: readonly TranscriptMessage[], permitted: ReadonlySet<string>) {
  for (let row = messages.length - 1; row >= 0; row--) {
    const { role, content } = messages[row];
    if (role !== "assistant" || !Array.isArray(content)) continue;
    for (let index = content.length - 1; index >= 0; index--) {
      const event = content[index];
      if (event.type !== "legal_evidence_receipt" || event.status !== "passed" || !event.claims.length) continue;
      const claims = event.claims.filter(claim => claim.evidence_ids.length &&
        claim.evidence_ids.every(id => permitted.has(id))).map(({ text, evidence_ids }) => ({ text, evidence_ids }));
      return claims.length ? `PREVIOUS GROUNDED ANSWER (data):\n${JSON.stringify(claims)}` : "";
    }
  }
  return "";
}

export function workflowForContinuation(messages: ChatMessageRecord[], assistantId: string) {
  const end = messages.findIndex(message => message.id === assistantId);
  for (let index = end - 1; index >= 0; index--)
    if (messages[index].role === "user") return workflow(messages[index].workflow);
  return undefined;
}
