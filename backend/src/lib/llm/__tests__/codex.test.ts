import { describe, expect, it } from "vitest";
import { parseCodexEventLine } from "../codex";
import {
  startCodexToolBridge,
  type CodexToolBridge,
} from "../codexToolBridge";

const bridgeTool = (name: string) => ({
  type: "function" as const,
  function: {
    name,
    description: name,
    parameters: { type: "object" },
  },
});

async function callBridgeTool(
  bridge: CodexToolBridge,
  id: number,
  name: string,
) {
  const response = await fetch(bridge.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  return response.text();
}

describe("parseCodexEventLine", () => {
  it("extracts the completed agent message", () => {
    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Hello from Codex" },
        }),
      ),
    ).toEqual({ text: "Hello from Codex" });
  });

  it("extracts failed-turn errors", () => {
    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: "turn.failed",
          error: { message: "Codex unavailable" },
        }),
      ),
    ).toEqual({ error: "Codex unavailable" });
  });

  it("captures the provider invocation ID without treating it as continuation", () => {
    expect(parseCodexEventLine('{"type":"thread.started"}')).toEqual({});
    expect(
      parseCodexEventLine('{"type":"thread.started","thread_id":"thread-123"}'),
    ).toEqual({ providerInvocationId: "thread-123" });
  });

  it("normalizes turn lifecycle events", () => {
    expect(parseCodexEventLine('{"type":"turn.started"}')).toEqual({
      turnStarted: true,
    });
    expect(parseCodexEventLine('{"type":"turn.completed"}')).toEqual({
      turnCompleted: true,
    });
    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 15140,
            cached_input_tokens: 12032,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }),
      ),
    ).toEqual({
      turnCompleted: true,
      usage: {
        inputTokens: 15140,
        outputTokens: 5,
        reasoningTokens: 2,
        cacheReadInputTokens: 12032,
        cacheWriteInputTokens: 0,
      },
    });
  });

  it("normalizes Codex reasoning-summary items", () => {
    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "reasoning",
            text: "raw hidden reasoning",
            summary: [{ type: "summary_text", text: "Checking the sources." }],
          },
        }),
      ),
    ).toEqual({ reasoning: "Checking the sources.", reasoningBlockEnd: true });

    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "reasoning", text: "raw hidden reasoning" },
        }),
      ),
    ).toEqual({
      reasoning: "raw hidden reasoning",
      reasoningBlockEnd: true,
    });
  });

  it("routes an MCP call through Beaver's dispatcher", async () => {
    const calls: string[] = [];
    const callbackCalls: string[] = [];
    const bridge = await startCodexToolBridge({
      tools: [
        {
          type: "function",
          function: {
            name: "ping_tool",
            description: "Return the supplied value.",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        },
      ],
      callbacks: {
        onToolCallStart: (call) => callbackCalls.push(call.name),
      },
      runTools: async (toolCalls) => {
        calls.push(toolCalls[0].name);
        return [
          {
            tool_use_id: toolCalls[0].id,
            content: JSON.stringify({
              ok: true,
              value: toolCalls[0].input.value,
            }),
          },
        ];
      },
    });

    try {
      const headers = {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const post = (body: Record<string, unknown>) =>
        fetch(bridge.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

      await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      await post({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });
      const response = await post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ping_tool", arguments: { value: "hello" } },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello");
      expect(calls).toEqual(["ping_tool"]);
      expect(callbackCalls).toEqual(["ping_tool"]);
    } finally {
      await bridge.close();
      await bridge.close();
    }
  });

  it("rejects unauthorized requests and enforces the dispatch limit", async () => {
    let dispatches = 0;
    const bridge = await startCodexToolBridge({
      tools: [
        {
          type: "function",
          function: {
            name: "ping_tool",
            description: "Return the supplied value.",
            parameters: { type: "object" },
          },
        },
      ],
      maxToolCalls: 1,
      runTools: async (toolCalls) => {
        dispatches += 1;
        return [{ tool_use_id: toolCalls[0].id, content: "ok" }];
      },
    });

    try {
      const unauthorizedResponse = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(unauthorizedResponse.status).toBe(401);

      const headers = {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const listResponse = await fetch(bridge.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "tools/list",
          params: {},
        }),
      });
      expect(await listResponse.text()).toContain("ping_tool");

      const post = (id: number) =>
        fetch(bridge.url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "ping_tool", arguments: {} },
          }),
        });

      const first = await post(1);
      const second = await post(2);
      expect(await first.text()).toContain("ok");
      expect(await second.text()).toContain("iteration limit exceeded");
      expect(dispatches).toBe(1);

      const unknown = await fetch(bridge.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "missing_tool", arguments: {} },
        }),
      });
      expect(await unknown.text()).toContain("Unknown Beaver tool");
    } finally {
      await bridge.close();
    }
  });

  it("serializes concurrent MCP dispatches", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStarting = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const bridge = await startCodexToolBridge({
      tools: ["mutate", "ask_inputs"].map(bridgeTool),
      runTools: async ([call]) => {
        order.push(`${call.name}:start`);
        if (call.name === "mutate") {
          firstStarted();
          await firstReleased;
        }
        order.push(`${call.name}:end`);
        return [{ tool_use_id: call.id, content: "ok" }];
      },
    });

    try {
      const mutation = callBridgeTool(bridge, 1, "mutate");
      await firstStarting;
      const ask = callBridgeTool(bridge, 2, "ask_inputs");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(order).toEqual(["mutate:start"]);

      releaseFirst();
      await Promise.all([mutation, ask]);
      expect(order).toEqual([
        "mutate:start",
        "mutate:end",
        "ask_inputs:start",
        "ask_inputs:end",
      ]);
    } finally {
      releaseFirst();
      await bridge.close();
    }
  });

  it("waits for an in-flight dispatch before closing", async () => {
    let releaseDispatch!: () => void;
    const dispatchReleased = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let dispatchStarted!: () => void;
    const dispatchStarting = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const bridge = await startCodexToolBridge({
      tools: [bridgeTool("mutate")],
      runTools: async ([call]) => {
        dispatchStarted();
        await dispatchReleased;
        return [{ tool_use_id: call.id, content: "ok" }];
      },
    });
    let closeSettled = false;
    let closing: Promise<void> | undefined;

    try {
      const call = callBridgeTool(bridge, 1, "mutate").catch(() => "");
      await dispatchStarting;
      closing = bridge.close().then(() => {
        closeSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closeSettled).toBe(false);

      releaseDispatch();
      await Promise.all([closing, call]);
      expect(closeSettled).toBe(true);
    } finally {
      releaseDispatch();
      await (closing ?? bridge.close());
    }
  });

  it("does not dispatch queued calls after cancellation", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let releaseAsk!: () => void;
    const askReleased = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    let askStarted!: () => void;
    const askStarting = new Promise<void>((resolve) => {
      askStarted = resolve;
    });
    const bridge = await startCodexToolBridge({
      tools: ["ask_inputs", "mutate"].map(bridgeTool),
      abortSignal: controller.signal,
      runTools: async ([call]) => {
        calls.push(call.name);
        if (call.name === "ask_inputs") {
          controller.abort();
          askStarted();
          await askReleased;
        }
        return [{ tool_use_id: call.id, content: "ok" }];
      },
    });

    try {
      const ask = callBridgeTool(bridge, 1, "ask_inputs");
      await askStarting;
      const mutation = callBridgeTool(bridge, 2, "mutate");
      releaseAsk();
      const bodies = await Promise.all([ask, mutation]);

      expect(calls).toEqual(["ask_inputs"]);
      expect(bodies[1]).toContain("Beaver tool dispatch was cancelled.");
    } finally {
      releaseAsk();
      await bridge.close();
    }
  });
});
