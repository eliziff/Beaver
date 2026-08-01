import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  claudeStream: vi.fn(),
  geminiStream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { stream: sdkMocks.claudeStream };
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class GoogleGenAI {
    models = { generateContentStream: sdkMocks.geminiStream };
  },
}));

import { streamClaude } from "../claude";
import { streamGemini } from "../gemini";
import type { OpenAIToolSchema } from "../types";

const tool = (name: string): OpenAIToolSchema => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  },
});

const claudeReply = (content: Record<string, unknown>[], stopReason: string) => ({
  on: vi.fn(),
  abort: vi.fn(),
  finalMessage: vi.fn().mockResolvedValue({
    content,
    stop_reason: stopReason,
  }),
});

const geminiReply = (parts: Record<string, unknown>[]) => ({
  async *[Symbol.asyncIterator]() {
    yield { candidates: [{ content: { parts } }] };
  },
});

beforeEach(() => {
  sdkMocks.claudeStream.mockReset();
  sdkMocks.geminiStream.mockReset();
});

describe("dynamic provider tool schemas", () => {
  it("refreshes Claude tools after a discovery call", async () => {
    sdkMocks.claudeStream
      .mockReturnValueOnce(
        claudeReply(
          [{ type: "tool_use", id: "call-1", name: "discover", input: {} }],
          "tool_use",
        ),
      )
      .mockReturnValueOnce(
        claudeReply([{ type: "text", text: "done" }], "end_turn"),
      );
    let activeTools = [tool("discover")];

    await streamClaude({
      model: "claude-test",
      systemPrompt: "system",
      messages: [{ role: "user", content: "research" }],
      tools: activeTools,
      resolveTools: () => activeTools,
      apiKeys: { claude: "test-key" },
      runTools: async () => {
        activeTools = [...activeTools, tool("revealed")];
        return [{ tool_use_id: "call-1", content: "opened" }];
      },
    });

    expect(sdkMocks.claudeStream).toHaveBeenCalledTimes(2);
    expect(sdkMocks.claudeStream.mock.calls.map(([request]) =>
      request.tools.map((entry: { name: string }) => entry.name)
    )).toEqual([["discover"], ["discover", "revealed"]]);
  });

  it("refreshes Gemini function declarations after a discovery call", async () => {
    sdkMocks.geminiStream
      .mockResolvedValueOnce(
        geminiReply([{ functionCall: { id: "call-1", name: "discover", args: {} } }]),
      )
      .mockResolvedValueOnce(geminiReply([{ text: "done" }]));
    let activeTools = [tool("discover")];

    await streamGemini({
      model: "gemini-test",
      systemPrompt: "system",
      messages: [{ role: "user", content: "research" }],
      tools: activeTools,
      resolveTools: () => activeTools,
      apiKeys: { gemini: "test-key" },
      runTools: async () => {
        activeTools = [...activeTools, tool("revealed")];
        return [{ tool_use_id: "call-1", content: "opened" }];
      },
    });

    expect(sdkMocks.geminiStream).toHaveBeenCalledTimes(2);
    expect(sdkMocks.geminiStream.mock.calls.map(([request]) =>
      request.config.tools[0].functionDeclarations.map(
        (entry: { name: string }) => entry.name,
      )
    )).toEqual([["discover"], ["discover", "revealed"]]);
  });
});
