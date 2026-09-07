import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CollectionCache } from "@/app/lib/collections";
import { CollectionContext } from "@/app/contexts/CollectionContext";
import { useNavigationPrefetch } from "./useNavigationPrefetch";
import type { ReactNode } from "react";
const mocks = vi.hoisted(() => ({ projects: vi.fn(), directory: vi.fn(), route: vi.fn() }));
vi.mock("@/app/lib/api/projects", () => ({ listProjects: mocks.projects }));
vi.mock("@/app/lib/api/documents", () => ({ directoryResource: () => ({ list: mocks.directory }) }));
vi.mock("@/app/router", () => ({ preloadAppRoute: mocks.route }));
const spec = { key: "/projects", tags: ["projects"] };
const page = (item = "kept") => ({ items: [item], next_cursor: null });
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it("hands a completed intent read to one navigation without an immediate duplicate request", async () => {
    const cache = new CollectionCache(), load = vi.fn(async () => page());
    await cache.prefetch(spec, load);
    const entry = cache.get<string>(spec);
    expect(entry.snapshot().query.items).toEqual(["kept"]);
    const off = entry.connect(load, "query");
    expect(load).toHaveBeenCalledTimes(1);
    off(); const next = entry.connect(load, "query");
    expect(load).toHaveBeenCalledTimes(2); // A return visit still revalidates.
    next(); cache.clear();
});

it("joins an in-flight intent read and rejects late results after a mutation", async () => {
    const cache = new CollectionCache(), pending = deferred<ReturnType<typeof page>>();
    let firstSignal: AbortSignal | undefined;
    const load = vi.fn((_key: string, _cursor: string | null, signal: AbortSignal) => {
        firstSignal ??= signal;
        return pending.promise;
    });
    const prefetch = cache.prefetch(spec, load), entry = cache.get<string>(spec);
    const current = vi.fn(async () => page("changed"));
    const off = entry.connect(current, "query");
    expect(current).not.toHaveBeenCalled();
    cache.invalidate(["projects"]); await Promise.resolve(); await Promise.resolve();
    expect(firstSignal?.aborted).toBe(true);
    pending.resolve(page("obsolete")); await prefetch;
    expect(entry.snapshot().query.items).toEqual(["changed"]);
    off(); cache.clear();
});

it("invalidates a completed speculative read and expires its one-second handoff", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const cache = new CollectionCache(), load = vi.fn(async () => page());
    await cache.prefetch(spec, load); now.mockReturnValue(2_001);
    const entry = cache.get<string>(spec), off = entry.connect(load, "query");
    expect(load).toHaveBeenCalledTimes(2); off();
    cache.invalidate(["projects"]);
    expect(entry.snapshot()).toEqual({});
    await cache.prefetch(spec, load);
    const reconnect = entry.connect(load, "query");
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);
    reconnect(); cache.clear();
});

it("caps speculative reads at two and never queues hover work behind them", async () => {
    const cache = new CollectionCache(), held = deferred<ReturnType<typeof page>>();
    const load = vi.fn(() => held.promise);
    const a = cache.prefetch({ ...spec, key: "/a" }, load);
    const b = cache.prefetch({ ...spec, key: "/b" }, load);
    await cache.prefetch({ ...spec, key: "/c" }, load);
    expect(load).toHaveBeenCalledTimes(2);
    held.resolve(page()); await Promise.all([a, b]);
    expect(load).toHaveBeenCalledTimes(2);
    cache.clear();
});

it("discarded account sessions cannot be repopulated by speculative responses", async () => {
    const old = new CollectionCache(), held = deferred<ReturnType<typeof page>>();
    const pending = old.prefetch(spec, () => held.promise), entry = old.get(spec);
    old.clear(); held.resolve(page("old account")); await pending;
    expect(entry.snapshot()).toEqual({});
    const next = new CollectionCache();
    await next.prefetch(spec, async () => page("new account"));
    expect(next.get<string>(spec).snapshot().query.items).toEqual(["new account"]);
    next.clear();
});

it("an inaccessible or failed intent read is retried by real navigation", async () => {
    const cache = new CollectionCache();
    await cache.prefetch(spec, async () => { throw { status: 403 }; });
    const entry = cache.get<string>(spec), load = vi.fn(async () => page("allowed"));
    const off = entry.connect(load, "query");
    await Promise.resolve(); await Promise.resolve();
    expect(entry.snapshot().query.items).toEqual(["allowed"]);
    off(); cache.clear();
});

it("only prefetches supported read-only destinations in an authenticated, online session", async () => {
    const cache = new CollectionCache();
    mocks.projects.mockResolvedValue(page()); mocks.directory.mockResolvedValue(page());
    const { result } = renderHook(useNavigationPrefetch, { wrapper: ({ children }: { children: ReactNode }) =>
        <CollectionContext.Provider value={cache}>{children}</CollectionContext.Provider> });
    await act(async () => { result.current("/assistant"); result.current("https://example.test/projects"); });
    expect(mocks.route).not.toHaveBeenCalled();
    await act(async () => result.current("/projects"));
    expect(mocks.projects).toHaveBeenCalledTimes(1);
    await act(async () => result.current("/library"));
    expect(mocks.directory).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", { onLine: false });
    await act(async () => result.current("/projects/a"));
    vi.stubGlobal("navigator", { onLine: true, connection: { saveData: true } });
    await act(async () => result.current("/projects/a"));
    vi.stubGlobal("navigator", { onLine: true, connection: { effectiveType: "2g" } });
    await act(async () => result.current("/projects/a"));
    expect(mocks.directory).toHaveBeenCalledTimes(1);
    cache.clear();
});

it("does not load anything without an account collection context", async () => {
    const { result } = renderHook(useNavigationPrefetch);
    await act(async () => result.current("/projects"));
    expect(mocks.projects).not.toHaveBeenCalled(); expect(mocks.route).not.toHaveBeenCalled();
});
