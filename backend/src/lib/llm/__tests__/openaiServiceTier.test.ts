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
  });
});
