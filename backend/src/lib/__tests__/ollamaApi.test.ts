import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "../llm/types";

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {} },
});

describe("Ollama model catalog", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_BASE_URL = "http://desktop.test:11434";
    delete process.env.OLLAMA_HOST_HEADER;
    delete process.env.OLLAMA_MODELS;
    delete process.env.OLLAMA_THINKING_MODELS;
    delete process.env.OLLAMA_NUM_CTX;
  });

  afterEach(() => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_HOST_HEADER;
    delete process.env.OLLAMA_MODELS;
    delete process.env.OLLAMA_THINKING_MODELS;
    delete process.env.OLLAMA_NUM_CTX;
    vi.unstubAllGlobals();
  });

  it("lists the models installed on the desktop", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: "qwen3:32b", capabilities: ["thinking", "tools"] },
          { model: "qwen3:8b" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getOllamaModelCatalog } = await import("../llm/ollamaApi");

    await expect(getOllamaModelCatalog()).resolves.toEqual({
      source: "live",
      models: [
        {
          name: "qwen3:32b",
          displayName: "Qwen 3 32B",
          supportsThinking: true,
        },
        {
          name: "qwen3:8b",
          displayName: "Qwen 3 8B",
          supportsThinking: false,
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://desktop.test:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sends only an explicitly selected thinking level", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: { role: "assistant", content: "ready" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { streamOllama } = await import("../llm/ollamaApi");

    await streamOllama({
      model: "ollama:qwen3:32b",
      systemPrompt: "",
      messages: [{ role: "user", content: "test" }],
      enableThinking: true,
      reasoningEffort: "low",
    });
    await streamOllama({
      model: "ollama:qwen3:32b",
      systemPrompt: "",
      messages: [{ role: "user", content: "test" }],
      enableThinking: true,
    });

    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ think: "low" });
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({ think: false });
  });

  it("sets the configured reverse-proxy host header", async () => {
    const hosts: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      hosts.push(request.headers.host);
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify(
            request.url === "/api/tags"
              ? { models: [] }
              : { message: { role: "assistant", content: "ready" } },
          ),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_HOST_HEADER = "localhost:11434";
    const { getOllamaModelCatalog, streamOllama } = await import(
      "../llm/ollamaApi"
    );

    try {
      await getOllamaModelCatalog();
      await streamOllama({
        model: "ollama:qwen3:32b",
        systemPrompt: "",
        messages: [{ role: "user", content: "test" }],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(hosts).toEqual(["localhost:11434", "localhost:11434"]);
  });

  it("reports an unreachable desktop instead of a generic fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { streamOllama } = await import("../llm/ollamaApi");

    await expect(
      streamOllama({
        model: "ollama:qwen3:32b",
        systemPrompt: "",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow(
      "Desktop Ollama is unreachable at http://desktop.test:11434",
    );
  });

  it("surfaces Ollama's structured error with a recovery step", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(
        JSON.stringify({
          error: "failed to parse JSON: unexpected end of JSON input",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )),
    );
    const { streamOllama } = await import("../llm/ollamaApi");

    await expect(
      streamOllama({
        model: "ollama:qwen3.5:2b",
        systemPrompt: "",
        messages: [{ role: "user", content: "research" }],
      }),
    ).rejects.toThrow(
      "Desktop Ollama failed (HTTP 500): failed to parse JSON: unexpected end of JSON input. Retry the request.",
    );
  });

  it("compacts old tool output while preserving the newest result", async () => {
    process.env.OLLAMA_NUM_CTX = "500";
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const call = fetchMock.mock.calls.length;
        return {
          ok: true,
          json: async () => ({
            message:
              call < 3
                ? {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        function: {
                          name: "search",
                          arguments: { query: `query-${call}` },
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: "done" },
          }),
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { streamOllama } = await import("../llm/ollamaApi");
    let resultNumber = 0;

    await streamOllama({
      model: "ollama:qwen3.5:2b",
      systemPrompt: "",
      messages: [{ role: "user", content: "research" }],
      runTools: async (calls) => {
        resultNumber += 1;
        return calls.map((call) => ({
          tool_use_id: call.id,
          content: `result-${resultNumber}:${"x".repeat(1_000)}`,
        }));
      },
    });

    const thirdMessages = bodies[2]?.messages as {
      role: string;
      content: string;
    }[];
    const toolResults = thirdMessages.filter(
      (message) => message.role === "tool",
    );
    expect(toolResults[0]?.content).toContain('"compacted":true');
    expect(toolResults[1]?.content).toContain("result-2:");
  });

  it("refreshes tools on the next tool-loop request", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return {
          ok: true,
          json: async () => ({
            message:
              bodies.length === 1
                ? {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                      function: { name: "discover", arguments: {} },
                    }],
                  }
                : { role: "assistant", content: "done" },
          }),
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { streamOllama } = await import("../llm/ollamaApi");
    let activeTools = [tool("discover")];

    await streamOllama({
      model: "ollama:qwen3.5:2b",
      systemPrompt: "system",
      messages: [{ role: "user", content: "research" }],
      tools: activeTools,
      resolveTools: () => activeTools,
      runTools: async (calls) => {
        activeTools = [...activeTools, tool("revealed")];
        return [{ tool_use_id: calls[0].id, content: "opened" }];
      },
    });

    expect(bodies.map((body) =>
      (body.tools as { function: { name: string } }[]).map((entry) => entry.function.name)
    )).toEqual([["discover"], ["discover", "revealed"]]);
  });

  it("delivers queued steering after a completed response", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return {
          ok: true,
          json: async () => ({
            message: {
              role: "assistant",
              content: bodies.length === 1 ? "draft" : "revised",
            },
          }),
        };
      },
    ));
    const { streamOllama } = await import("../llm/ollamaApi");
    const takeSteering = vi.fn()
      .mockReturnValueOnce([{ id: "s1", text: "Focus on section 8." }])
      .mockReturnValue([]);

    await streamOllama({
      model: "ollama:qwen3.5:2b",
      systemPrompt: "system",
      messages: [{ role: "user", content: "review" }],
      takeSteering,
    });

    expect(bodies[1].messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: "draft" },
      { role: "user", content: "Focus on section 8." },
    ]));
  });

  it("fails closed when the desktop is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { getOllamaModelCatalog } = await import("../llm/ollamaApi");

    await expect(getOllamaModelCatalog()).resolves.toMatchObject({
      source: "unavailable",
      models: [],
      error: "offline",
    });
  });

  it("keeps configured desktop models visible while Ollama is offline", async () => {
    process.env.OLLAMA_MODELS = "qwen3.5:2b,qwen3.5:9b";
    process.env.OLLAMA_THINKING_MODELS = "qwen3.5:2b,qwen3.5:9b";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { getOllamaModelCatalog } = await import("../llm/ollamaApi");

    await expect(getOllamaModelCatalog()).resolves.toEqual({
      source: "unavailable",
      models: [
        {
          name: "qwen3.5:2b",
          displayName: "Qwen 3.5 2B",
          supportsThinking: true,
        },
        {
          name: "qwen3.5:9b",
          displayName: "Qwen 3.5 9B",
          supportsThinking: true,
        },
      ],
      error: "offline",
    });
  });
});
