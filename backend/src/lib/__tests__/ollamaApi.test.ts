import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Ollama model catalog", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_BASE_URL = "http://desktop.test:11434";
    delete process.env.OLLAMA_MODELS;
    delete process.env.OLLAMA_THINKING_MODELS;
  });

  afterEach(() => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODELS;
    delete process.env.OLLAMA_THINKING_MODELS;
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
