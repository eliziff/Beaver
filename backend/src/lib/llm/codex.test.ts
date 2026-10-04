import { beforeEach, describe, expect, it, vi } from "vitest";

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
  it("accepts early turn events and ignores stale events from the same thread", async () => {
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "turn/start") {
        transport.emit("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
        complete("stale", "previous-turn");
        complete("Current answer");
        return { turn: { id: turnId } };
      }
      return {};
    });
    const running = streamCodex({ model: "codex:gpt-5.6-luna", systemPrompt: "", messages: [] });
    // The later completion lets the old implementation fail without leaving a hung turn.
    const guard = setTimeout(() => complete(""), 100);
    try { expect((await running).fullText).toBe("Current answer"); }
    finally { clearTimeout(guard); }
  });

  it("rejects a steering acknowledgement for another turn", async () => {
    let control: { steer(message: { id: string; text: string }): Promise<void> } | null = null;
    transport.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "turn/start") return { turn: { id: turnId } };
      if (method === "turn/steer") return { turnId: "different-turn" };
      return {};
    });
    const onSteer = vi.fn();
    const running = streamCodex({ model: "codex:gpt-5.6-luna", systemPrompt: "", messages: [],
      callbacks: { onSteer }, providerSession: { persist: true, onControl(value) { control = value; } } });
    await vi.waitFor(() => expect(control).not.toBeNull());
    transport.emit("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    try {
      await expect(control!.steer({ id: "s1", text: "Correction" })).rejects.toThrow(/turn ID/i);
      expect(onSteer).not.toHaveBeenCalled();
    } finally { complete(); complete("", "different-turn"); await running; }
  });

});
