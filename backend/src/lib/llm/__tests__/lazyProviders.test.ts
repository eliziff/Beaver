import { afterEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({
  claude: vi.fn(),
  gemini: vi.fn(),
  openai: vi.fn(),
  deepseek: vi.fn(),
  codex: vi.fn(),
}));
const streamCodex = vi.hoisted(() => vi.fn(async () => ({ fullText: "codex" })));

afterEach(() => {
  vi.unstubAllEnvs();
  streamCodex.mockClear();
});

describe("LLM provider loading", () => {
  it("loads only the selected provider", async () => {
    vi.stubEnv("GEMINI_API_KEY", "invalid-gemini-key");
    for (const provider of Object.keys(loaded) as Array<keyof typeof loaded>) {
      vi.doMock(`../${provider}`, () => {
        loaded[provider]();
        return {
          streamCodex,
        };
      });
    }
    const llm = await import("../index");
    expect(
      Object.values(loaded).every((factory) => !factory.mock.calls.length),
    ).toBe(true);

    await expect(
      llm.completeText({ model: "codex:gpt-5.2", user: "hello", maxTokens: 321 }),
    ).resolves.toBe("codex");
    expect(loaded.codex).toHaveBeenCalledOnce();
    expect(streamCodex).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 321,
    }));
    expect(
      Object.entries(loaded)
        .filter(([provider]) => provider !== "codex")
        .every(([, factory]) => !factory.mock.calls.length),
    ).toBe(true);
  });
});
