import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { cachedContent } from "../contentCache";

let scope = "";

beforeEach(() => { scope = randomUUID(); });

const producer = <T>(value: T) => {
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
      scope,
      kind: "test-kind",
      key: "https://example.org/a",
      version: 1,
      produce: p.produce,
    };
    const first = await cachedContent(base);
    expect(first).toEqual({ answer: 42 });
    first.answer = 99;
    expect(await cachedContent(base)).toEqual({ answer: 42 });
    expect(p.calls()).toBe(1);
  });

  it("misses on version bump and on expired ttl", async () => {
    const p = producer("v");
    const base = {
      scope,
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
      scope,
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

});
