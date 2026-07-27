import { afterEach, describe, expect, it, vi } from "vitest";
import { streamDeepSeek, toDeepSeekMessages } from "../deepseek";

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
