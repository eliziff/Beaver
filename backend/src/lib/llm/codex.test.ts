import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TurnToolRegistry, toolText } from "../chat/toolRegistry";

const transport = vi.hoisted(() => {
  const listeners = new Set<(event: { method: string; params: Record<string, unknown> }) => void>();
  return {
    listeners,
    request: vi.fn(),
    emit(method: string, params: Record<string, unknown>) {
      for (const listener of listeners) listener({ method, params });
    },
  };
});

vi.mock("./codexAppServer", () => ({
  CODEX_APP_SERVER_CLOSED: "$closed",
  acquireCodexAppServer: vi.fn(async () => ({
    bridgeToken: "test-token",
    inheritedMcpServers: ["openaiDeveloperDocs", "node_repl"],
    alive: () => true,
    request: transport.request,
    subscribe(listener: (event: { method: string; params: Record<string, unknown> }) => void) {
      transport.listeners.add(listener);
      return () => transport.listeners.delete(listener);
    },
  })),
}));

import { streamCodex } from "./codex";

const threadId = "11111111-1111-1111-1111-111111111111";
const turnId = "turn-1";

function complete(text = "Done", activeTurnId = turnId) {
  transport.emit("item/agentMessage/delta", { threadId, turnId: activeTurnId, itemId: "answer", delta: text });
  transport.emit("item/completed", {
    threadId,
    turnId: activeTurnId,
    item: { id: "answer", type: "agentMessage", text },
  });
  transport.emit("turn/completed", { threadId, turn: { id: activeTurnId, status: "completed" } });
}

describe("Codex app-server adapter", () => {
  beforeEach(() => {
    transport.listeners.clear();
    transport.request.mockReset();
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "turn/start") {
        setTimeout(() => complete(), 0);
        return { turn: { id: turnId } };
      }
      return {};
    });
  });

  it("keeps instructions out of user input and streams the native turn", async () => {
    const deltas: string[] = [];
    const result = await streamCodex({
      model: "codex:gpt-5.6-luna",
      reasoningEffort: "low",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "Reply." }],
      callbacks: { onContentDelta: (delta) => deltas.push(delta) },
    });

    expect(result.fullText).toBe("Done");
    expect(deltas).toEqual(["Done"]);
    const start = transport.request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(start).toMatchObject({
      developerInstructions: "Be concise.",
      config: {
        "features.shell_tool": false,
        "features.code_mode.direct_only_tool_namespaces": ["mcp__mike_runtime"],
        mcp_servers: {
          openaiDeveloperDocs: { enabled: false },
          node_repl: { enabled: false },
        },
        web_search: "disabled",
      },
    });
    const turn = transport.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(turn.input).toEqual([{ type: "text", text: "Reply.", text_elements: [] }]);
  });

  it("exposes specialists only after loading through the native MCP connection", async () => {
    const registry = new TurnToolRegistry([{ name: "inspect", specialist: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { result: toolText("inspected") }; },
    }]);
    let bridgeUrl = "";
    transport.request.mockImplementation(async (method: string, params) => {
      if (method === "thread/start") {
        bridgeUrl = params.config.mcp_servers.mike_runtime.url;
        return { thread: { id: threadId } };
      }
      if (method === "turn/start") {
        const client = new Client({ name: "codex-test", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(bridgeUrl), {
          requestInit: { headers: { Authorization: "Bearer test-token" } },
        }));
        try {
          expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["load_tools"]);
          await client.callTool({ name: "load_tools", arguments: { names: ["inspect"] } });
          expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["inspect"]);
          expect((await client.callTool({ name: "inspect", arguments: {} })).content)
            .toEqual([{ type: "text", text: "inspected" }]);
        } finally { await client.close(); }
        setTimeout(() => complete(), 0);
        return { turn: { id: turnId } };
      }
      return {};
    });
    await streamCodex({ model: "codex:gpt-5.6-luna", systemPrompt: "", messages: [],
      tools: registry.visible(), staticTools: registry.all(),
      resolveTools: () => registry.visible(), runTools: calls => registry.run(calls, {}),
    });
  });

  it("passes a structured-output schema to the native turn", async () => {
    const outputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    };

    await streamCodex({
      model: "codex:gpt-5.6-luna",
      systemPrompt: "Return the requested object.",
      messages: [{ role: "user", content: "Reply." }],
      outputSchema,
    });

    expect(transport.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ outputSchema }),
    );
  });

  it("resumes a persisted thread through the stable protocol", async () => {
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/resume") return { thread: { id: threadId } };
      if (method === "turn/start") {
        setTimeout(() => complete(), 0);
        return { turn: { id: turnId } };
      }
      return {};
    });
    await streamCodex({
      model: "codex:gpt-5.6-luna",
      systemPrompt: "",
      messages: [{ role: "user", content: "Continue." }],
      providerSession: { persist: true, continuationId: threadId },
    });
    expect(transport.request).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        config: expect.objectContaining({
          "features.code_mode.direct_only_tool_namespaces": ["mcp__mike_runtime"],
        }),
      }),
    );
    expect(transport.request).toHaveBeenCalledWith(
      "thread/resume",
      expect.not.objectContaining({ excludeTurns: expect.anything() }),
    );
  });

  it("uses native reasoning boundaries and active context usage", async () => {
    const reasoning: string[] = [];
    const context: unknown[] = [];
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "turn/start") {
        setTimeout(() => {
          transport.emit("item/reasoning/summaryTextDelta", {
            threadId,
            turnId,
            itemId: "reasoning",
            summaryIndex: 0,
            delta: "Planning",
          });
          transport.emit("item/reasoning/summaryPartAdded", {
            threadId,
            turnId,
            itemId: "reasoning",
            summaryIndex: 1,
          });
          transport.emit("item/reasoning/summaryTextDelta", {
            threadId,
            turnId,
            itemId: "reasoning",
            summaryIndex: 1,
            delta: "Writing",
          });
          transport.emit("thread/tokenUsage/updated", {
            threadId,
            turnId,
            tokenUsage: {
              total: { totalTokens: 200_000 },
              last: { totalTokens: 20_000 },
              modelContextWindow: 128_000,
            },
          });
          transport.emit("item/completed", {
            threadId,
            turnId,
            item: { id: "reasoning", type: "reasoning" },
          });
          complete();
        }, 0);
        return { turn: { id: turnId } };
      }
      return {};
    });

    await streamCodex({
      model: "codex:gpt-5.6-luna",
      systemPrompt: "",
      messages: [{ role: "user", content: "Reply." }],
      enableThinking: true,
      callbacks: {
        onReasoningDelta: (delta) => reasoning.push(delta),
        onReasoningBlockEnd: () => reasoning.push("|"),
        onContextUsage: (usage) => context.push(usage),
      },
    });

    expect(reasoning).toEqual(["Planning", "|", "Writing", "|"]);
    expect(context).toEqual([{
      usedTokens: 20_000,
      contextWindowTokens: 128_000,
    }]);
  });

  it("marks the changed native subagent activity without dropping its snapshot", async () => {
    const updates: Record<string, unknown>[] = [];
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "turn/start") {
        setTimeout(() => {
          const item = {
            id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent",
            status: "inProgress", prompt: "Read the authorities",
            receiverThreadIds: ["reader-1"],
            agentsStates: { "reader-1": { status: "pendingInit" } },
          };
          transport.emit("item/started", { threadId, turnId, item });
          complete();
        }, 0);
        return { turn: { id: turnId } };
      }
      return {};
    });

    await streamCodex({
      model: "codex:gpt-5.6-luna",
      systemPrompt: "",
      messages: [{ role: "user", content: "Research." }],
      callbacks: { onSubagentUpdate: (update) => updates.push(update) },
    });

    expect(updates).toEqual([expect.objectContaining({
      id: "reader-1",
      activity: expect.objectContaining({ id: "spawn-1" }),
      activities: [expect.objectContaining({ id: "spawn-1" })],
    })]);
  });

  it("steers the active native turn", async () => {
    let control: { steer(message: { id: string; text: string }): Promise<void> } | null = null;
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "turn/start") return { turn: { id: turnId } };
      if (method === "turn/steer") return { turnId };
      return {};
    });
    const running = streamCodex({
      model: "codex:gpt-5.6-luna",
      systemPrompt: "",
      messages: [{ role: "user", content: "Wait." }],
      providerSession: {
        persist: true,
        onControl: (value) => {
          control = value;
        },
      },
    });
    await vi.waitFor(() => expect(control).not.toBeNull());
    const steering = control!.steer({ id: "steer-1", text: "Answer now." });
    expect(transport.request).not.toHaveBeenCalledWith("turn/steer", expect.anything());
    transport.emit("turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
    await steering;
    expect(transport.request).toHaveBeenCalledWith("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      clientUserMessageId: "steer-1",
      input: [{ type: "text", text: "Answer now.", text_elements: [] }],
    });
    complete("Draft. Steered.");
    await expect(running).resolves.toMatchObject({ fullText: "Draft. Steered." });
  });

  it("interrupts the provider turn before reporting an abort", async () => {
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "turn/start") return { turn: { id: turnId } };
      if (method === "turn/interrupt") {
        queueMicrotask(() =>
          transport.emit("turn/completed", {
            threadId,
            turn: { id: turnId, status: "interrupted" },
          }),
        );
      }
      return {};
    });
    const abort = new AbortController();
    const running = streamCodex({
      model: "codex:gpt-5.6-luna",
      systemPrompt: "",
      messages: [{ role: "user", content: "Wait." }],
      abortSignal: abort.signal,
    });
    await vi.waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith("turn/start", expect.anything()),
    );
    abort.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.request).toHaveBeenCalledWith("turn/interrupt", { threadId, turnId });
  });

  it("does not misreport an unsolicited provider interruption as user cancellation", async () => {
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "turn/start") {
        setTimeout(() =>
          transport.emit("turn/completed", {
            threadId,
            turn: { id: turnId, status: "interrupted" },
          }),
        0);
        return { turn: { id: turnId } };
      }
      return {};
    });

    await expect(streamCodex({
      model: "codex:gpt-5.6-luna",
      systemPrompt: "",
      messages: [{ role: "user", content: "Wait." }],
    })).rejects.toThrow(
      "Codex app-server interrupted the turn without a Beaver cancellation request.",
    );
  });
});
