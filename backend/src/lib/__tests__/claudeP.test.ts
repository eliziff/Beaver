import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { streamClaudeP } from "../llm/claudeP";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

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
});
