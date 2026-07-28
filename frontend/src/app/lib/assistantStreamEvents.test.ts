import { describe, expect, it } from "vitest";
import { reduceAssistantStreamEvent } from "./assistantStreamEvents";
import type { AssistantEvent } from "@/app/components/shared/types";

function reduce(
  events: AssistantEvent[],
  data: Record<string, unknown>,
) {
  const result = reduceAssistantStreamEvent(events, data);
  expect(result).not.toBeNull();
  return result!.events;
}

describe("reduceAssistantStreamEvent", () => {
  it("keeps interleaved reasoning, tools, and content ordered", () => {
    let events: AssistantEvent[] = [];
    events = reduce(events, { type: "reasoning_delta", text: "Checking" });
    events = reduce(events, { type: "reasoning_block_end" });
    events = reduce(events, { type: "content_delta", text: "The " });
    events = reduce(events, {
      type: "courtlistener_search_case_law_start",
      query: "Hansman",
    });
    events = reduce(events, { type: "content_delta", text: "answer." });

    expect(events).toEqual([
      { type: "reasoning", text: "Checking" },
      { type: "content", text: "The answer.", isStreaming: true },
      {
        type: "courtlistener_search_case_law",
        query: "Hansman",
        isStreaming: true,
      },
    ]);
  });

  it("replaces CourtListener activity in place", () => {
    let events: AssistantEvent[] = [];
    events = reduce(events, {
      type: "courtlistener_search_case_law_start",
      query: "Hansman",
    });
    events = reduce(events, {
      type: "courtlistener_search_case_law",
      query: "Hansman",
      result_count: 2,
    });

    expect(events).toEqual([
      {
        type: "courtlistener_search_case_law",
        query: "Hansman",
        result_count: 2,
        error: undefined,
        isStreaming: false,
      },
      { type: "thinking", isStreaming: true },
    ]);
  });

  it("preserves document identity while completing a read", () => {
    let events: AssistantEvent[] = [];
    events = reduce(events, {
      type: "doc_read_start",
      filename: "brief.docx",
      document_id: "doc-1",
    });
    events = reduce(events, {
      type: "doc_read",
      filename: "brief.docx",
      document_id: "doc-1",
    });

    expect(events[0]).toEqual({
      type: "doc_read",
      filename: "brief.docx",
      document_id: "doc-1",
      isStreaming: false,
    });
  });
});
