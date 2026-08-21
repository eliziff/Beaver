import { describe, expect, it } from "vitest";
import type { Message } from "@/app/components/shared/types";
import {
  ASSISTANT_LIMITS,
  assistantSessionReducer,
  createAssistantSessionState,
  parseAssistantCitations,
  parseAssistantProtocolEvent,
  safeAssistantUrl,
  type AssistantMessageState,
  type AssistantSessionState,
  type AssistantTranscriptMessage,
} from "./assistantSession";

const user: Message = { id: "user-1", role: "user", content: "Research this" };

function running(chatId = "chat-1") {
  return assistantSessionReducer(createAssistantSessionState({ chatId }), {
    type: "run_started",
    runId: "run-1",
    chatId,
    message: user,
  });
}

function assistant(state: AssistantSessionState) {
  const message = state.messages.findLast((item) => item.role === "assistant");
  expect(message?.role).toBe("assistant");
  return message as AssistantMessageState;
}

const assistantText = (state: AssistantSessionState) =>
  assistant(state).blocks.filter(({ role }) => role === "assistant").map(({ text }) => text).join("\n\n");

function applyRaw(state: AssistantSessionState, raw: unknown) {
  const parsed = parseAssistantProtocolEvent(raw);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return state;
  return assistantSessionReducer(state, {
    type: "protocol",
    runId: "run-1",
    chatId: "chat-1",
    event: parsed.event,
  });
}

const supportedEvents: [string, Record<string, unknown>][] = [
  ["chat id", { type: "chat_id", chatId: "chat-1", transcriptVersion: 2 }],
  ["transcript version", { type: "transcript_version", transcriptVersion: 3 }],
  ["content final", { type: "content_final", text: "a", citations: [] }],
  ["durable content", { type: "content", text: "a" }],
  ["reasoning delta", { type: "reasoning_delta", text: "thinking" }],
  ["durable reasoning", { type: "reasoning", text: "thought through" }],
  ["reasoning end", { type: "reasoning_block_end" }],
  ["error", { type: "error", message: "provider details", retryable: true }],
  ["turn status", { type: "turn_status", status: "cancelled" }],
  ["steering", { type: "steering", id: "s1", text: "Focus on Alberta" }],
  ["ask inputs", { type: "ask_inputs", items: [{ id: "q1", kind: "choice", question: "Which?", options: [{ value: "A" }] }] }],
  ["ask response", { type: "ask_inputs_response", responses: [{ id: "q1", kind: "choice", answer: "A" }] }],
  ["tool activity", { type: "tool_activity", id: "tool-1", tool: "search", label: "Searching", status: "running" }],
  ["automation", { type: "automation_run", id: "auto-1", tool: "create_table_of_authorities", status: "running", stage: "Scanning" }],
  ["reader", { type: "subagent_run", id: "reader-1", task: "Read", status: "running", activities: [], sources: [] }],
  ["context usage", { type: "context_usage", used_tokens: 10, window_tokens: 100 }],
  ["compaction", { type: "compaction", status: "completed" }],
  ["document artifact", { type: "document_artifact", action: "created", filename: "result.docx", document_id: "d1", version_id: "v1", version_number: 1, download_url: "/documents/d1/download" }],
];

describe("assistant protocol validation", () => {
  it.each(supportedEvents)("accepts the supported %s event", (_name, event) => {
    expect(parseAssistantProtocolEvent(event).ok).toBe(true);
  });

  it("rejects unknown, malformed, and prototype-polluting state mutations", () => {
    expect(parseAssistantProtocolEvent({ type: "new_frontend_state", value: true }).ok).toBe(false);
    expect(parseAssistantProtocolEvent({ type: "content_snapshot" }).ok).toBe(false);
    expect(parseAssistantProtocolEvent({ type: "content_delta", text: "provisional" }).ok).toBe(false);
    expect(parseAssistantProtocolEvent({ type: "content_final", text: "missing citations" }).ok).toBe(false);
    const polluted = JSON.parse('{"type":"content_delta","text":"bad","__proto__":{"polluted":true}}');
    expect(parseAssistantProtocolEvent(polluted).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bounds collections and only permits safe URL protocols", () => {
    const citations = Array.from({ length: ASSISTANT_LIMITS.citations + 20 }, (_, ref) => ({
      kind: "document", ref, document_id: `d${ref}`,
      filename: `${ref}.docx`, quotes: [], url: "javascript:alert(1)",
    }));
    expect(parseAssistantCitations(citations)).toHaveLength(ASSISTANT_LIMITS.citations);
    expect(safeAssistantUrl("javascript:alert(1)")).toBeNull();
    expect(safeAssistantUrl("https://user:secret@example.test/")).toBeNull();
    expect(safeAssistantUrl("//evil.test/file")).toBeNull();
    expect(safeAssistantUrl("/documents/d1/download")).toBe("/documents/d1/download");
    expect(safeAssistantUrl("https://example.test/case")).toBe("https://example.test/case");
  });

  it("rejects unsafe citation and artifact URLs before render state", () => {
    let state = running();
    state = applyRaw(state, { type: "content_final", text: "Answer [1]", citations: [{ kind: "a2aj", ref: 1, citation: "Example", url: "javascript:alert(1)", quotes: [] }] });
    expect(parseAssistantProtocolEvent({ type: "document_artifact", action: "created", filename: "bad.docx", document_id: "d1", version_id: "v1", version_number: 1, download_url: "https://evil.test/file" }).ok).toBe(false);
    expect(assistant(state).citations[0]).toMatchObject({ url: null });
    expect(assistant(state).artifacts).toEqual([]);
  });
});

describe("assistantSessionReducer", () => {
  it("discards transcript attachments without durable document identities", () => {
    const malformed = {
      id: "user-1",
      role: "user",
      content: "Review this",
      files: [
        { filename: "record.pdf", document_id: "document-1" },
        { filename: "orphan.pdf" },
      ],
    } as unknown as AssistantTranscriptMessage;

    expect(createAssistantSessionState({ messages: [malformed] }).messages[0]).toMatchObject({
      files: [{ filename: "record.pdf", document_id: "document-1" }],
    });
  });

  it("upserts one activity row through running, completed, error, and interruption", () => {
    let state = running();
    state = applyRaw(state, { type: "tool_activity", id: "stable", tool: "search", label: "Searching", status: "running" });
    state = applyRaw(state, { type: "tool_activity", id: "stable", tool: "search", label: "Searched", status: "completed" });
    state = applyRaw(state, { type: "tool_activity", id: "stable", tool: "search", label: "Failed", status: "error" });
    expect(assistant(state).activities).toHaveLength(1);
    expect(assistant(state).activities[0]).toMatchObject({ id: "stable", status: "error" });

    state = applyRaw(state, { type: "tool_activity", id: "stable", tool: "search", label: "Searching", status: "running" });
    state = assistantSessionReducer(state, { type: "run_interrupted", runId: "run-1", status: "interrupted" });
    expect(assistant(state).activities).toEqual([expect.objectContaining({ id: "stable", status: "interrupted" })]);
  });

  it("keeps reasoning and tool activity in order and settles activity on failure", () => {
    let state = running();
    state = applyRaw(state, { type: "reasoning_delta", text: "Reviewing evidence ID generation" });
    state = applyRaw(state, { type: "reasoning_block_end" });
    state = applyRaw(state, { type: "tool_activity", id: "read-1", tool: "Read", label: "Reading paragraphs 93-130", status: "running" });
    state = applyRaw(state, { type: "tool_activity", id: "read-1", tool: "Read", label: "Reading paragraphs 93-130", status: "completed" });
    state = applyRaw(state, { type: "reasoning_delta", text: "Planning evidence referencing approach" });

    expect(assistant(state).activities).toEqual([
      expect.objectContaining({
        label: "Reviewing evidence ID generation",
        status: "completed",
      }),
      expect.objectContaining({
        id: "read-1",
        label: "Reading paragraphs 93-130",
        status: "completed",
      }),
      expect.objectContaining({
        label: "Planning evidence referencing approach",
        status: "running",
      }),
    ]);

    state = assistantSessionReducer(state, {
      type: "run_failed",
      runId: "run-1",
      message: "provider failure",
    });
    expect(state.run).toBeNull();
    expect(assistant(state).activities).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "error" }),
    ]);
  });

  it("reveals final prose and citations atomically", () => {
    let state = running();
    state = applyRaw(state, { type: "tool_activity", id: "read", tool: "Read", label: "Reading page 9", status: "running" });
    expect(assistantText(state)).toBe("");
    expect(assistant(state).citations).toEqual([]);
    state = applyRaw(state, {
      type: "content_final",
      text: "Hello world [1]",
      citations: [{ kind: "document", ref: 1, document_id: "d1", filename: "record.pdf", quotes: [{ page: 9, quote: "Hello world" }] }],
    });
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(assistantText(state)).toBe("Hello world [1]");
    expect(assistant(state)).toMatchObject({
      contentFinal: true,
      citations: [expect.objectContaining({ kind: "document", ref: 1 })],
      activities: [expect.objectContaining({ id: "read", status: "completed" })],
    });
    expect(state.run?.status).toBe("running");
  });

  it("pauses for ask-inputs, resumes with the answer, and records steering once", () => {
    let state = running();
    state = applyRaw(state, { type: "ask_inputs", items: [{ id: "q1", kind: "choice", question: "Which court?", options: [{ value: "ABCA" }] }] });
    expect(state.run?.status).toBe("paused");
    expect(state.pendingInput?.event.items[0].id).toBe("q1");
    expect(assistant(state).activities[0]).toMatchObject({
      tool: "ask_inputs", status: "completed", label: "Waiting for input",
    });

    state = applyRaw(state, { type: "ask_inputs_response", responses: [{ id: "q1", kind: "choice", answer: "ABCA" }] });
    expect(state.run?.status).toBe("running");
    expect(state.pendingInput).toBeNull();
    expect(assistant(state).activities[0]).toMatchObject({ status: "completed", label: "Asked for input" });

    state = assistantSessionReducer(state, { type: "steering_queued", runId: "run-1", id: "s1", text: "Focus on Alberta" });
    state = assistantSessionReducer(state, { type: "steering_queued", runId: "run-1", id: "s1", text: "Focus on Alberta" });
    expect(assistant(state).blocks.filter((block) => block.role === "user")).toEqual([{ id: "steering:s1", role: "user", text: "Focus on Alberta" }]);
  });

  it("isolates reader output from main response text while sharing activity status", () => {
    let state = running();
    state = applyRaw(state, { type: "subagent_run", id: "reader-1", task: "Read the record", status: "completed", output: "reader-only result", activities: [{ id: "r-tool", tool: "read", label: "Read", status: "completed" }], sources: [] });
    expect(assistantText(state)).toBe("");
    expect(assistant(state).activities).toEqual([expect.objectContaining({ id: "reader:reader-1", status: "completed", markdown: "reader-only result" })]);
    expect(state.readers[0].activities).toEqual([expect.objectContaining({ id: "r-tool", status: "completed" })]);
    state = applyRaw(state, { type: "content_final", text: "main response", citations: [] });
    expect(assistantText(state)).toBe("main response");
  });

  it("ignores late runs and events associated with another active chat", () => {
    const state = running();
    const event = parseAssistantProtocolEvent({ type: "content_final", text: "stale", citations: [] });
    expect(event.ok).toBe(true);
    if (!event.ok) return;
    expect(assistantSessionReducer(state, { type: "protocol", runId: "old-run", chatId: "chat-1", event: event.event })).toBe(state);
    expect(assistantSessionReducer(state, { type: "protocol", runId: "run-1", chatId: "other-chat", event: event.event })).toBe(state);
  });

  it("reconciles a transcript into the same visible timeline as its live events", () => {
    const rawEvents = [
      { type: "content", text: "Answer [1]" },
      { type: "tool_activity", id: "search-1", tool: "search", label: "Searched", status: "completed" },
      { type: "document_artifact", action: "created", filename: "result.pptx", document_id: "d2", version_id: "v1", version_number: 1, download_url: "/documents/d2/download" },
    ];
    let live = running();
    rawEvents.slice(1).forEach((event) => { live = applyRaw(live, event); });
    live = applyRaw(live, { type: "content_final", text: "Answer [1]", citations: [{ kind: "document", ref: 1, document_id: "d1", filename: "record.pdf", quotes: [{ page: 2, quote: "Exact passage" }] }] });
    live = assistantSessionReducer(live, { type: "run_finished", runId: "run-1" });

    const reload = createAssistantSessionState({ chatId: "chat-1", messages: [
      { ...user, id: "user-1" },
      { id: "assistant:run-1", role: "assistant", content: rawEvents, citations: [{ kind: "document", ref: 1, document_id: "d1", filename: "record.pdf", quotes: [{ page: 2, quote: "Exact passage" }] }], turn_complete: true },
    ] });
    expect(assistant(reload)).toEqual({ ...assistant(live), turnComplete: true });
  });
});
