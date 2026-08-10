import { describe, expect, it } from "vitest";
import {
  finishAssistantStreamEvents,
  reduceAssistantStreamEvent,
} from "./assistantStreamEvents";
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
  it("replaces a running reading agent with its cited findings", () => {
    let events: AssistantEvent[] = [];
    events = reduce(events, {
      type: "subagent_run",
      id: "read-1",
      agent: "scout",
      task: "Find the renewal clause.",
      model: "GPT-5.6 Luna",
      effort: "high",
      status: "running",
      activities: [
        {
          id: "search-1",
          label: "Searching Canadian case law",
          status: "completed",
        },
        {
          id: "read-1",
          label: "Reading Lease.pdf",
          status: "running",
        },
      ],
    });
    expect(events.filter((event) => event.type === "subagent_run")).toHaveLength(1);

    events = reduce(events, {
      type: "subagent_run",
      id: "read-1",
      agent: "scout",
      task: "Find the renewal clause.",
      model: "GPT-5.6 Luna",
      effort: "high",
      status: "running",
      activities: [
        {
          id: "search-1",
          label: "Searching case law · Canada for “renewal clauses”",
          status: "running",
        },
      ],
    });
    events = reduce(events, {
      type: "subagent_run",
      id: "read-1",
      agent: "scout",
      task: "Find the renewal clause.",
      model: "GPT-5.6 Luna",
      effort: "high",
      status: "completed",
      output: "Lease.pdf, p. 4: \"Renews yearly.\"",
      sources: [{
        provider: "a2aj",
        jurisdiction: "CA",
        citation: "2020 BCSC 1",
        name: "Example v. Example",
        dataset: "BCSC",
        url: "https://example.test/case",
        locator: "par15",
        quote: "The exact passage.",
      }],
      activities: [
        {
          id: "search-1",
          label: "Searching case law · Canada for “renewal clauses”",
          status: "completed",
          source: {
            provider: "courtlistener",
            jurisdiction: "US",
            citation: "410 U.S. 113",
            name: "Roe v. Wade",
            dataset: "scotus",
            url: "https://example.test/roe",
            clusterId: 108713,
          },
        },
      ],
      grounding: { status: "passed", evidence: [{ evidence_id: "e_lease" }] },
    });

    expect(events[0]).toMatchObject({
      type: "subagent_run",
      id: "read-1",
        status: "completed",
        isStreaming: false,
        activities: [
          expect.objectContaining({
            id: "search-1",
            status: "completed",
            source: expect.objectContaining({
              citation: "410 U.S. 113",
              clusterId: 108713,
            }),
          }),
        ],
        sources: [expect.objectContaining({
          citation: "2020 BCSC 1",
          locator: "par15",
          quote: "The exact passage.",
        })],
      grounding: {
        status: "passed",
        evidence: [{ evidence_id: "e_lease" }],
      },
    });
    expect(events).toHaveLength(1);
  });

  it("starts a new parent bubble after a tool pause", () => {
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
      { type: "content", text: "The " },
      {
        type: "courtlistener_search_case_law",
        query: "Hansman",
        isStreaming: true,
      },
      { type: "content", text: "answer.", isStreaming: true },
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

  it("keeps completed generic tool calls as an activity trail", () => {
    let events: AssistantEvent[] = [];
    events = reduce(events, {
      type: "tool_call_start",
      name: "a2aj_search",
      label: "Searching BCCA cases for “support”",
    });
    events = reduce(events, {
      type: "tool_call_start",
      name: "a2aj_search",
      label: "Searching SCC cases for “support”",
    });

    expect(finishAssistantStreamEvents(events)).toEqual([
      {
        type: "tool_call_start",
        name: "a2aj_search",
        label: "Searching BCCA cases for “support”",
        isStreaming: false,
      },
      {
        type: "tool_call_start",
        name: "a2aj_search",
        label: "Searching SCC cases for “support”",
      },
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

  it("completes only the matching concurrent document activity", () => {
    let events: AssistantEvent[] = [];
    events = reduce(events, {
      type: "doc_find_start",
      filename: "one.docx",
      query: "notice",
    });
    events = reduce(events, {
      type: "doc_find_start",
      filename: "two.docx",
      query: "notice",
    });
    events = reduce(events, {
      type: "doc_find",
      filename: "one.docx",
      query: "notice",
      total_matches: 2,
    });

    expect(events.slice(0, 2)).toEqual([
      expect.objectContaining({
        type: "doc_find",
        filename: "one.docx",
        isStreaming: false,
      }),
      expect.objectContaining({
        type: "doc_find",
        filename: "two.docx",
        isStreaming: true,
      }),
    ]);
  });

  it("rejects start aliases the backend does not emit", () => {
    expect(
      reduceAssistantStreamEvent([], {
        type: "workflow_applied_start",
        workflow_id: "workflow-1",
        title: "Review",
      }),
    ).toBeNull();
  });
});

it("finishes mixed stream events in one stable pass", () => {
  const done = {
    type: "doc_read" as const,
    filename: "done.docx",
    isStreaming: false,
  };
  const events: AssistantEvent[] = [
    { type: "thinking", isStreaming: true },
    { type: "reasoning", text: "Checked", isStreaming: true },
    { type: "content", text: "Answer.", isStreaming: true },
    { type: "doc_read", filename: "brief.docx", isStreaming: true },
    done,
  ];

  expect(finishAssistantStreamEvents(events)).toEqual([
    { type: "reasoning", text: "Checked" },
    { type: "content", text: "Answer." },
    { type: "doc_read", filename: "brief.docx" },
    done,
  ]);
  const clean = [done];
  expect(finishAssistantStreamEvents(clean)).toBe(clean);
});
