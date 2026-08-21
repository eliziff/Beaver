import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "../llm/types";

const sse = (...events: unknown[]) => new Response(
  `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { "Content-Type": "text/event-stream" } },
);
const tool: Tool = {
  name: "lookup",
  description: "Look up a source",
  inputSchema: { type: "object", properties: {} },
};

describe("Ollama API", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    delete process.env.OLLAMA_TRUSTED_HTTP_ORIGINS;
  });
  afterEach(() => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_TRUSTED_HTTP_ORIGINS;
    vi.unstubAllGlobals();
  });

  it("lists installed models with standard fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: "qwen3:32b", capabilities: ["thinking", "tools"] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { getOllamaModelCatalog } = await import("../llm/ollamaModels");
    await expect(getOllamaModelCatalog()).resolves.toEqual({
      source: "live",
      models: [{ name: "qwen3:32b", displayName: "Qwen 3 32B", supportsThinking: true }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects remote HTTP unless its exact origin is trusted", async () => {
    process.env.OLLAMA_BASE_URL = "http://desktop.test:11434";
    const models = await import("../llm/ollamaModels");
    expect(models.ollamaBaseUrl).toThrow("Refusing insecure remote Ollama endpoint");
    process.env.OLLAMA_TRUSTED_HTTP_ORIGINS = "http://desktop.test:11434";
    expect(models.ollamaBaseUrl()).toBe("http://desktop.test:11434");
    process.env.OLLAMA_BASE_URL = "https://user:secret@desktop.test";
    expect(models.ollamaBaseUrl).toThrow("credentials are not allowed");
  });

  it("continues tools through the OpenAI-compatible endpoint", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
      requests.push(JSON.parse(String(init.body)));
      return requests.length === 1
        ? sse({ choices: [{ delta: { tool_calls: [{
            index: 0,
            id: "call-1",
            function: { name: "lookup", arguments: "{}" },
          }] } }] })
        : sse({ choices: [{ delta: { content: "Found." } }] });
    }));
    const { streamOllama } = await import("../llm/ollamaApi");
    const result = await streamOllama({
      model: "ollama:qwen3:32b",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Find it." }],
      tools: [tool],
      runTools: async () => [{ tool_use_id: "call-1", content: "source" }],
    });
    expect(result.fullText).toBe("Found.");
    expect(requests[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call-1" })] }),
      { role: "tool", tool_call_id: "call-1", content: "source" },
    ]));
  });

  it("caps max reasoning at Ollama's supported high effort", async () => {
    let request: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      return sse({ choices: [{ delta: { content: "Ready." } }] });
    }));
    const { streamOllama } = await import("../llm/ollamaApi");
    await streamOllama({
      model: "ollama:qwen3.8:27b-ud-q2-k-xl",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Hello." }],
      tools: [],
      enableThinking: true,
      reasoningEffort: "max",
    });
    expect(request.reasoning_effort).toBe("high");
  });
});
