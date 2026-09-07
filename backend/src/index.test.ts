import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listener = {
    maxHeadersCount: 0, headersTimeout: 0, requestTimeout: 0,
    keepAliveTimeout: 0, maxRequestsPerSocket: 0,
    close: vi.fn((done: (error?: Error) => void) => done()),
    closeAllConnections: vi.fn(),
  };
  return {
    assertFrontendBuild: vi.fn(), releaseLock: vi.fn(), listener,
    server: { listen: vi.fn((_port: number, _host: string, ready: () => void) => {
      ready(); return listener;
    }) },
    workers: { stop: vi.fn().mockResolvedValue(undefined) },
    runtime: { mode: "local", initialize: vi.fn().mockResolvedValue(undefined),
      startWorkers: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("./server", () => ({ server: mocks.server,
  assertFrontendBuild: mocks.assertFrontendBuild }));
vi.mock("./runtime", () => ({ runtime: mocks.runtime }));
vi.mock("./lib/localRuntimeLock", () => ({
  acquireLocalRuntimeLock: () => mocks.releaseLock,
}));
vi.mock("./lib/safeError", () => ({ safeErrorLog: String }));

describe("backend process ownership", () => {
  const handlers = new Map<string, () => void>();
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); handlers.clear();
    exitCode = process.exitCode;
    mocks.runtime.startWorkers.mockResolvedValue(mocks.workers);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "once").mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler); return process;
    }) as typeof process.once);
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });

  it("owns runtime workers in development and stops them before shutdown", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await import("./index");
    await vi.waitFor(() => expect(mocks.runtime.startWorkers).toHaveBeenCalledOnce());

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(mocks.runtime.shutdown).toHaveBeenCalledOnce());
    expect(mocks.workers.stop).toHaveBeenCalledOnce();
  });

  it("leaves production workers to the supervisor", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await import("./index");
    await vi.waitFor(() => expect(mocks.runtime.initialize).toHaveBeenCalledOnce());

    expect(mocks.assertFrontendBuild).toHaveBeenCalledOnce();
    expect(mocks.runtime.startWorkers).not.toHaveBeenCalled();
  });
});
