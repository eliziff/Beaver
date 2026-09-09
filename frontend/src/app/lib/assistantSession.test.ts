import { ASSISTANT_LIMITS, parseAssistantCitations, parseAssistantProtocolEvent } from "./assistantProtocol";
import { safeAssistantUrl } from "./safeAssistantUrl";
import { describe, expect, it } from "vitest";
import backendEvents from "../../../../shared/test-fixtures/assistant-events.json";
import type { Message } from "@/app/lib/api/chat";
import {
  assistantSessionReducer,
  createAssistantSessionState,
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

describe("assistant protocol validation", () => {
  it("accepts the public events replayed by the backend job transport", () => {
    for (const event of backendEvents) {
      expect(parseAssistantProtocolEvent(JSON.parse(JSON.stringify(event))).ok,
        event.type).toBe(true);
    }
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

  it("preserves protocol defaults, normalization, and strict nested limits", () => {
    const workflow = parseAssistantProtocolEvent({
      type: "workflow_run", tool: "create_table_of_authorities", job_id: " job-1 ",
    });
    expect(workflow).toEqual({ ok: true, event: { type: "workflow_run", run: {
      type: "workflow_run", id: "create_table_of_authorities:job-1",
      tool: "create_table_of_authorities", status: "unknown", stage: "Workflow",
      job_id: "job-1",
    } } });
    expect(parseAssistantProtocolEvent({
      type: "workflow_run", id: "work-1", tool: "update_work_product", status: "complete",
      stage: "Update work product", work_product: {
        kind: "authorities", id: "authorities-1", revision: 4 }, requested_action: "open",
    })).toEqual({ ok: true, event: { type: "workflow_run", run: {
      type: "workflow_run", id: "work-1", tool: "update_work_product", status: "complete",
      stage: "Update work product", work_product: {
        kind: "authorities", id: "authorities-1", revision: 4 }, requested_action: "open",
    } } });
    expect(parseAssistantProtocolEvent({
      type: "workflow_run", id: "work-2", tool: "update_work_product", status: "complete",
      stage: "Update work product", work_product: {
        kind: "court-record", id: "draft-1", revision: 0 }, requested_action: "build",
    }).ok).toBe(false);
    expect(parseAssistantProtocolEvent({
      type: "tool_activity", id: "a", tool: "read", label: "Read",
      status: "cancelled",
    })).toEqual({ ok: true, event: { type: "activity", activity: {
      id: "a", tool: "read", label: "Read", status: "interrupted",
    } } });
    expect(parseAssistantProtocolEvent({
      type: "ask_inputs", items: [{ id: "q", kind: "documents", extra: true }],
    }).ok).toBe(false);
    expect(parseAssistantProtocolEvent({
      type: "ask_inputs", items: [{ id: "q", kind: "choice", question: "?",
        options: Array.from({ length: 33 }, (_, index) => ({ value: String(index) })) }],
    }).ok).toBe(false);
    expect(parseAssistantProtocolEvent({
      type: "content", text: "x".repeat(ASSISTANT_LIMITS.text + 1),
    }).ok).toBe(false);
  });

  it.each(["document", "sheet", "cell"])("retains Library %s pinpoints for clickable citations", (locator_kind) => {
    const citation = { kind: "document", ref: 3, document_id: "doc", filename: "Terms.xlsx",
      locator_kind, sheet: "Terms", cells: "B4", locator: "Terms!B4", pinpoint: "Terms!B4", quotes: [{ quote: "25.45", sheet: "Terms", cell: "B4" }] };
    expect(parseAssistantCitations([citation])).toEqual([citation]);
  });

  it("drops malformed citations and never throws on hostile event objects", () => {
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(parseAssistantCitations([revoked.proxy, {
      kind: "tabular", ref: 1, review_id: "r", col_index: 0, row_index: 0,
    }])).toEqual([expect.objectContaining({
      kind: "tabular", col_name: "", doc_name: "", quotes: [],
    })]);
    const hostile = {};
    Object.defineProperty(hostile, "type", { get() { throw new Error("nope"); } });
    expect(() => parseAssistantProtocolEvent(hostile)).not.toThrow();
    expect(parseAssistantProtocolEvent(hostile).ok).toBe(false);
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

  it("reopens the same assistant and readers for an exact turn retry", () => {
    const turnId = "turn-1";
    let state = assistantSessionReducer(createAssistantSessionState({ chatId: "chat-1" }), {
      type: "run_started",
      runId: "run-1",
      chatId: "chat-1",
      message: { ...user, turnId },
      options: { turnId },
    });
    state = applyRaw(state, {
      type: "subagent_run",
      id: "reader-1",
      task: "Read the record",
      status: "running",
      activities: [{
        id: "read-1", tool: "read", label: "Reading", status: "running",
        citations: [{ kind: "a2aj", ref: 1, source_class: "case",
          citation: "2020 BCSC 1", name: "Example v Example", dataset: "BCSC",
          url: null, quotes: [] }],
      }],
      citations: [],
    });
    state = assistantSessionReducer(state, {
      type: "run_interrupted",
      runId: "run-1",
      status: "interrupted",
    });

    const before = state.messages;
    state = assistantSessionReducer(state, {
      type: "run_started",
      runId: "run-2",
      chatId: "chat-1",
      message: { ...user, turnId },
      options: { turnId },
    });

    expect(state.messages).toHaveLength(before.length);
    expect(state.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(assistant(state)).toMatchObject({
      turnId,
      turnStatus: undefined,
      activities: [expect.objectContaining({
        id: "reader:reader-1",
        status: "interrupted",
      })],
    });
    expect(state.readers).toEqual([expect.objectContaining({
      id: "reader-1",
      status: "interrupted",
      activities: [expect.objectContaining({
        id: "read-1",
        status: "interrupted",
        citations: [expect.objectContaining({ ref: 1, citation: "2020 BCSC 1" })],
      })],
    })]);
    expect(state.run).toMatchObject({ id: "run-2", status: "running" });
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
    const steeringId = "22222222-2222-4222-8222-222222222222";
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

    state = assistantSessionReducer(state, { type: "steering_queued", runId: "run-1", id: steeringId, text: "Focus on Alberta" });
    state = assistantSessionReducer(state, { type: "steering_queued", runId: "run-1", id: steeringId, text: "Focus on Alberta" });
    expect(assistant(state).blocks.filter((block) => block.role === "user")).toEqual([{ id: `steering:${steeringId}`, role: "user", text: "Focus on Alberta" }]);
    state = applyRaw(state, { type: "steering", id: steeringId, text: "Focus on Alberta" });
    state = applyRaw(state, { type: "content_final", text: "Alberta answer.", citations: [] });
    expect(assistant(state).blocks).toEqual([
      { id: `steering:${steeringId}`, role: "user", text: "Focus on Alberta" },
      expect.objectContaining({ role: "assistant", text: "Alberta answer." }),
    ]);
  });

  it("isolates reader output from main response text while sharing activity status", () => {
    let state = running();
    state = applyRaw(state, { type: "subagent_run", id: "reader-1", task: "Read the record", status: "completed", output: "reader-only result", activities: [{ id: "r-tool", tool: "read", label: "Read", status: "completed" }], citations: [] });
    expect(assistantText(state)).toBe("");
    expect(assistant(state).activities).toEqual([expect.objectContaining({ id: "reader:reader-1", status: "completed", markdown: "reader-only result" })]);
    expect(state.readers[0].activities).toEqual([expect.objectContaining({ id: "r-tool", status: "completed" })]);
    state = applyRaw(state, { type: "content_final", text: "main response", citations: [] });
    expect(assistantText(state)).toBe("main response");
  });

  it("merges live reader deltas and replaces them with the durable terminal snapshot", () => {
    let state = running();
    state = applyRaw(state, {
      type: "subagent_run", id: "reader-1", task: "Read the record", status: "running",
    });
    state = applyRaw(state, {
      type: "subagent_run", id: "reader-1", task: "Read the record", status: "running",
      activity: { id: "search-1", tool: "search_sources", label: "Searching", status: "running" },
    });
    state = applyRaw(state, {
      type: "subagent_run", id: "reader-1", task: "Read the record", status: "running",
      activity: { id: "search-1", tool: "search_sources", label: "Searched", status: "completed" },
    });
    state = applyRaw(state, {
      type: "subagent_run", id: "reader-1", task: "Read the record", status: "running",
      activity: { id: "read-1", tool: "Read", label: "Reading", status: "running" },
    });
    state = applyRaw(state, {
      type: "subagent_run", id: "reader-1", task: "Read the record", status: "running",
    });

    expect(state.readers[0].activities).toEqual([
      expect.objectContaining({ id: "search-1", status: "completed" }),
      expect.objectContaining({ id: "read-1", status: "running" }),
    ]);

    state = applyRaw(state, {
      type: "subagent_run", id: "reader-1", task: "Read the record", status: "completed",
      output: "Done.",
      activities: [{ id: "read-1", tool: "Read", label: "Read", status: "completed" }],
      citations: [],
    });
    expect(state.readers[0]).toMatchObject({
      status: "completed", output: "Done.",
      activities: [{ id: "read-1", status: "completed" }],
    });
  });

  it("keeps every citation-heavy reader when reconciling a transcript", () => {
    const reader = (id: number, activityCount: number) => ({
      type: "subagent_run",
      id: `reader-${id}`,
      task: `Read assignment ${id}`,
      status: "completed",
      activities: Array.from({ length: activityCount }, (_, activity) => ({
        id: `reader-${id}:activity-${activity}`,
        tool: "read",
        label: "Read authority",
        status: "completed",
        citations: Array.from({ length: 4 }, (_, ref) => ({
          kind: "a2aj",
          source_class: "case",
          ref,
          citation: "2026 ABCA 1",
          name: "Example v. Example",
          dataset: "ABCA",
          url: null,
          quotes: [{ quote: "A grounded passage." }],
        })),
      })),
      citations: [],
    });
    const events = [reader(1, 84), reader(2, 12), reader(3, 12), reader(4, 96)];

    const state = createAssistantSessionState({ chatId: "chat-1", messages: [
      { ...user, id: "user-1" },
      { id: "assistant-1", role: "assistant", content: events, turn_complete: true },
    ] });

    expect(state.readers.map(({ id }) => id)).toEqual([
      "reader-1", "reader-2", "reader-3", "reader-4",
    ]);
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
      { type: "workflow_run", id: "call-1", tool: "create_table_of_authorities",
        job_id: "a".repeat(32), stage: "Build", status: "complete", progress: 100,
        counts: [{ label: "Outputs", value: 1 }],
        outputs: [{ name: "Book.pdf", url: "/download/book" }],
        app_url: "/table-of-authorities?draft=abc" },
    ];
    let live = running();
    rawEvents.slice(1).forEach((event) => { live = applyRaw(live, event); });
    live = applyRaw(live, { type: "content_final", text: "Answer [1]", citations: [{ kind: "document", ref: 1, document_id: "d1", filename: "record.pdf", quotes: [{ page: 2, quote: "Exact passage" }] }] });
    live = assistantSessionReducer(live, { type: "run_finished", runId: "run-1" });

    const reload = createAssistantSessionState({ chatId: "chat-1", messages: [
      { ...user, id: "user-1" },
      { id: "assistant:run-1", role: "assistant", content: rawEvents, citations: [{ kind: "document", ref: 1, document_id: "d1", filename: "record.pdf", quotes: [{ page: 2, quote: "Exact passage" }] }], turn_complete: true },
    ] });
    expect(assistant(live).artifacts).toEqual([expect.objectContaining({
      type: "created", filename: "result.pptx", documentId: "d2",
      versionId: "v1", versionNumber: 1,
    })]);
    expect(assistant(live).workflowRuns).toEqual([expect.objectContaining({
      id: "call-1", stage: "Build", status: "complete",
      outputs: [{ name: "Book.pdf", url: "/download/book" }],
    })]);
    expect(assistant(reload)).toEqual({ ...assistant(live), turnComplete: true });
  });
});
