import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamClaudeP } from "../llm/claudeP";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

const originalApiKey = process.env.ANTHROPIC_API_KEY;
const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {} },
});
const option = (args: string[], name: string) => args[args.indexOf(name) + 1];

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

describe("claude -p native MCP transport", () => {
  it("runs Beaver tools through one isolated native Claude process", async () => {
    const inputs: Buffer[] = [];
    let config: {
      mcpServers: {
        beaver: { url: string; headers: { Authorization: string } };
      };
    } | null = null;
    let systemPrompt = "";
    let childEnv: NodeJS.ProcessEnv = {};
    vi.mocked(spawn).mockImplementation((_file, rawArgs, rawOptions) => {
      const args = rawArgs as string[];
      const child = fakeChild();
      child.stdin.on("data", (chunk: Buffer) => inputs.push(chunk));
      systemPrompt = readFileSync(option(args, "--system-prompt-file"), "utf8");
      config = JSON.parse(
        readFileSync(option(args, "--mcp-config"), "utf8"),
      ) as typeof config;
      childEnv = (rawOptions as { env: NodeJS.ProcessEnv }).env;

      queueMicrotask(async () => {
        try {
          const transport = new StreamableHTTPClientTransport(
            new URL(config!.mcpServers.beaver.url),
            {
              requestInit: {
                headers: {
                  Authorization: `Bearer ${childEnv.BEAVER_CLAUDE_MCP_TOKEN}`,
                },
              },
            },
          );
          const client = new Client({ name: "claude-test", version: "1.0.0" });
          await client.connect(transport);
          await client.callTool({
            name: "a2aj_search",
            arguments: { query: "Vavilov" },
          });
          await transport.close();

          for (const event of [
            {
              type: "system",
              subtype: "init",
              mcp_servers: [{ name: "beaver", status: "connected" }],
            },
            {
              type: "system",
              subtype: "compact_boundary",
              compactMetadata: {
                trigger: "auto",
                preTokens: 123,
                durationMs: 4,
              },
            },
            {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "Found it." },
              },
            },
            {
              type: "stream_event",
              event: { type: "content_block_stop" },
            },
            {
              type: "result",
              subtype: "success",
              result: "Found it.",
              usage: {
                input_tokens: 7,
                output_tokens: 2,
                cache_read_input_tokens: 3,
              },
            },
          ]) {
            child.stdout.write(`${JSON.stringify(event)}\n`);
          }
          child.stdout.end();
          queueMicrotask(() => child.emit("close", 0));
        } catch (error) {
          child.emit("error", error);
        }
      });
      return child as never;
    });

    const runTools = vi.fn(async (calls) =>
      calls.map((call) => ({
        tool_use_id: call.id,
        content: "search result",
      })),
    );
    const onContentDelta = vi.fn();
    const onCompaction = vi.fn();
    const result = await streamClaudeP({
      model: "claude-p:claude-sonnet-4-6",
      systemPrompt: "Beaver system",
      messages: [{ role: "user", content: "Research this" }],
      tools: [tool("a2aj_search")],
      runTools,
      maxIterations: 5,
      callbacks: { onContentDelta, onCompaction },
    });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(option(args, "--input-format")).toBe("stream-json");
    expect(option(args, "--output-format")).toBe("stream-json");
    expect(option(args, "--tools")).toBe("");
    expect(option(args, "--allowedTools")).toBe("mcp__beaver");
    expect(option(args, "--max-turns")).toBe("5");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(systemPrompt).toBe("Beaver system");
    expect(config!.mcpServers.beaver.headers.Authorization).toBe(
      "Bearer ${BEAVER_CLAUDE_MCP_TOKEN}",
    );
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.BEAVER_CLAUDE_MCP_TOKEN).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(Buffer.concat(inputs).toString("utf8"))).toMatchObject({
      type: "user",
      message: { content: [{ text: "Research this" }] },
    });
    expect(runTools).toHaveBeenCalledTimes(1);
    expect(runTools.mock.calls[0][0][0]).toMatchObject({
      name: "a2aj_search",
      input: { query: "Vavilov" },
    });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(onContentDelta).toHaveBeenCalledWith("Found it.");
    expect(onCompaction).toHaveBeenCalledWith("completed");
    expect(result).toMatchObject({
      fullText: "Found it.",
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        cacheReadInputTokens: 3,
      },
      contextRounds: [{ toolCallCount: 1, toolResultBytes: 13 }],
      compactions: [{ triggerInputTokens: 123, latencyMs: 4 }],
    });
  });

  it("uses Claude's native continuation without persisting ordinary calls", async () => {
    const sessionId = "12345678-1234-4234-8234-123456789abc";
    vi.mocked(spawn).mockImplementation((_file, rawArgs) => {
      const args = rawArgs as string[];
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end(
          `${JSON.stringify({
            type: "result",
            subtype: "success",
            result: "continued",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          })}\n`,
        );
        queueMicrotask(() => child.emit("close", 0));
      });
      expect(option(args, "--resume")).toBe(sessionId);
      expect(args).not.toContain("--no-session-persistence");
      return child as never;
    });
    const onContinuationId = vi.fn();

    const result = await streamClaudeP({
      model: "claude-p:claude-sonnet-4-6",
      systemPrompt: "system",
      messages: [{ role: "user", content: "continue" }],
      providerSession: {
        persist: true,
        continuationId: sessionId,
        onContinuationId,
      },
    });

    expect(result.continuationId).toBe(sessionId);
    expect(onContinuationId).toHaveBeenCalledWith(sessionId);
  });

  it("fails closed when Claude skips the configured MCP server", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end(
          `${JSON.stringify({
            type: "system",
            subtype: "init",
            mcp_servers: [],
            mcp_server_errors: [{ name: "beaver", message: "invalid config" }],
          })}\n${JSON.stringify({
            type: "result",
            subtype: "success",
            result: "unguarded answer",
            usage: {},
          })}\n`,
        );
        queueMicrotask(() => child.emit("close", 0));
      });
      return child as never;
    });

    await expect(
      streamClaudeP({
        model: "claude-p:claude-sonnet-4-6",
        systemPrompt: "system",
        messages: [{ role: "user", content: "research" }],
        tools: [tool("a2aj_search")],
        runTools: vi.fn(),
      }),
    ).rejects.toThrow(/did not load.*invalid config/u);
  });
});
