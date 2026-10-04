import { afterEach, expect, it, vi } from "vitest";
import { streamHosted, IncompleteGenerationError } from "./sdk";
import type { ModelState, StreamChatParams, Tool } from "./types";

const read: Tool = { name: "Read", inputSchema: { type: "object",
  properties: { file: { type: "string" } }, required: ["file"], additionalProperties: false } };
const params: StreamChatParams = { model: "gemini-3-flash-preview", systemPrompt: "Read the document.",
  messages: [{ role: "user", content: "What does it say?" }], tools: [read],
  apiKeys: { gemini: "test", claude: "test", openai: "test" } };
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
const gemini = (parts: unknown[], finishReason = "STOP") => sse([{ candidates: [{
  index: 0, content: { role: "model", parts }, finishReason,
}], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 } }]);
const anthropic = (reason = "end_turn") => sse([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10,
      cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
]);
const openai = (incomplete = false, text = "Answer") => sse([
  { type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-5.5" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }] } },
  { type: incomplete ? "response.incomplete" : "response.completed", response: {
    id: "resp_1", created_at: 1, model: "gpt-5.5", status: incomplete ? "incomplete" : "completed",
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  } },
]);
function transport(responses: (() => Response)[]) {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift(); if (!next) throw new Error("Unexpected inference request");
    return next();
  });
  vi.stubGlobal("fetch", fetch);
  return { bodies, fetch };
}
afterEach(() => vi.unstubAllGlobals());

it("Gemini tool discovery expands choices, and a new turn replays real tool results and signatures", async () => {
  const load: Tool = { name: "load_tools", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const write: Tool = { ...read, name: "Write" };
  let visible = [load, read];
  const state: ModelState[] = [], tools = vi.fn(async calls => {
    if (calls[0].name === "load_tools") visible = [load, read, write];
    return calls.map((call: any) => ({ tool_use_id: call.id, content: call.name === "Read" ? "Secret evidence: 47" : "Loaded Write" }));
  });
  const { bodies } = transport([
    () => gemini([{ functionCall: { name: "load_tools", args: {} }, thoughtSignature: "load-signature" }]),
    () => gemini([{ functionCall: { name: "Read", args: { file: "source" } }, thoughtSignature: "read-signature" }]),
    () => gemini([{ text: "It says 47." }]),
    () => gemini([{ text: "Still 47." }]),
  ]);
  await streamHosted({ ...params, resolveTools: () => visible, runTools: tools,
    enableThinking: true, reasoningEffort: "low", callbacks: { onModelMessages: value => { state.push(value); } } });
  expect(bodies[1].toolConfig?.functionCallingConfig?.mode).not.toBe("ANY");
  expect(bodies[1].tools[0].functionDeclarations.map((tool: any) => tool.name)).toContain("Read");
  expect(bodies[0].generationConfig.thinkingConfig.thinkingLevel).toBe("low");
  await streamHosted({ ...params, messages: [params.messages[0], ...state.map(modelState => ({
    role: "assistant" as const, content: "", modelState,
  })), { role: "user", content: "And now?" }] });
  const replay = JSON.stringify(bodies[3].contents);
  expect(replay).toContain("Secret evidence: 47");
  expect(replay).toContain("read-signature");
  expect(replay).toContain("functionCall");
  expect(replay).toContain("functionResponse");
  expect(tools).toHaveBeenCalledTimes(2);
});

it("Claude enables caching, honors effort, and counts cached tokens as context", async () => {
  const { bodies } = transport([() => anthropic()]);
  const context = vi.fn();
  const result = await streamHosted({ ...params, model: "claude-sonnet-4-6", tools: [],
    enableThinking: true, reasoningEffort: "low", callbacks: { onContextUsage: context } });
  expect(bodies[0]).toMatchObject({ cache_control: { type: "ephemeral" },
    thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  expect(result.usage).toMatchObject({ inputTokens: 60, outputTokens: 4, cacheReadInputTokens: 30, cacheWriteInputTokens: 20 });
  expect(context).toHaveBeenCalledWith(expect.objectContaining({ usedTokens: 60 }));
});

it("never executes an otherwise complete call in a truncated model step", async () => {
  transport([() => gemini([{ functionCall: { name: "Read", args: { file: "a" } } }], "MAX_TOKENS")]);
  const run = vi.fn(), saved = vi.fn();
  await expect(streamHosted({ ...params, runTools: run, callbacks: { onModelMessages: saved } }))
    .rejects.toBeInstanceOf(IncompleteGenerationError);
  expect(run).not.toHaveBeenCalled();
  expect(JSON.stringify(saved.mock.calls[0][0])).toContain("Tool not executed");
});

it("validates structured output rather than accepting schema-shaped instructions alone", async () => {
  const schema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
  const { bodies } = transport([() => gemini([{ text: '{"count":7}' }]),
    () => gemini([{ text: '{"count":"seven"}' }])]);
  expect((await streamHosted({ ...params, tools: [], outputSchema: schema })).fullText).toBe('{"count":7}');
  expect(bodies[0].generationConfig.responseMimeType).toBe("application/json");
  await expect(streamHosted({ ...params, tools: [], outputSchema: schema })).rejects.toThrow();
});


it.each(["missing", "duplicate", "foreign"])("rejects %s tool results before saving ambiguous history", async defect => {
  transport([() => gemini([{ functionCall: { name: "Read", args: { file: "a" } } }])]);
  const saved = vi.fn();
  await expect(streamHosted({ ...params, callbacks: { onModelMessages: saved }, runTools: async calls => {
    const result = { tool_use_id: calls[0].id, content: "read" };
    return defect === "missing" ? [] : defect === "duplicate" ? [result, result]
      : [{ ...result, tool_use_id: "not-requested" }];
  } })).rejects.toThrow(/result|pair/i);
  expect(saved).not.toHaveBeenCalled();
});

it("DeepSeek reasoning and tool results survive both a step and a later turn", async () => {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "completion", model: "deepseek-flash",
    created: 1, choices: [{ index: 0, delta, finish_reason }] });
  const { bodies } = transport([
    () => sse([chunk({ role: "assistant", reasoning_content: "Find the exact passage." }),
      chunk({ tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "Read", arguments: '{"file":"a"}' } }] }),
      chunk({}, "tool_calls")]),
    () => sse([chunk({ role: "assistant", reasoning_content: "The passage answers this." }), chunk({ content: "It says 47." }, "stop")]),
    () => sse([chunk({ role: "assistant", content: "Still 47." }, "stop")]),
  ]);
  const history: ModelState[] = [];
  const runTools = vi.fn(async calls => calls.map((call: { id: string }) => ({ tool_use_id: call.id, content: "Exact passage: 47" })));
  const request = { ...params, model: "deepseek-flash", apiKeys: { deepseek: "test" }, enableThinking: true, runTools };
  await streamHosted({ ...request, callbacks: { onModelMessages: state => { history.push(state); } } });
  await streamHosted({ ...request, messages: [params.messages[0], ...history.map(modelState => ({
    role: "assistant" as const, content: "", modelState })), { role: "user", content: "Reformat it." }] });
  expect(bodies[1].messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "assistant", reasoning_content: "Find the exact passage." }),
    expect.objectContaining({ role: "tool", tool_call_id: "read-1", content: "Exact passage: 47" }),
  ]));
  expect(bodies[2].messages.filter((message: { role: string }) => message.role === "assistant")
    .map((message: { reasoning_content: string }) => message.reasoning_content))
    .toEqual(["Find the exact passage.", "The passage answers this."]);
  expect(runTools).toHaveBeenCalledOnce();
});

it("discards buffered SDK deltas and tool calls after cancellation", async () => {
  const controller = new AbortController(), deltas: string[] = [], run = vi.fn(), saved = vi.fn();
  transport([() => gemini([{ text: "Kept" }, { text: "Late" }, { functionCall: { name: "Read", args: { file: "x" } } }])]);
  await expect(streamHosted({ ...params, abortSignal: controller.signal, runTools: run,
    callbacks: { onModelMessages: saved, onContentDelta(text) { deltas.push(text); controller.abort(); } },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(deltas).toEqual(["Kept"]); expect(run).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
});

it("fails closed on persistence failure even though SDK observer exceptions are swallowed", async () => {
  const { fetch } = transport([() => gemini([{ functionCall: { name: "Read", args: { file: "a" } } }])]);
  const failure = new Error("Database unavailable");
  await expect(streamHosted({ ...params, runTools: async calls => [{ tool_use_id: calls[0].id, content: "Read a" }],
    callbacks: { onModelMessages: async () => { throw failure; } } })).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("settles and saves completed tool effects before reporting mid-batch cancellation", async () => {
  const saved = vi.fn(), controller = new AbortController();
  const { fetch } = transport([() => gemini([{ functionCall: { name: "Read", args: { file: "a" } } }])]);
  await expect(streamHosted({ ...params, abortSignal: controller.signal,
    runTools: async calls => { controller.abort(new DOMException("Cancelled", "AbortError"));
      return [{ tool_use_id: calls[0].id, content: "Completed before cancellation" }]; },
    callbacks: { onModelMessages: saved },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(saved.mock.calls[0][0].messages)).toContain("Completed before cancellation");
});

