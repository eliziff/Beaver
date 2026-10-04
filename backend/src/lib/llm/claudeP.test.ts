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
  // The CLI starts after the tool bridge and prompt files are ready; wait for that, not a poll deadline.
  const spawned = new Promise<void>(resolve => spawn.mockImplementation(() => { resolve(); return child; }));
  const callbacks = { onContextUsage: vi.fn(), onContentDelta: vi.fn(), onContentBlockEnd: vi.fn(),
    onReasoningDelta: vi.fn(), onReasoningBlockEnd: vi.fn(), onToolCallStart: vi.fn(), onActivity: vi.fn() };
  const result = streamClaudeP({ model: `claude-p:${model}`, systemPrompt: "Synthetic transport check",
    messages: [{ role: "user", content: "Inspect the fixture." }], abortSignal: controller.signal,
    callbacks, ...options });
  void result.catch(() => undefined);
  runs.push({ controller, result });
  await spawned;
  expect(spawn).toHaveBeenCalledOnce();
  const send = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const event = (value: object, parent_tool_use_id: string | null = null) =>
    send({ type: "stream_event", event: value, parent_tool_use_id });
  const finish = (value: object = {}) => { send({ type: "result", result: "Done", ...value }); child.emit("close", 0); };
  return { child, callbacks, send, event, finish, result, controller };
}

it("activates both reported specialists in the same native invocation with one activity per dispatch", async () => {
  const executed: string[] = [], names = ["word_python", "edit_docx_advanced"];
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
