import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import { TurnToolRegistry, toolOutcome } from "../chat/toolRegistry";
import { streamClaudeP } from "./claudeP";
import type { StreamChatParams, StreamChatResult } from "./types";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
const model = "claude-sonnet-4-6";
const runs: Array<{ controller: AbortController; result: Promise<StreamChatResult> }> = [];
afterEach(async () => {
  for (const run of runs) run.controller.abort();
  await Promise.allSettled(runs.splice(0).map(run => run.result));
  spawn.mockReset();
  vi.useRealTimers();
});

async function begin(options: Partial<StreamChatParams> = {}) {
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const callbacks = { onContextUsage: vi.fn(), onContentDelta: vi.fn(), onContentBlockEnd: vi.fn(),
    onReasoningDelta: vi.fn(), onReasoningBlockEnd: vi.fn(), onToolCallStart: vi.fn(), onActivity: vi.fn() };
  const result = streamClaudeP({ model: `claude-p:${model}`, systemPrompt: "Synthetic transport check",
    messages: [{ role: "user", content: "Inspect the fixture." }], abortSignal: controller.signal,
    callbacks, ...options });
  void result.catch(() => undefined);
  runs.push({ controller, result });
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  const send = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const event = (value: object, parent_tool_use_id: string | null = null) =>
    send({ type: "stream_event", event: value, parent_tool_use_id });
  const finish = (value: object = {}) => { send({ type: "result", result: "Done", ...value }); child.emit("close", 0); };
  return { child, callbacks, send, event, finish, result, controller };
}

it("activates both reported specialists in the same native invocation with one activity per dispatch", async () => {
  const executed: string[] = [], names = ["word_uno", "edit_docx_advanced"];
  const registry = new TurnToolRegistry<null>(names.map(name => ({ name, specialist: true,
    inputSchema: { type: "object" as const, properties: {} },
    execute: async () => { executed.push(name); return toolOutcome(name); },
  })));
  const run = await begin({ staticTools: registry.all(), resolveTools: () => registry.visible(),
    runTools: (calls, activity) => { activity?.(); return registry.run(calls, null); } });
  const [, args, options] = spawn.mock.calls[0];
  expect(options.env.ENABLE_TOOL_SEARCH).toBe("true");
  expect(args[args.indexOf("--tools") + 1]).toBe("ToolSearch");
  expect(args).toContain("--strict-mcp-config");
  const config = JSON.parse(await readFile(args[args.indexOf("--mcp-config") + 1], "utf8"));
  const client = new Client({ name: "native-transport-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.beaver.url), {
    requestInit: { headers: { Authorization: `Bearer ${options.env.BEAVER_CLAUDE_MCP_TOKEN}` } },
  }));
  try {
    run.send({ type: "system", subtype: "init", mcp_servers: [{ name: "beaver", status: "connected" }] });
    const catalog = (await client.listTools()).tools;
    expect(catalog.map(tool => tool.name)).toEqual(["load_tools", ...names]);
    // Native tool search already holds the schema, so a valid direct call runs.
    expect((await client.callTool({ name: names[0], arguments: {} })).isError).not.toBe(true);
    expect(executed).toEqual([names[0]]);
    for (const name of ["load_tools", ...names]) {
      run.event({ type: "content_block_start", content_block: { type: "tool_use", name: `mcp__beaver__${name}` } });
      expect((await client.callTool({ name, arguments: name === "load_tools" ? { names } : {} })).isError).not.toBe(true);
    }
    expect(executed).toEqual([names[0], ...names]);
    expect(run.callbacks.onToolCallStart.mock.calls.map(([call]) => call.name))
      .toEqual([names[0], "load_tools", ...names]);
    expect(run.callbacks.onActivity).toHaveBeenCalled();
    expect((await client.listTools()).tools).toEqual(catalog);
    run.finish();
    expect((await run.result).contextRounds?.[0].toolCallCount).toBe(4);
  } finally { await client.close(); run.controller.abort(); }
});

it("reports live cache-inclusive request context, not aggregate turn usage or a child's window", async () => {
  const run = await begin();
  const usage = { input_tokens: 0, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 5_000 };
  run.event({ type: "message_start", message: { id: "first", model, usage } });
  expect(run.callbacks.onContextUsage).toHaveBeenLastCalledWith({ usedTokens: 65_000, contextWindowTokens: 1_000_000 });
  run.event({ type: "message_delta", usage: { input_tokens: 1_000, output_tokens: 40 } });
  run.event({ type: "message_delta", usage: { input_tokens: 1_000, output_tokens: 60 } });
  expect(run.callbacks.onContextUsage).toHaveBeenCalledTimes(2);
  run.event({ type: "message_start", message: { model, usage: { input_tokens: 999_999 } } }, "child");
  run.send({ type: "assistant", parent_tool_use_id: "child", message: { model: "child-model", usage: { input_tokens: 9 } } });
  run.event({ type: "message_start", message: { id: "second", model, usage: { ...usage, input_tokens: 5_000 } } });
  run.send({ type: "assistant", message: { id: "second", model, usage: { ...usage, input_tokens: 5_000 } } });
  expect(run.callbacks.onContextUsage).toHaveBeenCalledTimes(3);
  run.finish({ usage: { input_tokens: 6_000, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 10_000, output_tokens: 100 },
    modelUsage: { [model]: { contextWindow: 200_000 }, "child-model": { contextWindow: 10_000 } } });
  expect((await run.result).usage).toMatchObject({ inputTokens: 136_000, outputTokens: 100 });
  expect(run.callbacks.onContextUsage).toHaveBeenLastCalledWith({ usedTokens: 70_000, contextWindowTokens: 200_000 });
});

it.each(["auto", "none"] as const)("preserves content and honors %s reasoning visibility without rendering signatures", async reasoningSummary => {
  const run = await begin({ reasoningSummary });
  const delta = Buffer.from(JSON.stringify({ type: "stream_event", event: {
    type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Compare café passages." },
  } }) + "\n");
  const split = delta.indexOf(Buffer.from("é")) + 1;
  run.child.stdout.write(delta.subarray(0, split));
  run.child.stdout.write(delta.subarray(split));
  run.event({ type: "content_block_delta", delta: { type: "signature_delta", signature: "opaque-signature" } });
  run.event({ type: "content_block_stop" });
  run.event({ type: "content_block_start", content_block: { type: "redacted_thinking", data: "opaque-redaction" } });
  run.event({ type: "content_block_stop" });
  run.event({ type: "content_block_delta", delta: { type: "text_delta", text: "child text" } }, "child");
  run.event({ type: "content_block_delta", delta: { type: "text_delta", text: "Done" } });
  run.event({ type: "content_block_stop" });
  run.finish();
  expect((await run.result).fullText).toBe("Done");
  expect(run.callbacks.onContentDelta.mock.calls).toEqual([["Done"]]);
  expect(run.callbacks.onReasoningDelta.mock.calls).toEqual(reasoningSummary === "auto" ? [["Compare café passages."]] : []);
  expect(run.callbacks.onReasoningBlockEnd).toHaveBeenCalledTimes(reasoningSummary === "auto" ? 1 : 0);
  expect(run.callbacks.onContentBlockEnd).toHaveBeenCalledOnce();
});

it("does not replace the host estimate with invented zero usage", async () => {
  const run = await begin();
  run.finish();
  expect((await run.result).usage).toEqual({ inputTokens: null, outputTokens: null, reasoningTokens: null,
    cacheReadInputTokens: null, cacheWriteInputTokens: null });
  expect(run.callbacks.onContextUsage).not.toHaveBeenCalled();
});

it("closes visible reasoning on cancellation and ignores buffered late output", async () => {
  const run = await begin();
  run.event({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Partial summary" } });
  run.controller.abort();
  run.event({ type: "content_block_delta", delta: { type: "text_delta", text: "too late" } });
  run.finish();
  await expect(run.result).rejects.toMatchObject({ name: "AbortError" });
  expect(run.callbacks.onReasoningBlockEnd).toHaveBeenCalledOnce();
  expect(run.callbacks.onContentDelta).not.toHaveBeenCalled();
  expect(run.child.kill).toHaveBeenCalledOnce();
});

it("does not mark an error-only session failure as model activity", async () => {
  const run = await begin();
  run.finish({ is_error: true, result: "Session not found" });
  await expect(run.result).rejects.toThrow("Session not found");
  expect(run.callbacks.onActivity).not.toHaveBeenCalled();
});

it.each(["mid-turn", "next-turn"] as const)("delivers steering into the running invocation (%s)", async delivery => {
  const id = "0f8e2a4c-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
  const queued = [{ id, text: "Also add a heading." }];
  const run = await begin({ takeSteering: () => queued.splice(0) });
  const input: string[] = [];
  run.child.stdin.on("data", (chunk: Buffer) => input.push(...chunk.toString("utf8").trim().split("\n")));
  run.event({ type: "message_start", message: { model } });
  await vi.waitFor(() => expect(input.map(line => JSON.parse(line).uuid)).toEqual([undefined, id]));
  expect(JSON.parse(input[1]).message.content[0].text).toBe("Also add a heading.");
  const replay = () => run.send({ type: "user", isReplay: true, uuid: id, message: { role: "user", content: "Also add a heading." } });
  if (delivery === "mid-turn") replay();
  run.send({ type: "result", result: "First" });
  await new Promise(resolve => setImmediate(resolve));
  // A steer the CLI has not yet taken up runs as its next turn, so stdin must stay open for it.
  expect(run.child.stdin.writableEnded).toBe(delivery === "mid-turn");
  if (delivery === "next-turn") {
    replay();
    run.send({ type: "result", result: "Second" });
    await new Promise(resolve => setImmediate(resolve));
    expect(run.child.stdin.writableEnded).toBe(true);
  }
  run.child.emit("close", 0);
  await expect(run.result).resolves.toBeDefined();
});
