import { afterEach, describe, expect, it, vi } from "vitest";
import { streamDeepSeek, toDeepSeekMessages } from "../deepseek";
import type { Tool } from "../types";

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {} },
});

function sse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeepSeek adapter", () => {
  it("streams reasoning, preserves it through a tool call, then returns text", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse([
          {
            choices: [{
              delta: { reasoning_content: "Need the exact source." },
            }],
          },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call-1",
                  function: { name: "lookup", arguments: "{\"id\":" },
                }],
              },
            }],
          },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: "\"62\"}" },
                }],
              },
            }],
          },
        ]);
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse([{ choices: [{ delta: { content: "Footnote 62." } }] }]);
      });
    vi.stubGlobal("fetch", fetchMock);

    const trace: string[] = [];
    const result = await streamDeepSeek({
      model: "deepseek-v4-pro",
      systemPrompt: "Use tools.",
      messages: [{ role: "user", content: "Find footnote 62." }],
      apiKeys: { deepseek: "sk-test" },
      enableThinking: true,
      reasoningEffort: "max",
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Look up a footnote.",
          parameters: { type: "object" },
        },
      }],
      callbacks: {
        onReasoningDelta: (text) => trace.push(`reasoning:${text}`),
        onReasoningBlockEnd: () => trace.push("reasoning:end"),
        onContentDelta: (text) => trace.push(`content:${text}`),
      },
      runTools: async (calls) => {
        expect(calls).toEqual([{
          id: "call-1",
          name: "lookup",
          input: { id: "62" },
        }]);
        return [{ tool_use_id: "call-1", content: "Found." }];
      },
    });

    expect(result.fullText).toBe("Footnote 62.");
    expect(trace).toEqual([
      "reasoning:Need the exact source.",
      "reasoning:end",
      "content:Footnote 62.",
    ]);
    expect(bodies[0]).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      stream: true,
    });
    expect(bodies[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "Need the exact source.",
        tool_calls: [expect.objectContaining({ id: "call-1" })],
      }),
      { role: "tool", tool_call_id: "call-1", content: "Found." },
    ]));
  });

  it("sends reasoning_effort low when low effort is requested", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse([{ choices: [{ delta: { content: "done" } }] }]);
      }),
    );

    await streamDeepSeek({
      model: "deepseek-v4-flash",
      systemPrompt: "system",
      messages: [{ role: "user", content: "quick" }],
      apiKeys: { deepseek: "sk-test" },
      enableThinking: true,
      reasoningEffort: "low",
    });

    expect(bodies[0]).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
  });

  it("refreshes tools on the next tool-loop request", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return bodies.length === 1
          ? sse([{
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call-1",
                    function: { name: "discover", arguments: "{}" },
                  }],
                },
              }],
            }])
          : sse([{ choices: [{ delta: { content: "done" } }] }]);
      }),
    );
    let activeTools = [tool("discover")];

    await streamDeepSeek({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      messages: [{ role: "user", content: "research" }],
      apiKeys: { deepseek: "test-key" },
      tools: activeTools,
      resolveTools: () => activeTools,
      runTools: async () => {
        activeTools = [...activeTools, tool("revealed")];
        return [{ tool_use_id: "call-1", content: "opened" }];
      },
    });

    expect(bodies.map((body) =>
      (body.tools as { function: { name: string } }[]).map((entry) => entry.function.name)
    )).toEqual([["discover"], ["discover", "revealed"]]);
  });

  it("delivers queued steering after a completed response", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse([{ choices: [{ delta: { content: bodies.length === 1 ? "draft" : "revised" } }] }]);
      }),
    );
    const takeSteering = vi.fn()
      .mockReturnValueOnce([{ id: "s1", text: "Focus on section 8." }])
      .mockReturnValue([]);

    await streamDeepSeek({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      messages: [{ role: "user", content: "review" }],
      apiKeys: { deepseek: "test-key" },
      takeSteering,
    });

    expect(bodies[1].messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: "draft" },
      { role: "user", content: "Focus on section 8." },
    ]));
  });

  it("rejects image input before making a request", () => {
    expect(() =>
      toDeepSeekMessages([{
        role: "user",
        content: "Read this.",
        images: [{
          filename: "scan.png",
          mimeType: "image/png",
          data: "aW1hZ2U=",
        }],
      }]),
    ).toThrow("does not support image input");
  });
});
