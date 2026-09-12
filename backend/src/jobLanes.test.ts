import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("job lanes", () => {
  const previous = { auth: process.env.AUTH_MODE, size: process.env.UV_THREADPOOL_SIZE };
  beforeEach(() => { process.env.AUTH_MODE = "local"; delete process.env.UV_THREADPOOL_SIZE; });
  afterEach(() => {
    process.env.AUTH_MODE = previous.auth;
    if (previous.size === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = previous.size;
  });

  it("reserves a pool thread for every job slot that can hold one", async () => {
    const { jobLaneConcurrency, sizeNativeThreadPool } = await import("./jobLanes");
    const lanes = jobLaneConcurrency();
    sizeNativeThreadPool();
    expect(Number(process.env.UV_THREADPOOL_SIZE))
      .toBe(lanes.chatTurns + lanes.preparation + lanes.tabular + 4);
    expect(Number(process.env.UV_THREADPOOL_SIZE)).toBeGreaterThan(4);
  });

  it("uses the same resource limits regardless of authentication mode", async () => {
    const { jobLaneConcurrency } = await import("./jobLanes");
    process.env.AUTH_MODE = "local";
    const local = jobLaneConcurrency();
    process.env.AUTH_MODE = "cloud";
    expect(jobLaneConcurrency()).toEqual(local);
    delete process.env.AUTH_MODE;
    expect(jobLaneConcurrency()).toEqual(local);
    expect(local.preparation).toBeGreaterThanOrEqual(1);
    expect(local.preparation).toBeLessThanOrEqual(4);
  });

  it("keeps an operator's own pool size", async () => {
    process.env.UV_THREADPOOL_SIZE = "32";
    const { sizeNativeThreadPool } = await import("./jobLanes");
    sizeNativeThreadPool();
    expect(process.env.UV_THREADPOOL_SIZE).toBe("32");
  });
});
