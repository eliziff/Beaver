import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChatParams } from "../types";

const mocks = vi.hoisted(() => ({
  streamGemini: vi.fn(),
}));

vi.mock("../claude", () => ({
  streamClaude: vi.fn(),
  completeClaudeText: vi.fn(),
}));
vi.mock("../gemini", () => ({
  streamGemini: mocks.streamGemini,
  completeGeminiText: vi.fn(),
}));
vi.mock("../openai", () => ({
  streamOpenAI: vi.fn(),
  completeOpenAIText: vi.fn(),
}));
vi.mock("../deepseek", () => ({
  streamDeepSeek: vi.fn(),
  completeDeepSeekText: vi.fn(),
}));
vi.mock("../openrouter", () => ({
  streamOpenRouter: vi.fn(),
  completeOpenRouterText: vi.fn(),
}));
import {
  appendContextManifest,
  buildContextManifest,
} from "../contextManifest";
import { streamChatWithTools } from "../index";

const originalPath = process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH;
const tempDirs: string[] = [];

afterEach(async () => {
  mocks.streamGemini.mockReset();
  if (originalPath === undefined) {
    delete process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH;
  } else {
    process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH = originalPath;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function params(): StreamChatParams {
  return {
    model: "gemini-test",
    systemPrompt: "PRIVATE_SYSTEM_ALPHA",
    messages: [
      {
        role: "user",
        content: "PRIVATE_MESSAGE_BRAVO",
        images: [
          {
            filename: "PRIVATE_SCAN.png",
            mimeType: "image/png",
            data: "cHJpdmF0ZS1pbWFnZQ==",
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "PRIVATE_TOOL_CHARLIE",
          parameters: {
            required: ["query"],
            properties: { query: { type: "string" } },
            type: "object",
          },
        },
      },
    ],
    reasoningEffort: "high",
  };
}

describe("LLM context manifests", () => {
  it("stores only measurements and stable hashes", () => {
    const first = buildContextManifest({
      params: params(),
      provider: "gemini",
      startedAt: "2026-07-27T00:00:00.000Z",
      firstContentLatencyMs: 4,
      totalLatencyMs: 9,
      outputBytes: 2,
      status: "completed",
    });
    const reordered = params();
    reordered.tools![0].function.parameters = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const second = buildContextManifest({
      params: reordered,
      provider: "gemini",
      startedAt: "2026-07-27T00:00:00.000Z",
      firstContentLatencyMs: 4,
      totalLatencyMs: 9,
      outputBytes: 2,
      status: "completed",
    });

    const persisted = JSON.stringify(first);
    expect(persisted).not.toContain("PRIVATE_");
    expect(first.components).toMatchObject({
      system: { count: 1 },
      messages: { count: 1 },
      tools: { count: 1 },
      images: { count: 1, bytes: 13 },
    });
    expect(first.components.tools.sha256).toBe(second.components.tools.sha256);
    expect(first.inputEstimate.tokens).toBe(
      Math.ceil(first.inputEstimate.bytes / 4),
    );
    expect(first.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
    });
    expect(first.providerInvocationId).toBeNull();
    expect(first.schemaVersion).toBe(2);
    expect(first.rounds).toEqual([]);
    expect(first.compactions).toEqual([]);
    expect(first.promptCache).toEqual({ strategy: "none", keySha256: null });
    expect(first.serviceTierRequested).toBeNull();
    expect(first.serviceTierReported).toBeNull();
    expect(first.compaction).toEqual({
      strategy: "none",
      reason: null,
      checkpointId: null,
    });
    expect(first.continuation).toEqual({
      strategy: "none",
      id: null,
    });
  });

  it("writes one durable JSONL record around the provider dispatch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "beaver-context-manifest-"));
    tempDirs.push(dir);
    const filename = path.join(dir, "turns.jsonl");
    process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH = filename;
    mocks.streamGemini.mockImplementation(async (request: StreamChatParams) => {
      request.callbacks?.onContentDelta?.("ok");
      return { fullText: "ok" };
    });

    await streamChatWithTools(params());

    const lines = (await readFile(filename, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const manifest = JSON.parse(lines[0]);
    expect(manifest).toMatchObject({
      provider: "gemini",
      model: "gemini-test",
      reasoningEffort: "high",
      outputBytes: 2,
      status: "completed",
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
      },
    });
    expect(manifest.firstContentLatencyMs).toBeTypeOf("number");
    expect(JSON.stringify(manifest)).not.toContain("PRIVATE_");
  });

  it("records requested and provider-reported service tiers", () => {
    const request = { ...params(), serviceTier: "fast" };
    const manifest = buildContextManifest({
      params: request,
      provider: "codex",
      startedAt: "2026-08-01T00:00:00.000Z",
      firstContentLatencyMs: 1,
      totalLatencyMs: 2,
      outputBytes: 2,
      status: "completed",
      result: { fullText: "ok", serviceTier: "priority" },
    });
    expect(manifest.serviceTierRequested).toBe("fast");
    expect(manifest.serviceTierReported).toBe("priority");
  });

  it("records the initial schema inventory when disclosure expands it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "beaver-context-manifest-"));
    tempDirs.push(dir);
    const filename = path.join(dir, "turns.jsonl");
    process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH = filename;
    mocks.streamGemini.mockImplementation(async (request: StreamChatParams) => {
      request.tools!.push({
        type: "function",
        function: {
          name: "revealed_later",
          description: "deferred",
          parameters: { type: "object", properties: {} },
        },
      });
      return { fullText: "ok" };
    });

    await streamChatWithTools(params());

    const manifest = JSON.parse((await readFile(filename, "utf8")).trim());
    expect(manifest.components.tools.count).toBe(1);
  });

  it("records provider errors and preserves the original rejection", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "beaver-context-manifest-"));
    tempDirs.push(dir);
    const filename = path.join(dir, "turns.jsonl");
    process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH = filename;
    mocks.streamGemini.mockRejectedValue(new Error("provider failed"));

    await expect(streamChatWithTools(params())).rejects.toThrow(
      "provider failed",
    );

    const manifest = JSON.parse((await readFile(filename, "utf8")).trim());
    expect(manifest).toMatchObject({
      status: "error",
      outputBytes: 0,
      firstContentLatencyMs: null,
    });
  });

  it("serializes concurrent JSONL appends", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "beaver-context-manifest-"));
    tempDirs.push(dir);
    const filename = path.join(dir, "turns.jsonl");
    process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH = filename;
    const manifest = buildContextManifest({
      params: params(),
      provider: "gemini",
      startedAt: "2026-07-27T00:00:00.000Z",
      firstContentLatencyMs: null,
      totalLatencyMs: 1,
      outputBytes: 0,
      status: "completed",
    });

    await Promise.all(
      Array.from({ length: 8 }, () => appendContextManifest(manifest)),
    );

    const lines = (await readFile(filename, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(8);
    expect(lines.every((line) => JSON.parse(line).schemaVersion === 2)).toBe(
      true,
    );
  });
});
