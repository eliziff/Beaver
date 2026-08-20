import { describe, expect, it, vi } from "vitest";
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
    await expect(runProviderLoop(params(), adapter(() => [
      { type: "text_delta", text: "x".repeat(MAX_PROVIDER_STREAM_BYTES + 1) }, done,
    ]))).rejects.toThrow("output limit");
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

  it("retries transient failures only before visible output", async () => {
    let attempts = 0;
    const recovered = await runProviderLoop(params(), adapter(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("server_is_overloaded");
      return [{ type: "text_delta", text: "ok" }, done];
    }));
    expect(recovered.fullText).toBe("ok");
    expect(recovered.contextRounds?.[0].requestAttempts).toBe(2);

    attempts = 0;
    const partial: ProviderAdapter = {
      provider: "fake",
      async *events() {
        attempts += 1;
        yield { type: "text_delta", text: "partial" };
        throw new Error("server_is_overloaded");
      },
    };
    await expect(runProviderLoop(params(), partial)).rejects.toThrow("server_is_overloaded");
    expect(attempts).toBe(1);

    const checkpoint = vi.fn();
    attempts = 0;
    const stateful: ProviderAdapter = {
      provider: "fake",
      async *events() {
        attempts += 1;
        yield { type: "opaque_checkpoint", compaction: "running" };
        throw new Error("server_is_overloaded");
      },
    };
    await expect(runProviderLoop(params({ callbacks: { onCompaction: checkpoint } }), stateful))
      .rejects.toThrow("server_is_overloaded");
    expect([attempts, checkpoint.mock.calls.length]).toEqual([1, 1]);
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
