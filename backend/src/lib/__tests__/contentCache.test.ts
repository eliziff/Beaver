import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cachedContent, clearContentCache } from "../contentCache";

let home: string | null = null;
const originalHome = process.env.OPEN_LEGAL_DATA_HOME;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "beaver-content-cache-"));
  process.env.OPEN_LEGAL_DATA_HOME = home;
  process.env.MIKE_CONTENT_CACHE_IN_TESTS = "1";
});

afterEach(async () => {
  delete process.env.MIKE_CONTENT_CACHE_IN_TESTS;
  if (originalHome === undefined) delete process.env.OPEN_LEGAL_DATA_HOME;
  else process.env.OPEN_LEGAL_DATA_HOME = originalHome;
  if (home) {
    await rm(home, { recursive: true, force: true });
    home = null;
  }
});

const producer = (value: unknown) => {
  let calls = 0;
  return {
    calls: () => calls,
    produce: async () => {
      calls += 1;
      return value;
    },
  };
};

describe("cachedContent", () => {
  it("produces once and serves the second call from cache", async () => {
    const p = producer({ answer: 42 });
    const base = {
      scope: "shared",
      kind: "test-kind",
      key: "https://example.org/a",
      version: 1,
      produce: p.produce,
    };
    expect(await cachedContent(base)).toEqual({ answer: 42 });
    expect(await cachedContent(base)).toEqual({ answer: 42 });
    expect(p.calls()).toBe(1);
  });

  it("misses on version bump and on expired ttl", async () => {
    const p = producer("v");
    const base = {
      scope: "shared",
      kind: "test-kind",
      key: "k",
      produce: p.produce,
    };
    await cachedContent({ ...base, version: 1 });
    await cachedContent({ ...base, version: 2 });
    expect(p.calls()).toBe(2);
    await cachedContent({ ...base, version: 3, ttlMs: -1 });
    await cachedContent({ ...base, version: 3, ttlMs: -1 });
    expect(p.calls()).toBe(4);
  });

  it("propagates producer failures without caching them", async () => {
    let calls = 0;
    const failing = {
      scope: "shared",
      kind: "test-kind",
      key: "fails",
      version: 1,
      produce: async () => {
        calls += 1;
        throw new Error("upstream down");
      },
    };
    await expect(cachedContent(failing)).rejects.toThrow("upstream down");
    await expect(cachedContent(failing)).rejects.toThrow("upstream down");
    expect(calls).toBe(2);
  });

  it("stands aside in test env unless opted in", async () => {
    delete process.env.MIKE_CONTENT_CACHE_IN_TESTS;
    const p = producer(1);
    const base = {
      scope: "shared",
      kind: "test-kind",
      key: "gated",
      version: 1,
      produce: p.produce,
    };
    await cachedContent(base);
    await cachedContent(base);
    expect(p.calls()).toBe(2);
  });

  it("clears by kind", async () => {
    const p = producer("x");
    const base = {
      scope: "shared",
      kind: "clear-kind",
      key: "k",
      version: 1,
      produce: p.produce,
    };
    await cachedContent(base);
    await clearContentCache("clear-kind");
    await cachedContent(base);
    expect(p.calls()).toBe(2);
  });
});
