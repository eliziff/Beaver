import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const streamGemini = vi.hoisted(() => vi.fn());
vi.mock("../gemini", () => ({ streamGemini }));

import { streamChatWithTools } from "../index";

const originalPath = process.env.MIKE_LLM_METRICS_PATH;
let directory: string | undefined;

afterEach(async () => {
  streamGemini.mockReset();
  if (originalPath === undefined) delete process.env.MIKE_LLM_METRICS_PATH;
  else process.env.MIKE_LLM_METRICS_PATH = originalPath;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("writes only opt-in numeric LLM metrics", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-llm-metrics-"));
  const filename = path.join(directory, "metrics.jsonl");
  process.env.MIKE_LLM_METRICS_PATH = filename;
  streamGemini.mockResolvedValue({
    fullText: "PRIVATE_RESPONSE",
    continuationId: "PRIVATE_CONTINUATION",
    usage: { inputTokens: 2, outputTokens: 1 },
    contextRounds: [{
      iteration: 0, requestAttempts: 1, instructionsBytes: 11,
      inputItems: 1, inputBytes: 12, toolCount: 0, toolBytes: 2,
      toolCallCount: 0, toolArgumentBytes: 0, toolResultBytes: 0,
      usage: { inputTokens: 2, outputTokens: 1 },
    }],
  });

  await streamChatWithTools({
    model: "gemini-3-flash-preview",
    systemPrompt: "PRIVATE_SYSTEM",
    messages: [{ role: "user", content: "PRIVATE_MESSAGE" }],
  });

  const persisted = await readFile(filename, "utf8");
  expect(JSON.parse(persisted)).toMatchObject({
    usage: { inputTokens: 2, outputTokens: 1 },
    rounds: [{ inputBytes: 12, toolBytes: 2 }],
  });
  expect(persisted).not.toContain("PRIVATE_");
});
