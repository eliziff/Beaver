import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const streamCodexMock = vi.hoisted(() =>
  vi.fn(async () => ({ fullText: "exec fallback" })),
);

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../codex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../codex")>()),
  streamCodex: streamCodexMock,
}));

import { streamCodexAppServer } from "../codexAppServer";

function fakeChild(onSpawn?: (child: EventEmitter) => void) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
    pid?: number;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setImmediate(() => onSpawn?.(child));
  return child;
}

const params = {
  model: "codex:gpt-5.3-codex-spark",
  systemPrompt: "",
  messages: [{ role: "user" as const, content: "hi" }],
};

afterEach(() => {
  delete process.env.BEAVER_CODEX_EXEC;
  delete process.env.BEAVER_CODEX_HOME;
  spawnMock.mockReset();
  streamCodexMock.mockClear();
});

describe("codex app-server adapter", () => {
  it("uses the exec path when the kill switch is set", async () => {
    process.env.BEAVER_CODEX_EXEC = "1";
    spawnMock.mockImplementation(() => fakeChild());

    await expect(streamCodexAppServer(params)).resolves.toEqual({
      fullText: "exec fallback",
    });
    expect(streamCodexMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("falls back to the exec path when the app-server cannot start", async () => {
    // Keep the isolated-home bootstrap out of the developer's real data dir.
    process.env.BEAVER_CODEX_HOME = path.join(
      os.tmpdir(),
      "beaver-codex-home-test",
    );
    spawnMock.mockImplementation(() =>
      fakeChild((child) => child.emit("error", new Error("spawn ENOENT"))),
    );

    await expect(streamCodexAppServer(params)).resolves.toEqual({
      fullText: "exec fallback",
    });
    expect(spawnMock).toHaveBeenCalled();
    expect(streamCodexMock).toHaveBeenCalledOnce();
  });
});
