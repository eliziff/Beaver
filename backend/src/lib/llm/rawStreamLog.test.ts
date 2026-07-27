import { mkdtemp, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, expect, it, vi } from "vitest";
import { createLlmTrace } from "./rawStreamLog";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("captures records to a file and echoes to console when both toggles are on", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "llm-trace-"));
  vi.stubEnv("RAW_LLM_STREAM_LOG_DIR", dir);
  vi.stubEnv("LOG_RAW_LLM_STREAM", "true");
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleDir = vi.spyOn(console, "dir").mockImplementation(() => {});

  const trace = createLlmTrace({ provider: "smoke", model: "test-model" });
  trace.record({ iteration: 0, label: "event", payload: { a: 1 } });
  trace.record({ iteration: 1, label: "event", payload: "text" });
  await trace.flush("completed");

  const dirPayloads = consoleDir.mock.calls.map((c) => c[0]);
  consoleLog.mockRestore();
  consoleDir.mockRestore();
  expect(dirPayloads).toEqual([{ a: 1 }, "text"]);

  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  const parsed = JSON.parse(await readFile(path.join(dir, files[0]), "utf8"));
  expect(parsed.provider).toBe("smoke");
  expect(parsed.status).toBe("completed");
  expect(parsed.entries.map((e: { payload: unknown }) => e.payload)).toEqual([
    { a: 1 },
    "text",
  ]);
});

it("is inert when both toggles are off", async () => {
  vi.stubEnv("RAW_LLM_STREAM_LOG_DIR", "");
  vi.stubEnv("LOG_RAW_LLM_STREAM", "");
  const consoleDir = vi.spyOn(console, "dir").mockImplementation(() => {});
  const trace = createLlmTrace({ provider: "smoke", model: "test-model" });
  trace.record({ iteration: 0, label: "event", payload: { a: 1 } });
  await trace.flush("error", new Error("boom"));
  consoleDir.mockRestore();
  expect(consoleDir).not.toHaveBeenCalled();
});
