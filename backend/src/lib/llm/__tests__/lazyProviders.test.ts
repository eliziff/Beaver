import { afterEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({
  claude: vi.fn(),
  gemini: vi.fn(),
  openai: vi.fn(),
  deepseek: vi.fn(),
  openrouter: vi.fn(),
  codexApi: vi.fn(),
}));

afterEach(() => vi.unstubAllEnvs());

describe("LLM provider loading", () => {
  it("loads only the selected provider", async () => {
    vi.stubEnv("GEMINI_API_KEY", "invalid-gemini-key");
    for (const provider of Object.keys(loaded) as Array<keyof typeof loaded>) {
      vi.doMock(`../${provider}`, () => {
        loaded[provider]();
        return {
          streamCodexApi: vi.fn(async () => ({ fullText: "codex" })),
        };
      });
    }
    const llm = await import("../index");
    expect(
      Object.values(loaded).every((factory) => !factory.mock.calls.length),
    ).toBe(true);

    await expect(
      llm.completeText({ model: "codex:gpt-5.2", user: "hello" }),
    ).resolves.toBe("codex");
    expect(loaded.codexApi).toHaveBeenCalledOnce();
    expect(
      Object.entries(loaded)
        .filter(([provider]) => provider !== "codexApi")
        .every(([, factory]) => !factory.mock.calls.length),
    ).toBe(true);
  });
});
