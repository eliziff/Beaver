import type { ProtocolEvent } from "./assistantSession";
import { publicEvent } from "../../../../backend/src/lib/chat/assistantWire";
export { ASSISTANT_LIMITS, FIELD_TEXT_LIMIT, SHORT_TEXT_LIMIT, parseAssistantCitations }
  from "../../../../backend/src/lib/chat/assistantWire";

export const ASSISTANT_GENERIC_ERROR = "Unable to get a response. Try again.";
const status = (value: "running" | "completed" | "error" | "interrupted" | "cancelled") =>
  value === "cancelled" ? "interrupted" as const : value;
export function parseAssistantProtocolEvent(value: unknown) {
  try {
    const parsed = publicEvent.safeParse(value);
    if (!parsed.success) return { ok: false as const };
    const event = parsed.data;
    const project = (): ProtocolEvent => {
      switch (event.type) {
        case "content": return { type: "content_block", text: event.text };
        case "reasoning_delta": return { type: "reasoning", text: event.text, append: true };
        case "reasoning": return { ...event, append: false, done: true };
        case "reasoning_block_end": return { type: "reasoning", text: "", append: false, done: true };
        case "error": return event.message.trim() === "Cancelled by user."
          ? { type: "turn_status", status: "cancelled" }
          : { ...event, message: ASSISTANT_GENERIC_ERROR, retryable: event.retryable !== false };
        case "ask_inputs": case "ask_inputs_response": return { type: event.type, event } as ProtocolEvent;
        case "tool_activity": {
          const { type: _type, ...activity } = event;
          return { type: "activity", activity: { ...activity, status: status(activity.status) } };
        }
        case "workflow_run": return { type: "workflow_run", run: { ...event,
          id: event.id || `${event.tool}:${event.job_id || "run"}`,
          ...(event.error && { error: "Workflow failed." }) } };
        case "subagent_run": {
          const { type: _type, activity, activities, ...reader } = event;
          return { type: "reader", reader: { ...reader, status: status(reader.status),
            citations: reader.citations ?? [], activities: (activities ?? (activity ? [activity] : []))
              .map((item) => ({ ...item, status: status(item.status) })) } };
        }
        case "context_usage": return { type: "context_usage", usedTokens: event.used_tokens, windowTokens: event.window_tokens };
        case "document_artifact": return { type: "artifact", artifact: {
          id: `${event.action}:${event.document_id}`, type: event.action, filename: event.filename,
          documentId: event.document_id, versionId: event.version_id, versionNumber: event.version_number,
          annotations: event.annotations ?? [], ...(event.action === "edited" && { editMode: event.edit_mode ?? "manual" }),
        } };
        default: return event;
      }
    };
    return { ok: true as const, event: project() };
  } catch { return { ok: false as const }; }
}
