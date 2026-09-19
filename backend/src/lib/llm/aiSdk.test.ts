import { afterEach, expect, it, vi } from "vitest";
import { streamAiSdk } from "./aiSdk";
import type { StreamChatParams } from "./types";

const base: StreamChatParams = { model: "test", systemPrompt: "system",
  messages: [{ role: "user", content: "Read the source." }],
  tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }],
  apiKeys: { openai: "test", gemini: "test", claude: "test", deepseek: "test", openrouter: "test" },
  runTools: async ([call]) => [{ tool_use_id: call.id, content: "Source", images: [{
    filename: "page.png", mimeType: "image/png", data: "AAAB",
  }] }],
};
const sse = (events: unknown[]) => new Response(events.map((event) =>
  `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const responsesStart = (id: string) => ({ type: "response.created",
  response: { id, created_at: 1, model: "gpt-5.5" } });
const responseEnd = () => ({ type: "response.completed", response: { service_tier: "priority",
  usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 4 },
    output_tokens_details: { reasoning_tokens: 1 } } } });
const callItem = { type: "function_call", id: "fc-1", call_id: "call-1", name: "lookup", arguments: "{}", status: "completed" };
const responseTool = [responsesStart("resp-1"),
  { type: "response.output_item.added", output_index: 0, item: { ...callItem, arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 0, delta: "{}" },
  { type: "response.output_item.done", output_index: 0, item: callItem }, responseEnd()];
const responseText = [responsesStart("resp-2"),
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-2" } },
  { type: "response.output_text.delta", item_id: "msg-2", output_index: 0, delta: "Done." },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-2" } }, responseEnd()];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("rejects a truncated stream without executing its pending tools", async () => {
  vi.stubGlobal("fetch", async () => sse(responseTool.slice(0, -1)));
  const runTools = vi.fn();
  await expect(streamAiSdk({ ...base, model: "gpt-5.5", runTools }, "openai"))
    .rejects.toThrow("successful finish");
  expect(runTools).not.toHaveBeenCalled();
});

it("retries an SDK HTTP failure before visible output", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", async () => ++attempts === 1
    ? new Response('{"error":{"message":"Try again"}}', { status: 429 }) : sse(responseText));
  expect((await streamAiSdk({ ...base, model: "gpt-5.5" }, "openai")).fullText).toBe("Done.");
  expect(attempts).toBe(2);
});

it("continues Responses by exact id, preserves image tool output, usage and hosted controls", async () => {
  const requests: any[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.openai.com/v1/responses");
    requests.push(JSON.parse(String(init.body)));
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test");
    return sse(requests.length === 1 ? responseTool : responseText);
  });
  const result = await streamAiSdk({ ...base, model: "gpt-5.5", compactThreshold: 120_000,
    serviceTier: "fast", promptCacheKey: "chat-cache" }, "openai");
  expect(result.fullText).toBe("Done.");
  expect(requests[0]).toMatchObject({ prompt_cache_key: "chat-cache", service_tier: "fast",
    context_management: [{ type: "compaction", compact_threshold: 120_000 }] });
  expect(requests[1]).toMatchObject({ previous_response_id: "resp-1" });
  expect(JSON.stringify(requests[1].input)).toContain("data:image/png;base64,AAAB");
  expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 8 });
  expect(result.serviceTier).toBe("priority");
});

it("replays stateless Responses history and opaque compaction data", async () => {
  const requests: any[] = [], checkpoint = vi.fn();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return sse(requests.length === 1 ? [responseTool[0],
      { type: "response.output_item.done", output_index: 1,
        item: { type: "compaction", id: "cmp-1", encrypted_content: "opaque" } },
      ...responseTool.slice(1)] : responseText);
  });
  const result = await streamAiSdk({ ...base, model: "openrouter/test",
    callbacks: { onContextCheckpoint: checkpoint } }, "openrouter");
  expect(result.fullText).toBe("Done.");
  expect(requests[1].previous_response_id).toBeUndefined();
  expect(requests[1].input).toContainEqual({ type: "compaction", id: "cmp-1", encrypted_content: "opaque" });
  expect(checkpoint).toHaveBeenCalledWith({ provider: "openai",
    item: { type: "compaction", id: "cmp-1", encrypted_content: "opaque" } });
});

it("retains Gemini thought signatures, exact call ids and image results", async () => {
  const requests: any[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return sse([{ candidates: [{ content: { role: "model", parts: requests.length === 1
      ? [{ functionCall: { id: "call-1", name: "lookup", args: {} }, thoughtSignature: "signed" }]
      : [{ text: "Done." }] }, finishReason: "STOP" }] }]);
  });
  const result = await streamAiSdk({ ...base, model: "gemini-3-flash-preview" }, "gemini");
  expect(result.fullText).toBe("Done.");
  expect(requests[1].contents).toEqual(expect.arrayContaining([{ role: "model", parts: [{
    functionCall: { id: "call-1", name: "lookup", args: {} }, thoughtSignature: "signed",
  }] }]));
  expect(JSON.stringify(requests[1].contents)).toContain('"data":"AAAB"');
  expect(JSON.stringify(requests[1].contents)).toContain('"id":"call-1"');
});

it("preserves Anthropic signed reasoning, compaction and image results through the SDK", async () => {
  const requests: any[] = [], checkpoint = vi.fn();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const start = { type: "message_start", message: { id: `msg-${requests.length}`,
      model: "claude-sonnet-4-6", usage: { input_tokens: 5 } } };
    const end = [{ type: "message_delta", delta: { stop_reason: requests.length === 1 ? "tool_use" : "end_turn" },
      usage: { output_tokens: 3 } }, { type: "message_stop" }];
    return sse(requests.length === 1 ? [start,
      { type: "content_block_start", index: 0, content_block: { type: "compaction", content: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "Continue exactly." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Check." } },
      { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "signed" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call-1", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 2 }, ...end] : [start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 0 }, ...end]);
  });
  const result = await streamAiSdk({ ...base, model: "claude-sonnet-4-6", enableThinking: true,
    compactThreshold: 100_000, callbacks: { onContextCheckpoint: checkpoint } }, "claude");
  expect(result.fullText).toBe("Done.");
  expect(checkpoint).toHaveBeenCalledWith({ provider: "claude", content: "Continue exactly.",
    block: { type: "compaction", content: "Continue exactly." } });
  expect(JSON.stringify(requests[1].messages)).toContain('"signature":"signed"');
  expect(JSON.stringify(requests[1].messages)).toContain('"data":"AAAB"');
  expect(requests[1].messages[0].role).toBe("assistant");
});

it("preserves DeepSeek reasoning content, cache accounting and personal-key priority", async () => {
  const requests: any[] = [];
  vi.stubEnv("DEEPSEEK_API_KEY", "deployment-key");
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test");
    requests.push(JSON.parse(String(init.body)));
    return sse(requests.length === 1 ? [
      { choices: [{ index: 0, delta: { reasoning_content: "Check." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function",
        function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 6,
        prompt_cache_miss_tokens: 4 } },
    ] : [{ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] }]);
  });
  const result = await streamAiSdk({ ...base, model: "deepseek-v4-pro", enableThinking: true,
    reasoningEffort: "high" }, "deepseek");
  expect(result.fullText).toBe("Done.");
  expect(requests[0]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
  expect(JSON.stringify(requests[1].messages)).toContain('"reasoning_content":"Check."');
  expect(result.usage?.cacheReadInputTokens).toBe(6);
});
