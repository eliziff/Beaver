import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cachedContent } from "../contentCache";

const entry = <T>(value: T) => ({
  scope: randomUUID(), kind: "test-kind", key: "k", version: 1,
  produce: vi.fn(async () => value),
});

describe("cachedContent", () => {
  it("produces once and serves an isolated snapshot from cache", async () => {
    const base = entry({ answer: 42 });
    const first = await cachedContent(base);
    expect(first).toEqual({ answer: 42 });
    first.answer = 99;
    expect(await cachedContent(base)).toEqual({ answer: 42 });
    expect(base.produce).toHaveBeenCalledTimes(1);
  });

  it("misses on version bump and on expired ttl", async () => {
    const base = entry("v");
    await cachedContent(base);
    await cachedContent({ ...base, version: 2 });
    expect(base.produce).toHaveBeenCalledTimes(2);
    await cachedContent({ ...base, version: 3, ttlMs: -1 });
    await cachedContent({ ...base, version: 3, ttlMs: -1 });
    expect(base.produce).toHaveBeenCalledTimes(4);
  });

  it("propagates producer failures without caching them", async () => {
    const failing = entry("unused");
    failing.produce.mockRejectedValue(new Error("upstream down"));
    await expect(cachedContent(failing)).rejects.toThrow("upstream down");
    await expect(cachedContent(failing)).rejects.toThrow("upstream down");
    expect(failing.produce).toHaveBeenCalledTimes(2);
  });

  it("keeps the LRU byte budget intact when oversized responses bypass the cache", async () => {
    // Each retained JSON string is exactly 2 MB; sixteen fill the 32 MB budget.
    const base = entry("x".repeat(1_999_998)), oversized = entry("x".repeat(2_000_001));
    for (let key = 0; key < 16; key++) await cachedContent({ ...base, key: String(key) });
    await cachedContent({ ...base, key: "0" });
    await cachedContent(oversized);
    await cachedContent(oversized);
    expect(oversized.produce).toHaveBeenCalledTimes(2);
    await cachedContent({ ...base, key: "16" });
    await cachedContent({ ...base, key: "0" });
    expect(base.produce).toHaveBeenCalledTimes(17);
    await cachedContent({ ...base, key: "1" });
    expect(base.produce).toHaveBeenCalledTimes(18);
  });
});
