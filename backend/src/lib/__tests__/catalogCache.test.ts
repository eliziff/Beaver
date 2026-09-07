import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogCache } from "../catalogCache";

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe("provider catalog cache", () => {
  it("answers snapshots without awaiting the provider", async () => {
    let release = (_: string[]) => undefined as void;
    const cache = createCatalogCache<string[]>(
      () => new Promise((resolve) => { release = resolve; }), [],
    );

    expect(cache.snapshot()).toEqual([]);
    release(["gpt"]);
    await vi.waitFor(() => expect(cache.snapshot()).toEqual(["gpt"]));
  });

  it("keeps the last known catalog when a probe fails and waits out the interval", async () => {
    const probe = vi.fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["gpt"])
      .mockRejectedValue(new Error("usage limit"));
    const cache = createCatalogCache(probe, [] as string[]);

    expect(await cache.resolve()).toEqual(["gpt"]);
    expect(cache.snapshot()).toEqual(["gpt"]);

    now += 600_000;
    expect(await cache.resolve()).toEqual(["gpt"]);
    expect(cache.snapshot()).toEqual(["gpt"]);
    expect(cache.snapshot()).toEqual(["gpt"]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("serves the empty catalog while a provider has never answered", async () => {
    const probe = vi.fn<() => Promise<string[]>>().mockRejectedValue(new Error("offline"));
    const cache = createCatalogCache(probe, ["static"]);

    expect(cache.snapshot()).toEqual(["static"]);
    expect(await cache.resolve()).toEqual(["static"]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
