import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { streamCodex } from "../codex";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(lines: string[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit("close", null, "SIGTERM"));
    return true;
  });

  const stdinEnd = child.stdin.end.bind(child.stdin);
  child.stdin.end = ((chunk?: string | Uint8Array) => {
    stdinEnd(chunk);
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${line}\n`);
      child.stdout.end();
      setImmediate(() => child.emit("close", 0, null));
    });
    return child.stdin;
  }) as typeof child.stdin.end;
  return child;
}

afterEach(() => {
  spawnMock.mockReset();
  delete process.env.CODEX_EXEC_COMMAND;
});

describe("streamCodex", () => {
  it("normalizes safe reasoning and final content events", async () => {
    spawnMock.mockReturnValue(
      fakeChild([
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.updated",
          item: {
            type: "reasoning",
            id: "reasoning-1",
            text: "Checking",
          },
        }),
        JSON.stringify({
          type: "item.updated",
          item: {
            type: "reasoning",
            id: "reasoning-1",
            text: "Checking sources.",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "reasoning",
            id: "reasoning-1",
            text: "Checking sources.",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Final answer." },
        }),
        JSON.stringify({ type: "turn.completed" }),
      ]),
    );

    const trace: string[] = [];
    const result = await streamCodex({
      model: "codex-exec",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "Check this." }],
      enableThinking: true,
      reasoningEffort: "ultra",
      callbacks: {
        onReasoningDelta: (text) => trace.push(`reasoning:${text}`),
        onReasoningBlockEnd: () => trace.push("reasoning:end"),
        onContentDelta: (text) => trace.push(`content:${text}`),
      },
    });

    expect(result.fullText).toBe("Final answer.");
    expect(trace).toEqual([
      "reasoning:Checking",
      "reasoning: sources.",
      "reasoning:end",
      "content:Final answer.",
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--json",
        'model_reasoning_effort="ultra"',
        'model_reasoning_summary="auto"',
        "show_raw_agent_reasoning=false",
      ]),
    );
  });

  it("suppresses reasoning when thinking is disabled", async () => {
    spawnMock.mockReturnValue(
      fakeChild([
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "reasoning",
            summary: "Do not show this.",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Answer." },
        }),
      ]),
    );

    const reasoning: string[] = [];
    const result = await streamCodex({
      model: "codex-exec",
      systemPrompt: "",
      messages: [{ role: "user", content: "Answer." }],
      enableThinking: false,
      callbacks: { onReasoningDelta: (text) => reasoning.push(text) },
    });

    expect(result.fullText).toBe("Answer.");
    expect(reasoning).toEqual([]);
  });

  it("configures an isolated MCP bridge when tools are present", async () => {
    spawnMock.mockReturnValue(
      fakeChild([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "No call needed." },
        }),
      ]),
    );

    await streamCodex({
      model: "codex-exec",
      systemPrompt: "",
      messages: [{ role: "user", content: "Respond." }],
      tools: [
        {
          type: "function",
          function: {
            name: "ping_tool",
            description: "Ping.",
            parameters: { type: "object" },
          },
        },
      ],
      runTools: async () => [],
    });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "--ignore-user-config",
        "mcp_servers.mike_runtime.required=true",
        'mcp_servers.mike_runtime.bearer_token_env_var="MIKE_CODEX_BRIDGE_TOKEN"',
      ]),
    );
    expect(
      args.some((arg) => arg.startsWith("mcp_servers.mike_runtime.url=")),
    ).toBe(true);
  });

  it("passes images to Codex through its native image argument", async () => {
    let imagePath = "";
    spawnMock.mockImplementation((_command, args: string[]) => {
      const imageIndex = args.indexOf("-i");
      imagePath = args[imageIndex + 1];
      expect(imageIndex).toBeGreaterThan(0);
      expect(readFileSync(imagePath).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      return fakeChild([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "I see it." },
        }),
      ]);
    });

    await streamCodex({
      model: "codex-exec",
      systemPrompt: "",
      messages: [{
        role: "user",
        content: "What is shown?",
        images: [{
          filename: "scan.png",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
        }],
      }],
    });

    expect(imagePath).toContain("mike-codex-images-");
    expect(existsSync(imagePath)).toBe(false);
  });

  it("does not spawn Codex when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      streamCodex({
        model: "codex-exec",
        systemPrompt: "",
        messages: [{ role: "user", content: "Do not run." }],
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
