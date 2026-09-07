import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PROVIDER_STREAM_BYTES, MAX_PROVIDER_TOOL_ARGUMENT_BYTES,
  runProviderLoop, type ProviderAdapter, type ProviderEvent } from "./providerLoop";
import type { NormalizedLlmUsage, StreamChatParams, Tool } from "./types";

const tool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
});
const params = (extra: Partial<StreamChatParams> = {}): StreamChatParams => ({
  model: "gpt-5.4",
  systemPrompt: "system",
  messages: [{ role: "user", content: "work" }],
  ...extra,
});
const adapter = (
  events: (step: Parameters<ProviderAdapter["events"]>[0]) => ProviderEvent[] | Promise<ProviderEvent[]>,
): ProviderAdapter => ({
  provider: "fake",
  async *events(step) {
    for (const event of await events(step)) yield event;
  },
});
const done = { type: "done" } as const;

afterEach(() => vi.useRealTimers());

describe("provider loop", () => {
  it("stops immediately after a terminal tool result", async () => {
    const steps = vi.fn(() => [
      { type: "tool_call", call: { id: "1", name: "finish", input: {} } } as const,
      done,
    ]);
    const result = await runProviderLoop(params({
      tools: [tool("finish")],
      runTools: async () => [{ tool_use_id: "1", content: "complete", terminal: true }],
    }), adapter(steps));
    expect(steps).toHaveBeenCalledOnce();
    expect(result.contextRounds?.[0]).toMatchObject({ toolCallCount: 1, toolResultBytes: 8 });
  });

  it("bounds a provider that never stops requesting tools", async () => {
    const steps = vi.fn((step: Parameters<ProviderAdapter["events"]>[0]) => [
      { type: "tool_call", call: { id: String(step.iteration), name: "again", input: {} } } as const,
      done,
    ]);
    const result = await runProviderLoop(params({
      tools: [tool("again")],
      runTools: async ([call]) => [{ tool_use_id: call.id, content: "continue" }],
    }), adapter(steps));
    expect(steps).toHaveBeenCalledTimes(32);
    expect(result.contextRounds).toHaveLength(32);
  });

  it("rejects oversized provider output and tool arguments", async () => {
    const finalized = vi.fn();
    const oversized: ProviderAdapter = { provider: "fake", async *events() {
      try {
        yield { type: "text_delta", text: "x".repeat(MAX_PROVIDER_STREAM_BYTES + 1) };
      } finally { finalized(); }
    } };
    await expect(runProviderLoop(params(), oversized)).rejects.toThrow("output limit");
    expect(finalized).toHaveBeenCalledOnce();
    await expect(runProviderLoop(params(), adapter(() => [
      { type: "tool_call", call: {
        id: "1", name: "oversized", input: { value: "x".repeat(MAX_PROVIDER_TOOL_ARGUMENT_BYTES) },
      } }, done,
    ]))).rejects.toThrow("input limit");
  });

  it("drains steering only at a completed provider boundary", async () => {
    const seen: string[][] = [];
    const takeSteering = vi.fn()
      .mockReturnValueOnce([{ id: "s1", text: "focus" }])
      .mockReturnValue([]);
    const result = await runProviderLoop(params({ takeSteering }), adapter((step) => {
      seen.push(step.steering.map(({ text }) => text));
      return [{ type: "text_delta", text: step.iteration ? "revised" : "draft" }, done];
    }));
    expect(seen).toEqual([[], ["focus"]]);
    expect(result.fullText).toBe("draftrevised");
  });

  it("aborts a stalled provider step", async () => {
    const controller = new AbortController();
    const stalled: ProviderAdapter = {
      provider: "fake",
      async *events() {
        await new Promise(() => undefined);
        yield done;
      },
    };
    const run = runProviderLoop(params({ abortSignal: controller.signal }), stalled);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not retry after publishing compaction progress", async () => {
    const checkpoint = vi.fn();
    const events = vi.fn(async function* () {
      yield { type: "opaque_checkpoint", compaction: "running" } as const;
      throw new Error("server_is_overloaded");
    });
    await expect(runProviderLoop(params({ callbacks: { onCompaction: checkpoint } }),
      { provider: "fake", events })).rejects.toThrow("server_is_overloaded");
    expect(events).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith("running");
  });

  it.each([
    "server_is_overloaded",
    "Codex app-server initialize request timed out.",
    "Codex app-server turn/start request timed out: failed to install system skills",
    "thread 123 already has an active writer",
  ])("retries a transient failure before output: %s", async (message) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events = vi.fn(async () => [{ type: "text_delta", text: "ok" } as const, done])
      .mockRejectedValueOnce(new Error(message));
    const running = runProviderLoop(params(), adapter(events));
    void running.catch(() => undefined);
    // Exercise the real backoff without spending wall time asleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    await expect(running).resolves.toMatchObject({
      fullText: "ok", contextRounds: [expect.objectContaining({ requestAttempts: 2 })],
    });
    expect(events).toHaveBeenCalledTimes(2);
  });

  it("can disable hidden retries when each request consumes an external quota", async () => {
    let attempts = 0;
    await expect(runProviderLoop(params({ maxProviderAttempts: 1 }), adapter(() => {
      attempts += 1;
      throw new Error("server_is_overloaded");
    }))).rejects.toThrow("server_is_overloaded");
    expect(attempts).toBe(1);
  });

  it("refreshes tools on the next step and reports newly revealed names", async () => {
    let tools = [tool("discover")];
    const seen: Array<{ tools: string[]; added: string[] }> = [];
    await runProviderLoop(params({
      tools,
      resolveTools: () => tools,
      runTools: async ([call]) => {
        tools = [...tools, tool("revealed")];
        return [{ tool_use_id: call.id, content: "opened" }];
      },
    }), adapter((step) => {
      seen.push({ tools: step.tools.map(({ name }) => name), added: step.newToolNames });
      return step.iteration
        ? [{ type: "text_delta", text: "done" }, done]
        : [{ type: "tool_call", call: { id: "1", name: "discover", input: {} } }, done];
    }));
    expect(seen).toEqual([
      { tools: ["discover"], added: [] },
      { tools: ["discover", "revealed"], added: ["revealed"] },
    ]);
  });

  it("aggregates usage across steps", async () => {
    const usage = (inputTokens: number): NormalizedLlmUsage => ({
      inputTokens,
      outputTokens: 2,
      reasoningTokens: 1,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: null,
    });
    const result = await runProviderLoop(params({
      takeSteering: vi.fn().mockReturnValueOnce([{ id: "s", text: "again" }]).mockReturnValue([]),
    }), adapter((step) => [{ type: "usage", usage: usage(step.iteration + 4), usedTokens: 4 }, done]));
    expect(result.usage).toEqual({
      inputTokens: 9,
      outputTokens: 4,
      reasoningTokens: 2,
      cacheReadInputTokens: 6,
      cacheWriteInputTokens: null,
    });
  });

  it("orders reasoning, content, tool, usage, and execution callbacks", async () => {
    const order: string[] = [];
    await runProviderLoop(params({
      callbacks: {
        onReasoningDelta: (text) => order.push(`reason:${text}`),
        onReasoningBlockEnd: () => order.push("reason:end"),
        onContentDelta: (text) => order.push(`text:${text}`),
        onContentBlockEnd: () => order.push("text:end"),
        onToolCallStart: () => order.push("tool"),
        onContextUsage: () => order.push("usage"),
      },
      runTools: async () => {
        order.push("execute");
        return [{ tool_use_id: "1", content: "done", terminal: true }];
      },
    }), adapter(() => [
      { type: "reasoning_delta", text: "a", block: 0 },
      { type: "reasoning_delta", text: "b", block: 1 },
      { type: "text_delta", text: "answer" },
      { type: "tool_call", call: { id: "1", name: "finish", input: {} } },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null }, usedTokens: 2 },
      done,
    ]));
    expect(order).toEqual([
      "reason:a", "reason:end", "reason:b", "reason:end",
      "text:answer", "text:end", "tool", "usage", "execute",
    ]);
  });
});


describe("provider stream block boundaries", () => {
  const recording = () => {
    const trace: string[] = [];
    return { trace, callbacks: {
      onContentDelta: (text: string) => { trace.push(`text_delta:${text}`); },
      onContentBlockEnd: () => { trace.push("text_delta:end"); },
      onReasoningDelta: (text: string) => { trace.push(`reasoning_delta:${text}`); },
      onReasoningBlockEnd: () => { trace.push("reasoning_delta:end"); },
      onToolCallStart: () => { trace.push("tool"); },
    } };
  };

  describe.each([
    ["text_delta", "reasoning_delta", "ab"],
    ["reasoning_delta", "text_delta", ""],
  ] as const)("%s", (type, otherType, fullText) => {
    // Literal oracles, not a second implementation of the block-change predicate.
    // Keep every same-channel ID pair; channel changes are checked separately below.
    it.each<[string | number | undefined, string | number | undefined, string[]]>([
      [undefined, undefined, ["a", "b", "end"]],
      [undefined, 0, ["a", "end", "b", "end"]],
      [undefined, "0", ["a", "end", "b", "end"]],
      [undefined, "", ["a", "end", "b", "end"]],
      [0, undefined, ["a", "end", "b", "end"]],
      [0, 0, ["a", "b", "end"]],
      [0, "0", ["a", "end", "b", "end"]],
      [0, "", ["a", "end", "b", "end"]],
      ["0", undefined, ["a", "end", "b", "end"]],
      ["0", 0, ["a", "end", "b", "end"]],
      ["0", "0", ["a", "b", "end"]],
      ["0", "", ["a", "end", "b", "end"]],
      ["", undefined, ["a", "end", "b", "end"]],
      ["", 0, ["a", "end", "b", "end"]],
      ["", "0", ["a", "end", "b", "end"]],
      ["", "", ["a", "b", "end"]],
    ])("preserves block identity from %j to %j", async (first, second, expected) => {
      const { trace, callbacks } = recording();
      const result = await runProviderLoop(params({ callbacks }), adapter(() => [
        { type, text: "a", block: first },
        { type: otherType, text: "", block: "ignored" },
        { type: "usage", usage: { inputTokens: 1, outputTokens: null, reasoningTokens: null,
          cacheReadInputTokens: null, cacheWriteInputTokens: null } },
        { type: "opaque_checkpoint", checkpoint: "private" },
        { type, text: "b", block: second }, done, done,
      ]));
      expect(trace).toEqual(expected.map((event) => `${type}:${event}`));
      expect(result.fullText).toBe(fullText);
    });

    it("closes before a tool and reopens the same unidentified block", async () => {
      const { trace, callbacks } = recording();
      const result = await runProviderLoop(params({ callbacks }), adapter(() => [
        { type, text: "a" }, { type: "tool_call", call: { id: "1", name: "finish", input: {} } },
        { type, text: "b" }, done,
      ]));
      expect(trace).toEqual([`${type}:a`, `${type}:end`, "tool", `${type}:b`, `${type}:end`]);
      expect(result.fullText).toBe(fullText);
    });

    it.each([
      ["error", { message: "server_is_overloaded" }],
      ["eof", { message: "fake stream ended without a done event" }],
      ["abort", { name: "AbortError" }],
    ] as const)("closes partial output on %s without retrying it", async (end, error) => {
      const { trace, callbacks } = recording();
      const controller = new AbortController();
      let attempts = 0;
      const stream: ProviderAdapter = { provider: "fake", async *events() {
        attempts += 1;
        yield { type, text: "partial" };
        if (end === "error") throw new Error("server_is_overloaded");
        if (end === "abort") {
          controller.abort();
          await new Promise(() => undefined);
        }
      } };
      await expect(runProviderLoop(params({ callbacks, abortSignal: controller.signal }), stream))
        .rejects.toMatchObject(error);
      expect(trace).toEqual([`${type}:partial`, `${type}:end`]);
      expect(attempts).toBe(1);
    });

    it("shares the UTF-8 output budget with the other channel", async () => {
      const { trace, callbacks } = recording();
      callbacks.onContentDelta = (text) => { trace.push(`text_delta:${text.length}`); };
      callbacks.onReasoningDelta = (text) => { trace.push(`reasoning_delta:${text.length}`); };
      const first = "é".repeat(MAX_PROVIDER_STREAM_BYTES / 2);
      await expect(runProviderLoop(params({ callbacks }), adapter(() => [
        { type, text: first }, { type: otherType, text: "x" }, done,
      ]))).rejects.toThrow("output limit");
      expect(trace).toEqual([`${type}:${first.length}`, `${type}:end`]);
    });
  });

  it.each([undefined, 0, "0", ""])("closes channel changes with shared and distinct IDs (%j)", async (block) => {
    const { trace, callbacks } = recording();
    const result = await runProviderLoop(params({ callbacks }), adapter(() => [
      { type: "text_delta", text: "a", block },
      { type: "reasoning_delta", text: "b", block },
      { type: "text_delta", text: "c", block: "next" },
      { type: "reasoning_delta", text: "d", block }, done,
    ]));
    expect(trace).toEqual([
      "text_delta:a", "text_delta:end", "reasoning_delta:b", "reasoning_delta:end",
      "text_delta:c", "text_delta:end", "reasoning_delta:d", "reasoning_delta:end",
    ]);
    expect(result.fullText).toBe("ac");
  });
});
