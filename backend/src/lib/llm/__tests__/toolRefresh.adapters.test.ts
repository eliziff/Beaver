import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  claudeStream: vi.fn(),
  claudeBetaStream: vi.fn(),
  geminiStream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { stream: sdkMocks.claudeStream };
    beta = { messages: { stream: sdkMocks.claudeBetaStream } };
  },
}));

vi.mock("@google/genai", () => ({
  FunctionCallingConfigMode: { ANY: "ANY" },
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
  sdkMocks.claudeBetaStream.mockReset();
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
      .mockResolvedValueOnce(
        geminiReply([{ functionCall: { id: "call-2", name: "revealed", args: {} } }]),
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
      runTools: async ([call]) => {
        if (call.name === "discover") {
          activeTools = [...activeTools, tool("revealed")];
        }
        return [{ tool_use_id: call.id, content: "opened" }];
      },
    });

    expect(sdkMocks.geminiStream).toHaveBeenCalledTimes(3);
    expect(sdkMocks.geminiStream.mock.calls.map(([request]) =>
      request.config.tools[0].functionDeclarations.map(
        (entry: { name: string }) => entry.name,
      )
    )).toEqual([
      ["discover"],
      ["discover", "revealed"],
      ["discover", "revealed"],
    ]);
    expect(sdkMocks.geminiStream.mock.calls[1][0].config.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["revealed"],
      },
    });
  });

  it("delivers queued steering at the next safe boundary on Claude and Gemini", async () => {
    sdkMocks.claudeStream
      .mockReturnValueOnce(claudeReply([{ type: "text", text: "draft" }], "end_turn"))
      .mockReturnValueOnce(claudeReply([{ type: "text", text: "revised" }], "end_turn"));
    sdkMocks.geminiStream
      .mockResolvedValueOnce(geminiReply([{ text: "draft" }]))
      .mockResolvedValueOnce(geminiReply([{ text: "revised" }]));
    const takeSteering = vi.fn()
      .mockReturnValueOnce([{ id: "s1", text: "Focus on section 8." }])
      .mockReturnValue([]);

    await streamClaude({
      model: "claude-sonnet-4-6",
      systemPrompt: "system",
      messages: [{ role: "user", content: "review" }],
      apiKeys: { claude: "test-key" },
      takeSteering,
    });
    takeSteering.mockClear().mockReturnValueOnce([
      { id: "s1", text: "Focus on section 8." },
    ]).mockReturnValue([]);
    await streamGemini({
      model: "gemini-3-flash-preview",
      systemPrompt: "system",
      messages: [{ role: "user", content: "review" }],
      apiKeys: { gemini: "test-key" },
      takeSteering,
    });

    expect(sdkMocks.claudeStream.mock.calls[1][0].messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "Focus on section 8." }],
    });
    expect(sdkMocks.geminiStream.mock.calls[1][0].contents.at(-1)).toEqual({
      role: "user",
      parts: [{ text: "Focus on section 8." }],
    });
  });

  it("uses Anthropic's native compaction contract and reports its checkpoint", async () => {
    const reply = claudeReply([{ type: "text", text: "done" }], "end_turn");
    reply.on.mockImplementation((name: string, callback: (event: unknown) => void) => {
      if (name === "streamEvent") {
        callback({
          type: "content_block_start",
          index: 0,
          content_block: { type: "compaction" },
        });
        callback({
          type: "content_block_delta",
          index: 0,
          delta: { type: "compaction_delta", content: "durable summary" },
        });
      }
      return reply;
    });
    sdkMocks.claudeBetaStream.mockReturnValueOnce(reply);
    const onCompaction = vi.fn();
    const onContextCheckpoint = vi.fn();

    await streamClaude({
      model: "claude-sonnet-4-6",
      systemPrompt: "system",
      messages: [{ role: "user", content: "continue" }],
      compactThreshold: 150_000,
      callbacks: { onCompaction, onContextCheckpoint },
      apiKeys: { claude: "test-key" },
    });

    expect(sdkMocks.claudeBetaStream.mock.calls[0][0]).toMatchObject({
      betas: ["compact-2026-01-12"],
      context_management: {
        edits: [{
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 150_000 },
        }],
      },
    });
    expect(onCompaction.mock.calls).toEqual([["running"], ["completed"]]);
    expect(onContextCheckpoint).toHaveBeenCalledWith({
      provider: "claude",
      content: "durable summary",
    });
  });
});
