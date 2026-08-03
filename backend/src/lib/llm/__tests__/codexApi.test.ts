import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  borrowCodexKey: vi.fn(async () => ({
    accessToken: "test-token",
    accountId: "account-1",
  })),
  getCodexModelCatalog: vi.fn(),
}));

vi.mock("../codexAuth", () => ({ borrowCodexKey: mocks.borrowCodexKey }));
vi.mock("../../codexCatalog", () => ({
  getCodexModelCatalog: mocks.getCodexModelCatalog,
}));

import { streamCodexApi } from "../codexApi";

const eventStream = (...events: unknown[]) =>
  new Response(
    `${events
      .map((event) => `data: ${JSON.stringify(event)}`)
      .join("\n\n")}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const response = (...events: unknown[]) =>
  eventStream(...events, { type: "response.output_text.delta", delta: "ok" });

const params = (serviceTier?: string) => ({
  model: "codex:gpt-5.6-sol",
  systemPrompt: "system",
  messages: [{ role: "user" as const, content: "test" }],
  ...(serviceTier ? { serviceTier } : {}),
});

afterEach(() => {
  mocks.borrowCodexKey.mockClear();
  mocks.getCodexModelCatalog.mockReset();
  vi.unstubAllGlobals();
});

describe("Codex service tier", () => {
  it("leaves default requests unchanged without loading the catalog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await streamCodexApi(params());

    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body).not.toHaveProperty("service_tier");
    expect(body.prompt_cache_key).toMatch(/^[0-9a-f-]{36}$/u);
    expect(body).not.toHaveProperty("prompt_cache_options");
    expect(body.input).toEqual([{ role: "user", content: "test" }]);
    expect(mocks.getCodexModelCatalog).not.toHaveBeenCalled();
  });

  it("does not send GPT-5.6 cache controls to older Codex models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await streamCodexApi({ ...params(), model: "codex:gpt-5.4" });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body).not.toHaveProperty("prompt_cache_options");
    expect(body.input).toEqual([
      { role: "user", content: "test" },
    ]);
  });

  it("carries explicit history across stateless tool rounds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        eventStream(
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call-1",
              name: "inspect",
              arguments: "{}",
            },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 2_000, output_tokens: 20 } },
          },
        ),
      )
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamCodexApi({
      ...params(),
      promptCacheKey: "stable-key",
      tools: [
        {
          type: "function",
          function: {
            name: "inspect",
            description: "Inspect evidence",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      runTools: async (calls) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: "exact evidence",
        })),
    });

    const first = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(second).not.toHaveProperty("prompt_cache_options");
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
    expect(second.input.at(-1)).toMatchObject({
      type: "function_call_output",
      output: "exact evidence",
    });
    expect(result.contextRounds?.[1]).not.toHaveProperty(
      "cacheBreakpointCount",
    );
  });

  it("maps advertised fast mode to the priority request value", async () => {
    mocks.getCodexModelCatalog.mockResolvedValue({
      source: "bundled",
      models: [{ slug: "gpt-5.6-sol", serviceTiers: [{ id: "priority" }] }],
    });
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamCodexApi(params("fast"));

    expect(
      JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      service_tier: "priority",
      store: false,
    });
    expect(result.serviceTier).toBeUndefined();
  });

  it("accepts the transport-facing priority name directly", async () => {
    mocks.getCodexModelCatalog.mockResolvedValue({
      source: "live",
      models: [{ slug: "gpt-5.6-sol", serviceTiers: [{ id: "priority" }] }],
    });
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    await streamCodexApi(params("priority"));

    expect(
      JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)),
    ).toMatchObject({ service_tier: "priority" });
  });

  it("returns the service tier reported by the response stream", async () => {
    mocks.getCodexModelCatalog.mockResolvedValue({
      source: "bundled",
      models: [{ slug: "gpt-5.6-sol", serviceTiers: [{ id: "priority" }] }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          type: "response.completed",
          response: { service_tier: "priority" },
        }),
      ),
    );

    const result = await streamCodexApi(params("fast"));

    expect(result).toMatchObject({ fullText: "ok", serviceTier: "priority" });
  });

  it("refuses a tier the selected model does not advertise", async () => {
    mocks.getCodexModelCatalog.mockResolvedValue({
      source: "bundled",
      models: [
        {
          slug: "gpt-5.6-sol",
          serviceTiers: [],
          additionalSpeedTiers: ["fast"],
        },
      ],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamCodexApi(params("fast"))).rejects.toThrow(
      "does not advertise service tier priority",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.borrowCodexKey).not.toHaveBeenCalled();
  });
});

describe("Codex native compaction", () => {
  it("replaces explicit history at the threshold and accounts for reported usage", async () => {
    const compactedOutput = [
      {
        type: "compaction",
        id: "compact-1",
        encrypted_content: "sealed-summary",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        eventStream(
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call-1",
              name: "inspect",
              arguments: "{}",
            },
          },
          {
            type: "response.completed",
            response: {
              service_tier: "default",
              usage: {
                input_tokens: 245_000,
                output_tokens: 50,
                input_tokens_details: { cached_tokens: 1_000 },
                output_tokens_details: { reasoning_tokens: 10 },
              },
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: compactedOutput,
            usage: {
              input_tokens: 245_500,
              output_tokens: 400,
              input_tokens_details: {
                cached_tokens: 200_000,
                cache_write_tokens: 20_000,
              },
              output_tokens_details: { reasoning_tokens: 100 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        eventStream(
          { type: "response.output_text.delta", delta: "finished" },
          {
            type: "response.completed",
            response: {
              service_tier: "default",
              usage: {
                input_tokens: 2_000,
                output_tokens: 100,
                output_tokens_details: { reasoning_tokens: 20 },
              },
            },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamCodexApi({
      ...params(),
      enableThinking: true,
      reasoningEffort: "high",
      compactThreshold: 244_800,
      promptCacheKey: "chat-cache-key",
      tools: [
        {
          type: "function",
          function: {
            name: "inspect",
            description: "Inspect evidence",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      runTools: async (calls) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: "exact evidence",
        })),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/responses\/compact$/u);
    const initialBody = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    const compactBody = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body),
    );
    expect(compactBody).toMatchObject({
      model: "gpt-5.6-sol",
      prompt_cache_key: "chat-cache-key",
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(compactBody.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call" }),
        expect.objectContaining({
          type: "function_call_output",
          output: "exact evidence",
        }),
      ]),
    );
    const continuedBody = JSON.parse(
      String((fetchMock.mock.calls[2][1] as RequestInit).body),
    );
    expect(initialBody.prompt_cache_key).toBe("chat-cache-key");
    expect(continuedBody.prompt_cache_key).toBe("chat-cache-key");
    expect(continuedBody.input).toEqual(compactedOutput);
    expect(result).toMatchObject({
      fullText: "finished",
      serviceTier: "default",
      usage: {
        inputTokens: 492_500,
        outputTokens: 550,
        reasoningTokens: 130,
        cacheReadInputTokens: 201_000,
        cacheWriteInputTokens: 20_000,
      },
      promptCacheKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.contextRounds).toHaveLength(2);
    expect(result.compactions).toEqual([
      expect.objectContaining({
        iteration: 0,
        thresholdTokens: 244_800,
        triggerInputTokens: 245_000,
        triggerReason: "reported_usage",
        outputItems: 1,
        estimatedInputTokens: expect.any(Number),
        estimatedOutputTokens: expect.any(Number),
        usage: expect.objectContaining({
          inputTokens: 245_500,
          outputTokens: 400,
        }),
      }),
    ]);
  });

  it("compacts before large tool results make the next request overflow", async () => {
    const compactedOutput = [
      {
        type: "compaction",
        id: "compact-projected",
        encrypted_content: "sealed-summary",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        eventStream(
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call-1",
              name: "inspect",
              arguments: "{}",
            },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 100, output_tokens: 10 } },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: compactedOutput }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamCodexApi({
      ...params(),
      compactThreshold: 1_500,
      tools: [
        {
          type: "function",
          function: {
            name: "inspect",
            description: "Inspect evidence",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      runTools: async (calls) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: "e".repeat(8_000),
        })),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/responses\/compact$/u);
    expect(result.compactions).toEqual([
      expect.objectContaining({
        triggerInputTokens: 100,
        triggerReason: "projected_input",
        projectedInputTokens: expect.any(Number),
      }),
    ]);
    expect(result.compactions![0].projectedInputTokens).toBeGreaterThanOrEqual(
      1_500,
    );
  });

  it("anchors projection to reported usage instead of total byte heuristics", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        eventStream(
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call-1",
              name: "inspect",
              arguments: "{}",
            },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1_000, output_tokens: 10 } },
          },
        ),
      )
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamCodexApi({
      ...params(),
      messages: [{ role: "user", content: "legal ".repeat(1_500) }],
      compactThreshold: 2_000,
      tools: [
        {
          type: "function",
          function: {
            name: "inspect",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      runTools: async (calls) =>
        calls.map((call) => ({ tool_use_id: call.id, content: "small result" })),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.compactions).toEqual([]);
  });

  it("compacts and retries once after a context-length rejection", async () => {
    const compactedOutput = [
      {
        type: "compaction",
        id: "compact-reactive",
        encrypted_content: "sealed-summary",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        eventStream({
          type: "response.failed",
          response: {
            status: "failed",
            usage: { input_tokens: 270_000, output_tokens: 0 },
            error: {
              code: "context_length_exceeded",
              message: "Input is too large",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: compactedOutput,
            usage: {
              input_tokens: 270_500,
              output_tokens: 400,
              output_tokens_details: { reasoning_tokens: 100 },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        eventStream(
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 2_000,
                output_tokens: 100,
                output_tokens_details: { reasoning_tokens: 20 },
              },
            },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamCodexApi({
      ...params(),
      compactThreshold: 244_800,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/responses\/compact$/u);
    expect(result.fullText).toBe("ok");
    expect(result.usage).toMatchObject({
      inputTokens: 542_500,
      outputTokens: 500,
      reasoningTokens: 120,
    });
    expect(result.contextRounds).toEqual([
      expect.objectContaining({ requestAttempts: 2 }),
    ]);
    expect(result.compactions).toEqual([
      expect.objectContaining({
        triggerInputTokens: 270_000,
        triggerReason: "context_length_exceeded",
        outputItems: 1,
      }),
    ]);
  });

  it("does not loop when the compacted retry is still too large", async () => {
    const failed = () =>
      eventStream({
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            code: "context_length_exceeded",
            message: "Input is too large",
          },
        },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failed())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: "compaction",
                id: "compact-once",
                encrypted_content: "sealed-summary",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(failed());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      streamCodexApi({ ...params(), compactThreshold: 244_800 }),
    ).rejects.toThrow("context_length_exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/responses/compact"),
      ),
    ).toHaveLength(1);
  });
});
