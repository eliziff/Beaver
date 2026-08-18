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
  ["content delta", { type: "content_delta", text: "a" }],
  ["content snapshot", { type: "content_snapshot", text: "a" }],
  ["content final", { type: "content_final", text: "a" }],
  ["content reset", { type: "content_reset" }],
  ["content block end", { type: "content_block_end" }],
  ["content done", { type: "content_done" }],
  ["durable content", { type: "content", text: "a" }],
  ["reasoning delta", { type: "reasoning_delta", text: "thinking" }],
  ["reasoning end", { type: "reasoning_block_end" }],
  ["durable reasoning", { type: "reasoning", text: "thought" }],
  ["thinking", { type: "thinking" }],
  ["MCP start", { type: "mcp_tool_start" }],
  ["MCP result", { type: "mcp_tool_result" }],
  ["MCP call", { type: "mcp_tool_call" }],
  ["evidence receipt", { type: "legal_evidence_receipt" }],
  ["context checkpoint", { type: "context_checkpoint" }],
  ["error", { type: "error", message: "provider details", retryable: true }],
  ["turn status", { type: "turn_status", status: "interrupted" }],
  ["steering", { type: "steering", id: "s1", text: "Focus on Alberta" }],
  ["citations", { type: "citations", status: "final", citations: [] }],
  ["ask inputs", { type: "ask_inputs", items: [{ id: "q1", kind: "choice", question: "Which?", options: [{ value: "A" }] }] }],
  ["ask response", { type: "ask_inputs_response", responses: [{ id: "q1", kind: "choice", question: "Which?", answer: "A" }] }],
  ["tool activity", { type: "tool_activity", id: "tool-1", tool: "search", label: "Searching", status: "running" }],
  ["automation", { type: "automation_run", id: "auto-1", tool: "create_table_of_authorities", status: "running", stage: "Scanning" }],
  ["reader", { type: "subagent_run", id: "reader-1", agent: "scout", task: "Read", model: "local", effort: "low", status: "running", activities: [], sources: [] }],
  ["context usage", { type: "context_usage", used_tokens: 10, window_tokens: 100 }],
  ["compaction", { type: "compaction", status: "completed" }],
  ["workflow", { type: "workflow_applied", workflow_id: "w1", title: "Review" }],
  ["document read start", { type: "doc_read_start", filename: "brief.docx" }],
  ["document read", { type: "doc_read", filename: "brief.docx" }],
  ["document find start", { type: "doc_find_start", filename: "brief.docx", query: "duty" }],
  ["document find", { type: "doc_find", filename: "brief.docx", query: "duty", total_matches: 2 }],
  ["document create start", { type: "doc_created_start", filename: "result.docx" }],
  ["document created", { type: "doc_created", filename: "result.docx", document_id: "d1", download_url: "/documents/d1/download" }],
  ["document download", { type: "doc_download", filename: "result.xlsx", download_url: "/documents/d2/download" }],
  ["document edit start", { type: "doc_edited_start", filename: "brief.docx" }],
  ["document edited", { type: "doc_edited", filename: "brief.docx", document_id: "d1", download_url: "/documents/d1/download", annotations: [] }],
  ["case search start", { type: "courtlistener_search_case_law_start", query: "duty" }],
  ["case search", { type: "courtlistener_search_case_law", query: "duty", result_count: 2 }],
  ["get cases start", { type: "courtlistener_get_cases_start", cluster_ids: [4] }],
  ["get cases", { type: "courtlistener_get_cases", cluster_ids: [4], case_count: 1, cases: [] }],
  ["find in case start", { type: "courtlistener_find_in_case_start", cluster_id: 4, query: "duty" }],
  ["find in case", { type: "courtlistener_find_in_case", cluster_id: 4, query: "duty", total_matches: 1 }],
  ["read case start", { type: "courtlistener_read_case_start", cluster_id: 4 }],
  ["read case", { type: "courtlistener_read_case", cluster_id: 4, opinion_count: 1 }],
  ["verify citations start", { type: "courtlistener_verify_citations_start", citation_count: 1 }],
  ["verify citations", { type: "courtlistener_verify_citations", citation_count: 1, match_count: 1 }],
  ["case citation", { type: "case_citation", cluster_id: 4, case_name: "R v Test", citation: "2026 ABCA 1", url: "https://example.test/case" }],
  ["case opinions", { type: "case_opinions", cluster_id: 4, case: { id: 4, opinions: [] } }],
];

describe("assistant protocol validation", () => {
  it.each(supportedEvents)("accepts the supported %s event", (_name, event) => {
    expect(parseAssistantProtocolEvent(event).ok).toBe(true);
  });

  it("rejects unknown, malformed, and prototype-polluting state mutations", () => {
    expect(parseAssistantProtocolEvent({ type: "new_frontend_state", value: true })).toEqual({ ok: false, reason: "unknown" });
    expect(parseAssistantProtocolEvent({ type: "content_snapshot" })).toEqual({ ok: false, reason: "malformed" });
    const polluted = JSON.parse('{"type":"content_delta","text":"bad","__proto__":{"polluted":true}}');
    expect(parseAssistantProtocolEvent(polluted)).toEqual({ ok: false, reason: "unsafe" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bounds collections and only permits safe URL protocols", () => {
    const citations = Array.from({ length: ASSISTANT_LIMITS.citations + 20 }, (_, ref) => ({
      type: "citation_data", kind: "document", ref, document_id: `d${ref}`,
      filename: `${ref}.docx`, quotes: [], url: "javascript:alert(1)",
    }));
    expect(parseAssistantCitations(citations)).toHaveLength(ASSISTANT_LIMITS.citations);
    expect(safeAssistantUrl("javascript:alert(1)")).toBeNull();
    expect(safeAssistantUrl("//evil.test/file")).toBeNull();
    expect(safeAssistantUrl("/documents/d1/download")).toBe("/documents/d1/download");
    expect(safeAssistantUrl("https://example.test/case")).toBe("https://example.test/case");
  });

  it("rejects unsafe citation and artifact URLs before render state", () => {
    let state = running();
    state = applyRaw(state, { type: "citations", citations: [{ type: "citation_data", kind: "case", ref: 1, cluster_id: 4, url: "javascript:alert(1)", pdfUrl: "data:text/html,bad", quotes: [] }] });
    state = applyRaw(state, { type: "doc_created", filename: "bad.docx", document_id: "d1", download_url: "https://evil.test/file" });
    expect(assistant(state).citations[0]).toMatchObject({ url: null, pdfUrl: null });
    expect(assistant(state).artifacts).toEqual([]);
  });
});

describe("assistantSessionReducer", () => {
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

  it("updates exactly one assistant message while text streams and bounds accumulated text", () => {
    let state = running();
    state = applyRaw(state, { type: "content_delta", text: "Hello " });
    state = applyRaw(state, { type: "content_delta", text: "world" });
    for (let index = 0; index < 20; index += 1) {
      state = applyRaw(state, { type: "content_delta", text: "x".repeat(65_536) });
    }
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(assistantText(state).startsWith("Hello world")).toBe(true);
    expect(assistantText(state).length).toBe(ASSISTANT_LIMITS.text);
  });

  it("pauses for ask-inputs, resumes with the answer, and records steering once", () => {
    let state = running();
    state = applyRaw(state, { type: "ask_inputs", items: [{ id: "q1", kind: "choice", question: "Which court?", options: [{ value: "ABCA" }] }] });
    expect(state.run?.status).toBe("paused");
    expect(state.pendingInput?.event.items[0].id).toBe("q1");

    state = applyRaw(state, { type: "ask_inputs_response", responses: [{ id: "q1", kind: "choice", question: "Which court?", answer: "ABCA" }] });
    expect(state.run?.status).toBe("running");
    expect(state.pendingInput).toBeNull();
    expect(assistant(state).activities[0]).toMatchObject({ status: "completed", label: "Asked for input" });

    state = assistantSessionReducer(state, { type: "steering_queued", runId: "run-1", id: "s1", text: "Focus on Alberta" });
    state = assistantSessionReducer(state, { type: "steering_queued", runId: "run-1", id: "s1", text: "Focus on Alberta" });
    expect(assistant(state).blocks.filter((block) => block.role === "user")).toEqual([{ id: "steering:s1", role: "user", text: "Focus on Alberta" }]);
  });

  it("isolates reader output from main response text while sharing activity status", () => {
    let state = running();
    state = applyRaw(state, { type: "subagent_run", id: "reader-1", agent: "scout", task: "Read the record", model: "local", effort: "low", status: "completed", output: "reader-only result", activities: [{ id: "r-tool", tool: "read", label: "Read", status: "completed" }], sources: [] });
    expect(assistantText(state)).toBe("");
    expect(assistant(state).activities).toEqual([expect.objectContaining({ id: "reader:reader-1", status: "completed", markdown: "reader-only result" })]);
    expect(state.readers[0].activities).toEqual([expect.objectContaining({ id: "r-tool", status: "completed" })]);
    state = applyRaw(state, { type: "content_delta", text: "main response" });
    expect(assistantText(state)).toBe("main response");
  });

  it("ignores late runs and events associated with another active chat", () => {
    const state = running();
    const event = parseAssistantProtocolEvent({ type: "content_delta", text: "stale" });
    expect(event.ok).toBe(true);
    if (!event.ok) return;
    expect(assistantSessionReducer(state, { type: "protocol", runId: "old-run", chatId: "chat-1", event: event.event })).toBe(state);
    expect(assistantSessionReducer(state, { type: "protocol", runId: "run-1", chatId: "other-chat", event: event.event })).toBe(state);
  });

  it("reconciles a transcript into the same visible timeline as its live events", () => {
    const rawEvents = [
      { type: "content_delta", text: "Answer" },
      { type: "tool_activity", id: "search-1", tool: "search", label: "Searched", status: "completed" },
      { type: "citations", status: "final", citations: [{ type: "citation_data", kind: "document", ref: 1, document_id: "d1", filename: "record.pdf", quotes: [{ page: 2, quote: "Exact passage" }] }] },
      { type: "doc_created", filename: "result.pptx", document_id: "d2", download_url: "/documents/d2/download" },
      { type: "content_block_end" },
    ];
    let live = running();
    rawEvents.forEach((event) => { live = applyRaw(live, event); });
    live = assistantSessionReducer(live, { type: "run_finished", runId: "run-1" });

    const reload = createAssistantSessionState({ chatId: "chat-1", messages: [
      user,
      { id: "assistant:run-1", role: "assistant", content: "", events: rawEvents, turnComplete: true },
    ] });
    expect(assistant(reload)).toEqual({ ...assistant(live), turnComplete: true });
  });
});
