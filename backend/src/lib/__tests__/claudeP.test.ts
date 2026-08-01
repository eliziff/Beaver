import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamClaudeP } from "../llm/claudeP";
import type { OpenAIToolSchema } from "../llm/types";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const tool = (name: string): OpenAIToolSchema => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MIKE_CLAUDE_P_PERSIST;
});

afterEach(() => {
  delete process.env.MIKE_CLAUDE_P_PERSIST;
});

describe("claude -p transport", () => {
  it("gives Claude only Beaver's transport protocol and tools", async () => {
    const replies = [
      `TOOL_CALLS\n${JSON.stringify({
        calls: [
          {
            id: "toolu_1",
            name: "a2aj_search",
            input: { query: "Vavilov" },
          },
        ],
      })}`,
      'FINAL\nA "quoted" answer',
    ];
    const inputs: Buffer[][] = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const input: Buffer[] = [];
      inputs.push(input);
      child.stdin.on("data", (chunk: Buffer) => input.push(chunk));
      const reply = replies.shift();
      queueMicrotask(() => {
        child.stdout.end(
          `${JSON.stringify({
            type: "result",
            result: reply,
            usage: { input_tokens: 7, output_tokens: 1 },
          })}\n`,
        );
        child.emit("close", 0);
      });
      return child as never;
    });

    const runTools = vi.fn().mockResolvedValue([
      { tool_use_id: "toolu_1", content: "search result" },
    ]);
    const result = await streamClaudeP({
      model: "claude-p:claude-sonnet-4-6",
      systemPrompt: "Beaver system",
      messages: [{ role: "user", content: "Research this" }],
      tools: [
        {
          type: "function",
          function: {
            name: "a2aj_search",
            description: "Search Canadian law",
            parameters: { type: "object" },
          },
        },
      ],
      runTools,
    });

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toEqual([
      "-p",
      "--model",
      "claude-sonnet-4-6",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--include-partial-messages",
      "--system-prompt",
      expect.any(String),
    ]);
    const payload = JSON.parse(Buffer.concat(inputs[0]).toString("utf8"));
    expect(payload).toMatchObject({
      system: "Beaver system",
      tools: [{ name: "a2aj_search" }],
    });
    expect(runTools).toHaveBeenCalledWith([
      {
        id: "toolu_1",
        name: "a2aj_search",
        input: { query: "Vavilov" },
      },
    ]);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(result.fullText).toBe('A "quoted" answer');
  });

  it("restarts a persistent session and replays context when tools change", async () => {
    process.env.MIKE_CLAUDE_P_PERSIST = "1";
    const inputs: Buffer[][] = [];
    const children: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const input: Buffer[] = [];
      const session = inputs.length;
      inputs.push(input);
      children.push(child);
      child.stdin.on("data", (chunk: Buffer) => {
        input.push(chunk);
        const reply = session === 0
          ? `TOOL_CALLS\n${JSON.stringify({
              calls: [{ id: "toolu_1", name: "discover", input: {} }],
            })}`
          : "FINAL\ndone";
        queueMicrotask(() => {
          child.stdout.write(
            `${JSON.stringify({
              type: "result",
              result: reply,
              usage: { input_tokens: 1, output_tokens: 1 },
            })}\n`,
          );
        });
      });
      return child as never;
    });
    let activeTools = [tool("discover")];

    const result = await streamClaudeP({
      model: "claude-p:claude-sonnet-4-6",
      systemPrompt: "system",
      messages: [{ role: "user", content: "research" }],
      tools: activeTools,
      resolveTools: () => activeTools,
      runTools: async () => {
        activeTools = [...activeTools, tool("revealed")];
        return [{ tool_use_id: "toolu_1", content: "opened" }];
      },
    });

    expect(result.fullText).toBe("done");
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(children[0].kill).toHaveBeenCalled();
    const firstPayload = JSON.parse(
      JSON.parse(Buffer.concat(inputs[0]).toString("utf8")).message.content[0]
        .text,
    );
    const secondPayload = JSON.parse(
      JSON.parse(Buffer.concat(inputs[1]).toString("utf8")).message.content[0]
        .text,
    );
    expect(firstPayload.tools.map((entry: { name: string }) => entry.name))
      .toEqual(["discover"]);
    expect(secondPayload.tools.map((entry: { name: string }) => entry.name))
      .toEqual(["discover", "revealed"]);
    expect(secondPayload.messages).toHaveLength(3);
    expect(secondPayload.messages[2]).toMatchObject({
      role: "user",
      content: [{ tool_use_id: "toolu_1", content: "opened" }],
    });
  });
});
