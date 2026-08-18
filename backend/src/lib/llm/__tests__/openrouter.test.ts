import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChatWithTools } from "../index";
import type { Tool } from "../types";

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {} },
});

const runOpenRouter = streamChatWithTools;

function stream(...events: unknown[]) {
  const body = [
    ...events.map((event) => `data: ${JSON.stringify(event)}`),
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Muse Spark through OpenRouter", () => {
  it("keeps completed reasoning summaries as separate steps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stream(
          {
            type: "response.reasoning_summary_text.delta",
            delta: "**Planning final research**",
          },
          { type: "response.reasoning_summary_text.done" },
          {
            type: "response.reasoning_summary_text.delta",
            delta: "**Checking the authorities**",
          },
          { type: "response.reasoning_summary_text.done" },
          { type: "response.output_text.delta", delta: "done" },
        ),
      ),
    );
    const reasoning: string[] = [];

    await runOpenRouter({
      model: "meta/muse-spark-1.1",
      systemPrompt: "system",
      messages: [{ role: "user", content: "research" }],
      apiKeys: { openrouter: "test-key" },
      callbacks: {
        onReasoningDelta: (text) => reasoning.push(text),
        onReasoningBlockEnd: () => reasoning.push("end"),
      },
    });

    expect(reasoning).toEqual([
      "**Planning final research**",
      "end",
      "**Checking the authorities**",
      "end",
    ]);
  });

  it("uses the Responses endpoint with images and selected effort", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stream({
        type: "response.output_text.delta",
        delta: "done",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenRouter({
      model: "meta/muse-spark-1.1",
      systemPrompt: "system",
      messages: [{
        role: "user",
        content: "inspect",
        images: [{
          filename: "scan.png",
          mimeType: "image/png",
          data: "aW1hZ2U=",
        }],
      }],
      enableThinking: true,
      reasoningEffort: "low",
      apiKeys: { openrouter: "test-key" },
    });

    expect(result.fullText).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/responses",
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "meta/muse-spark-1.1",
      reasoning: { effort: "low" },
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,aW1hZ2U=",
          },
        ],
      }],
    });
  });

  it("replays output items on its stateless tool loop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        stream({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "library_list",
            arguments: "{}",
          },
        }),
      )
      .mockResolvedValueOnce(
        stream({
          type: "response.output_text.delta",
          delta: "2 files",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenRouter({
      model: "meta/muse-spark-1.1",
      systemPrompt: "system",
      messages: [{ role: "user", content: "list files" }],
      tools: [{
        type: "function",
        function: {
          name: "library_list",
          description: "List files",
          parameters: { type: "object", properties: {} },
        },
      }],
      apiKeys: { openrouter: "test-key" },
      runTools: async () => [{
        tool_use_id: "call-1",
        content: '{"count":2}',
      }],
    });

    expect(result.fullText).toBe("2 files");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body),
    );
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toEqual([
      { role: "user", content: "list files" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "library_list",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: '{"count":2}',
      },
    ]);
  });

  it("refreshes the shared Responses tool schema on the next iteration", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        stream({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "discover",
            arguments: "{}",
          },
        }),
      )
      .mockResolvedValueOnce(
        stream({ type: "response.output_text.delta", delta: "done" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    let activeTools = [tool("discover")];

    await runOpenRouter({
      model: "meta/muse-spark-1.1",
      systemPrompt: "system",
      messages: [{ role: "user", content: "research" }],
      apiKeys: { openrouter: "test-key" },
      tools: activeTools,
      resolveTools: () => activeTools,
      runTools: async () => {
        activeTools = [...activeTools, tool("revealed")];
        return [{ tool_use_id: "call-1", content: "opened" }];
      },
    });

    expect(fetchMock.mock.calls.map(([, init]) =>
      (JSON.parse(String((init as RequestInit).body)).tools as { name: string }[])
        .map((entry) => entry.name)
    )).toEqual([["discover"], ["discover", "revealed"]]);
  });

  it("announces a tool only after its complete arguments are available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stream(
          {
            type: "response.output_item.added",
            item: {
              type: "function_call",
              call_id: "call-lookup",
              name: "a2aj_lookup",
              arguments: "",
            },
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call-lookup",
              name: "a2aj_lookup",
              arguments:
                '{"citation":"2010 BCCA 170","locator":"10","end_locator":"12"}',
            },
          },
        ),
      ),
    );
    const calls: Array<Record<string, unknown>> = [];

    await runOpenRouter({
      model: "meta/muse-spark-1.1",
      systemPrompt: "system",
      messages: [{ role: "user", content: "lookup" }],
      tools: [{
        type: "function",
        function: {
          name: "a2aj_lookup",
          description: "Look up a passage",
          parameters: { type: "object", properties: {} },
        },
      }],
      apiKeys: { openrouter: "test-key" },
      callbacks: {
        onToolCallStart: (call) => calls.push(call.input),
      },
      runTools: async () => [{
        tool_use_id: "call-lookup",
        content: '{"ok":true}',
        terminal: true,
      }],
    });

    expect(calls).toEqual([{
      citation: "2010 BCCA 170",
      locator: "10",
      end_locator: "12",
    }]);
  });

  it("does not spend another model round after a terminal tool result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stream({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call-final",
          name: "submit_evidence_answer",
          arguments: '{"parts":[]}',
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runOpenRouter({
      model: "meta/muse-spark-1.1",
      systemPrompt: "system",
      messages: [{ role: "user", content: "answer" }],
      tools: [{
        type: "function",
        function: {
          name: "submit_evidence_answer",
          description: "Submit the final answer",
          parameters: { type: "object", properties: {} },
        },
      }],
      apiKeys: { openrouter: "test-key" },
      runTools: async () => [{
        tool_use_id: "call-final",
        content: '{"ok":true}',
        terminal: true,
      }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
