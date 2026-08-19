import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  anthropicBetaCreate: vi.fn(),
  anthropicClient: vi.fn(),
  geminiCreate: vi.fn(),
  geminiClient: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    constructor(options: unknown) { sdk.anthropicClient(options); }
    messages = { create: sdk.anthropicCreate };
    beta = { messages: { create: sdk.anthropicBetaCreate } };
  },
}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class GoogleGenAI {
    constructor(options: unknown) { sdk.geminiClient(options); }
    models = { generateContentStream: sdk.geminiCreate };
  },
}));

import { streamClaude } from "./claude";
import { streamDeepSeek } from "./deepseek";
import { streamGemini } from "./gemini";
import { streamResponses } from "./openai";
import type { Tool } from "./types";

const tool: Tool = {
  name: "lookup",
  description: "Look up a source",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
};
const generator = (events: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
  },
});
const sse = (...events: unknown[]) => new Response(
  `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { "Content-Type": "text/event-stream" } },
);

afterEach(() => {
  sdk.anthropicCreate.mockReset();
  sdk.anthropicBetaCreate.mockReset();
  sdk.anthropicClient.mockReset();
  sdk.geminiCreate.mockReset();
  sdk.geminiClient.mockReset();
  vi.unstubAllGlobals();
});

describe("provider wire adapters", () => {
  it("preserves Anthropic signed thinking blocks through tool continuation", async () => {
    sdk.anthropicBetaCreate
      .mockResolvedValueOnce(generator([
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-1", name: "lookup", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"id\":\"62\"}" } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "compaction", content: "", signature: "" } },
        { type: "content_block_delta", index: 2, delta: { type: "compaction_delta", content: "Continue exactly." } },
        { type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: "compact-signed" } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]))
      .mockResolvedValueOnce(generator([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ]));

    const result = await streamClaude({
      model: "claude-sonnet-4-6",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Find it." }],
      tools: [tool],
      enableThinking: true,
      compactThreshold: 120_000,
      apiKeys: { claude: "test" },
      runTools: async () => [{ tool_use_id: "call-1", content: "source" }],
    });

    expect(result.fullText).toBe("Found.");
    expect(sdk.anthropicClient).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://api.anthropic.com",
    }));
    expect(sdk.anthropicBetaCreate.mock.calls[0][0]).toMatchObject({
      betas: ["compact-2026-01-12"],
      context_management: { edits: [{ trigger: { type: "input_tokens", value: 120_000 } }] },
    });
    expect(sdk.anthropicBetaCreate.mock.calls[1][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          { type: "thinking", thinking: "Check.", signature: "signed" },
          { type: "tool_use", id: "call-1", name: "lookup", input: { id: "62" } },
          { type: "compaction", content: "Continue exactly.", signature: "compact-signed" },
        ]),
      }),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "source" }] },
    ]));
  });

  it("replays opaque Responses items on a fixed stateless hosted endpoint", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      expect(url).toBe("https://openrouter.ai/api/v1/responses");
      return requests.length === 1
        ? sse(
            { type: "response.output_item.added", item: { type: "compaction" } },
            { type: "response.output_item.done", item: { type: "compaction", id: "cmp-1", encrypted_content: "opaque" } },
            { type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"id\":\"62\"}" } },
            { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 2 } } },
          )
        : sse(
            { type: "response.output_text.delta", delta: "Found." },
            { type: "response.completed", response: { id: "resp-2" } },
          );
    }));
    const checkpoint = vi.fn();
    const result = await streamResponses({
      model: "meta/muse-spark-1.1",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Find it." }],
      tools: [tool],
      apiKeys: { openrouter: "test" },
      callbacks: { onContextCheckpoint: checkpoint },
      runTools: async () => [{ tool_use_id: "call-1", content: "source" }],
    }, "openrouter");

    expect(result.fullText).toBe("Found.");
    expect(requests[1].previous_response_id).toBeUndefined();
    expect(requests[1].input).toEqual(expect.arrayContaining([
      { type: "compaction", id: "cmp-1", encrypted_content: "opaque" },
      { type: "function_call_output", call_id: "call-1", output: "source" },
    ]));
    expect(checkpoint).toHaveBeenCalledWith({
      provider: "openai",
      item: { type: "compaction", id: "cmp-1", encrypted_content: "opaque" },
    });
  });

  it("continues OpenAI by response id and sends hosted compaction controls", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      requests.push(JSON.parse(String(init.body)));
      return requests.length === 1
        ? sse(
            { type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" } },
            { type: "response.completed", response: { id: "resp-1", service_tier: "priority" } },
          )
        : sse(
            { type: "response.output_text.delta", delta: "Found." },
            { type: "response.completed", response: { id: "resp-2" } },
          );
    }));
    const result = await streamResponses({
      model: "gpt-5.5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Find it." }],
      tools: [tool],
      serviceTier: "fast",
      compactThreshold: 120_000,
      apiKeys: { openai: "test" },
      runTools: async () => [{ tool_use_id: "call-1", content: "source" }],
    }, "openai");
    expect(requests[0]).toMatchObject({
      service_tier: "fast",
      context_management: [{ type: "compaction", compact_threshold: 120_000 }],
    });
    expect(requests[1]).toMatchObject({
      previous_response_id: "resp-1",
      input: [{ type: "function_call_output", call_id: "call-1", output: "source" }],
    });
    expect(result.serviceTier).toBe("priority");
  });

  it("preserves DeepSeek reasoning_content and cache usage", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      requests.push(JSON.parse(String(init.body)));
      return requests.length === 1
        ? sse(
            { choices: [{ delta: { reasoning_content: "Check." } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{\"id\":\"62\"}" } }] } }] },
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 4 } },
          )
        : sse({ choices: [{ delta: { content: "Found." } }] });
    }));
    const result = await streamDeepSeek({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Find it." }],
      tools: [tool],
      enableThinking: true,
      reasoningEffort: "high",
      apiKeys: { deepseek: "test" },
      runTools: async () => [{ tool_use_id: "call-1", content: "source" }],
    });

    expect(requests[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", reasoning_content: "Check." }),
      { role: "tool", tool_call_id: "call-1", content: "source" },
    ]));
    expect(requests[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 6,
      cacheWriteInputTokens: 4,
    });
  });

  it("echoes Gemini thoughtSignature and exact function-call id", async () => {
    sdk.geminiCreate
      .mockResolvedValueOnce(generator([{
        candidates: [{ content: { parts: [{
          functionCall: { id: "call-1", name: "lookup", args: { id: "62" } },
          thoughtSignature: "signed",
        }] } }],
      }]))
      .mockResolvedValueOnce(generator([{
        candidates: [{ content: { parts: [{ text: "Found." }] } }],
      }]));
    const result = await streamGemini({
      model: "gemini-test",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Find it." }],
      tools: [tool],
      apiKeys: { gemini: "test" },
      runTools: async () => [{ tool_use_id: "call-1", content: "source" }],
    });

    const second = sdk.geminiCreate.mock.calls[1][0].contents;
    expect(result.fullText).toBe("Found.");
    expect(sdk.geminiClient).toHaveBeenCalledWith(expect.objectContaining({
      httpOptions: { baseUrl: "https://generativelanguage.googleapis.com" },
    }));
    expect(second).toEqual(expect.arrayContaining([
      { role: "model", parts: [{
        functionCall: { id: "call-1", name: "lookup", args: { id: "62" } },
        thoughtSignature: "signed",
      }] },
      { role: "user", parts: [{
        functionResponse: { id: "call-1", name: "lookup", response: { output: "source" } },
      }] },
    ]));
  });
});
