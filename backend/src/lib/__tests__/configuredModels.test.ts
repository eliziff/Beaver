import { afterEach, expect, it, vi } from "vitest";
import { configuredModels, configuredAvailable, configuredApiKey } from "../llm/registry";
import { isSupportedModel, modelSupportsImageInput } from "../llm/models";
import { streamChatWithTools } from "../llm";

const model = { id: "my-model", provider: "openai-compatible", location: "local",
  baseUrl: "http://127.0.0.1:8000/v1", apiModel: "qwen", maxTokensField: "max_completion_tokens" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("rejects malformed and duplicate declarations without echoing secrets", () => {
  vi.stubEnv("MIKE_MODEL_CONFIG_JSON", JSON.stringify({ models: [{ ...model, baseUrl: "https://secret@host/" }] }));
  expect(() => configuredModels()).toThrow("valid, uniquely named");
  vi.stubEnv("MIKE_MODEL_CONFIG_JSON", JSON.stringify({ models: [model, model] }));
  expect(() => configuredModels()).toThrow("valid, uniquely named");
});

it("resolves credential sources and model capabilities without claiming undeclared models", () => {
  vi.stubEnv("MIKE_MODEL_CONFIG_JSON", JSON.stringify({ models: [{ ...model, apiKeyProvider: "openai" }] }));
  const declared = configuredModels()[0];
  expect(configuredAvailable(declared)).toBe(false);
  expect(configuredApiKey(declared, { openai: "personal" })).toBe("personal");
  expect(isSupportedModel("configured:my-model")).toBe(true);
  expect(isSupportedModel("configured:missing")).toBe(false);
  expect(modelSupportsImageInput("configured:my-model")).toBe(false);
});

it("executes recovered local tool calls and continues with exact results through the SDK", async () => {
  vi.stubEnv("MIKE_MODEL_CONFIG_JSON", JSON.stringify({ models: [model] }));
  const requests: any[] = [], calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    const body = JSON.parse(String(init.body)); requests.push(body);
    expect(body.model).toBe("qwen");
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
    return Response.json({ id: `chat-${requests.length}`, created: 1, model: "qwen",
      choices: [{ index: 0, message: { role: "assistant", content: requests.length === 1
        ? '<think>Check source.</think><tool_call>{"name":"lookup","arguments":{"query":"evidence"}}</tool_call>'
        : "Found evidence." }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
  });
  const reasoning = vi.fn();
  const result = await streamChatWithTools({ model: "configured:my-model", systemPrompt: "Read",
    messages: [{ role: "user", content: "Find evidence" }], maxTokens: 2048,
    tools: [{ name: "lookup", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
    callbacks: { onReasoningDelta: reasoning }, runTools: async ([call]) => {
      expect(call.input).toEqual({ query: "evidence" }); calls.push(call.id);
      return [{ tool_use_id: call.id, content: "Verified source" }];
    } });
  expect(result.fullText).toBe("Found evidence.");
  expect(reasoning).toHaveBeenCalledWith("Check source.");
  expect(requests[1].messages).toContainEqual({ role: "tool", tool_call_id: calls[0], content: "Verified source" });
});
