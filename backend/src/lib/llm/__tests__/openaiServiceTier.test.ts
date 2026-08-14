import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAI } from "../openai";

function stream(...events: unknown[]) {
  return new Response(
    `${events
      .map((event) => `data: ${JSON.stringify(event)}`)
      .join("\n\n")}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI service tier", () => {
  it("continues past ten tool rounds until the model naturally stops", async () => {
    let round = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      round += 1;
      return round <= 11
        ? stream({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: `call-${round}`,
              name: "inspect",
              arguments: "{}",
            },
          })
        : stream({ type: "response.output_text.delta", delta: "finished" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAI({
      model: "gpt-5.6-luna",
      systemPrompt: "Finish when the work is complete.",
      messages: [{ role: "user", content: "Inspect thoroughly." }],
      tools: [{
        type: "function",
        function: {
          name: "inspect",
          description: "Inspect",
          parameters: { type: "object", properties: {} },
        },
      }],
      apiKeys: { openai: "test-key" },
      runTools: async (calls) =>
        calls.map((call) => ({ tool_use_id: call.id, content: "ok" })),
    });

    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(result.fullText).toBe("finished");
    expect(result.contextRounds).toHaveLength(12);
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        String((init as RequestInit).body).includes("Tool budget"),
      ),
    ).toBe(false);
  });

  it("maps fast to priority and returns the provider-reported tier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stream(
        { type: "response.output_text.delta", delta: "ok" },
        {
          type: "response.completed",
          response: {
            service_tier: "priority",
            usage: { input_tokens: 4, output_tokens: 1 },
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAI({
      model: "gpt-5.5",
      systemPrompt: "Reply briefly.",
      messages: [{ role: "user", content: "Reply OK." }],
      serviceTier: "fast",
      apiKeys: { openai: "test-key" },
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      model: "gpt-5.5",
      service_tier: "priority",
    });
    expect(result).toMatchObject({
      fullText: "ok",
      serviceTier: "priority",
      usage: { inputTokens: 4, outputTokens: 1 },
    });
    expect(result.contextRounds).toEqual([
      expect.objectContaining({
        iteration: 0,
        requestAttempts: 1,
        continuation: "none",
        toolCount: 0,
        toolCallCount: 0,
        toolArgumentBytes: 0,
        toolResultBytes: 0,
        usage: expect.objectContaining({ inputTokens: 4, outputTokens: 1 }),
      }),
    ]);
  });

  it("omits the tier on ordinary requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stream({ type: "response.output_text.delta", delta: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamOpenAI({
      model: "gpt-5.5",
      systemPrompt: "Reply briefly.",
      messages: [{ role: "user", content: "Reply OK." }],
      apiKeys: { openai: "test-key" },
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body).not.toHaveProperty("service_tier");
    expect(body).not.toHaveProperty("context_management");
  });

  it("sends the official server-side compaction shape when requested", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stream({ type: "response.output_text.delta", delta: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamOpenAI({
      model: "gpt-5.6-luna",
      systemPrompt: "Work until done.",
      messages: [{ role: "user", content: "Inspect the documents." }],
      compactThreshold: 120_000,
      apiKeys: { openai: "test-key" },
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body.context_management).toEqual([
      { type: "compaction", compact_threshold: 120_000 },
    ]);
  });

  it("retains the provider's completed compaction item for the next turn", async () => {
    const item = {
      type: "compaction",
      id: "cmp_1",
      encrypted_content: "opaque",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(
      { type: "response.output_item.added", item: { type: "compaction" } },
      { type: "response.output_item.done", item },
      { type: "response.output_text.delta", delta: "continued" },
    )));
    const onCompaction = vi.fn();
    const onContextCheckpoint = vi.fn();

    await streamOpenAI({
      model: "gpt-5.5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "continue" }],
      compactThreshold: 800_000,
      callbacks: { onCompaction, onContextCheckpoint },
      apiKeys: { openai: "test-key" },
    });

    expect(onCompaction.mock.calls).toEqual([["running"], ["completed"]]);
    expect(onContextCheckpoint).toHaveBeenCalledWith({
      provider: "openai",
      item,
    });
  });

  it("delivers queued steering after a completed response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream({ type: "response.output_text.delta", delta: "draft" }))
      .mockResolvedValueOnce(stream({ type: "response.output_text.delta", delta: "revised" }));
    vi.stubGlobal("fetch", fetchMock);
    const takeSteering = vi.fn()
      .mockReturnValueOnce([{ id: "s1", text: "Focus on section 8." }])
      .mockReturnValue([]);

    await streamOpenAI({
      model: "gpt-5.5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "review" }],
      apiKeys: { openai: "test-key" },
      takeSteering,
    });

    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(second.input).toEqual([
      { role: "user", content: "Focus on section 8." },
    ]);
  });
});
