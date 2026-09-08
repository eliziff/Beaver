import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogCache } from "../catalogCache";

type Catalog = { source: "live" | "unavailable"; models: string[] };
const live: Catalog = { source: "live", models: ["gpt"] };
const empty: Catalog = { source: "unavailable", models: [] };
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe("provider catalog cache", () => {
  it("answers snapshots without awaiting the provider", async () => {
    let release = (_: Catalog) => undefined as void;
    const cache = createCatalogCache<Catalog>(
      () => new Promise((resolve) => { release = resolve; }), empty,
    );

    expect(cache.snapshot()).toEqual(empty);
    release(live);
    await vi.waitFor(() => expect(cache.snapshot()).toEqual(live));
  });

  it("keeps the last known catalog when a probe fails and waits out the interval", async () => {
    const probe = vi.fn<() => Promise<Catalog>>()
      .mockResolvedValueOnce(live)
      .mockRejectedValue(new Error("usage limit"));
    const cache = createCatalogCache(probe, empty);

    expect(await cache.resolve()).toEqual(live);
    expect(cache.snapshot()).toEqual(live);

    now += 600_000;
    expect(await cache.resolve()).toEqual({ ...live, source: "unavailable" });
    expect(cache.snapshot()).toEqual({ ...live, source: "unavailable" });
    expect(cache.snapshot()).toEqual({ ...live, source: "unavailable" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("serves the empty catalog while a provider has never answered", async () => {
    const probe = vi.fn<() => Promise<Catalog>>().mockRejectedValue(new Error("offline"));
    const cache = createCatalogCache(probe, empty);

    expect(cache.snapshot()).toEqual(empty);
    expect(await cache.resolve()).toEqual(empty);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
