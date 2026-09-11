import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CollectionProvider } from "@/app/contexts/CollectionContext";
import { apiFetch } from "@/app/lib/api/client";
import { CollectionCache } from "@/app/lib/collections";
import { collectionMutationTags } from "@/app/lib/collectionEvents";
import { notifyApiMutation } from "@/app/lib/api/mutationEvents";
import { usePagedQuery } from "./usePagedQuery";
import { usePagedDirectory } from "./usePagedDirectory";
import type { Document } from "@/app/lib/api/documents";

const spec = { key: "/projects?q=", tags: ["projects"] };
const wrapper = ({ children }: { children: ReactNode }) =>
    <CollectionProvider owner="one">{children}</CollectionProvider>;
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("reuses rows and all loaded pages immediately on return, then atomically replaces the chain", async () => {
    let hold: ReturnType<typeof deferred<{ items: string[]; next_cursor: string | null }>> | null = null;
    const load = vi.fn(async (cursor: string | null) => cursor
        ? { items: ["second"], next_cursor: "third" }
        : hold ? hold.promise : { items: ["first"], next_cursor: "second" });
    // Different hook instances, with a still-mounted session provider.
    const view = renderHook(({ enabled }) => usePagedQuery(load, [], enabled, spec),
        { wrapper, initialProps: { enabled: true } });
    await waitFor(() => expect(view.result.current.items).toEqual(["first"]));
    await act(async () => { await view.result.current.loadMore(); });
    view.rerender({ enabled: false });
    hold = deferred();
    view.rerender({ enabled: true });
    expect(view.result.current.items).toEqual(["first", "second"]);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.refreshing).toBe(true);
    await act(async () => hold!.resolve({ items: ["updated"], next_cursor: "second" }));
    await waitFor(() => expect(view.result.current.refreshing).toBe(false));
    expect(view.result.current.items).toEqual(["updated", "second"]);
    expect(view.result.current.hasMore).toBe(true);
});

it("shares an in-flight request and local edits between simultaneous collection views", async () => {
    const pending = deferred<{ items: string[]; next_cursor: null }>();
    const load = vi.fn(() => pending.promise);
    const view = renderHook(() => ({
        first: usePagedQuery(load, [], true, spec),
        second: usePagedQuery(load, [], true, spec),
    }), { wrapper });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ items: ["one"], next_cursor: null }));
    act(() => view.result.current.first.setItems(["renamed"]));
    expect(view.result.current.second.items).toEqual(["renamed"]);
});

it("does not paint an initial loading state when revisiting a previously empty collection", async () => {
    const load = vi.fn(async () => ({ items: [], next_cursor: null }));
    const view = renderHook(({ enabled }) => usePagedQuery(load, [], enabled, spec),
        { wrapper, initialProps: { enabled: true } });
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    view.rerender({ enabled: false });
    load.mockReturnValue(new Promise(() => {}));
    view.rerender({ enabled: true });
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.items).toEqual([]);
});

it("keeps different queries and resource types isolated", async () => {
    const load = vi.fn(async () => ({ items: ["projects"], next_cursor: null }));
    const view = renderHook(({ key }) => usePagedQuery(load, [key], true, { ...spec, key }),
        { wrapper, initialProps: { key: "/projects?q=one" } });
    await waitFor(() => expect(view.result.current.items).toEqual(["projects"]));
    load.mockReturnValue(new Promise(() => {}));
    view.rerender({ key: "/tabular-review?q=one" });
    expect(view.result.current.items).toEqual([]);
});

it("does not let an invalidated pre-mutation response resurrect deleted rows", async () => {
    const stale = deferred<{ items: string[]; next_cursor: null }>();
    const load = vi.fn().mockImplementationOnce(() => stale.promise)
        .mockResolvedValue({ items: ["current"], next_cursor: null });
    const view = renderHook(() => usePagedQuery<string>(load, [], true, spec), { wrapper });
    act(() => notifyApiMutation("/projects", "POST"));
    await waitFor(() => expect(view.result.current.items).toEqual(["current"]));
    await act(async () => stale.resolve({ items: ["deleted"], next_cursor: null }));
    expect(view.result.current.items).toEqual(["current"]);
});

it("invalidates inactive filters too, without issuing requests for them", async () => {
    const load = vi.fn(async () => ({ items: ["old"], next_cursor: null }));
    const view = renderHook(({ enabled }) => usePagedQuery(load, [], enabled, spec),
        { wrapper, initialProps: { enabled: true } });
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    view.rerender({ enabled: false });
    act(() => notifyApiMutation("/projects", "POST"));
    expect(load).toHaveBeenCalledTimes(1);
    load.mockReturnValue(new Promise(() => {}));
    view.rerender({ enabled: true });
    expect(view.result.current.items).toEqual([]);
});

it("clears all cached folder chains on access denial", async () => {
    let denied = false;
    const load = vi.fn(async (parent: string | null) => {
        if (denied) throw { status: 403 };
        return { items: [{ kind: "document" as const, document: { id: parent ?? "root" } as Document }], next_cursor: null };
    });
    const view = renderHook(() => usePagedDirectory(load, "", [], true,
        { key: "/project/directory", tags: ["directories", "directory:project"] }), { wrapper });
    await waitFor(() => expect(view.result.current.documents).toHaveLength(1));
    act(() => view.result.current.ensureParent("folder"));
    await waitFor(() => expect(view.result.current.documents).toHaveLength(2));
    denied = true;
    await act(async () => { await view.result.current.reload(); });
    expect(view.result.current.documents).toEqual([]);
    expect(view.result.current.error).toMatchObject({ status: 403 });
});

it("retains usable data on transient revalidation errors and recovers on reconnect", async () => {
    const load = vi.fn().mockResolvedValueOnce({ items: ["available"], next_cursor: null })
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ items: ["fresh"], next_cursor: null });
    const view = renderHook(() => usePagedQuery<string>(load, [], true, spec), { wrapper });
    await waitFor(() => expect(view.result.current.items).toEqual(["available"]));
    await act(async () => { await view.result.current.reload(); });
    expect(view.result.current.items).toEqual(["available"]);
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(view.result.current.items).toEqual(["fresh"]));
});

it("does not cache failed loads permanently", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue({ items: ["recovered"], next_cursor: null });
    const view = renderHook(({ enabled }) => usePagedQuery<string>(load, [], enabled, spec),
        { wrapper, initialProps: { enabled: true } });
    await waitFor(() => expect(view.result.current.error).toBeTruthy());
    view.rerender({ enabled: false }); view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current.items).toEqual(["recovered"]));
});

it("bounds inactive memory without evicting active collections", async () => {
    const cache = new CollectionCache({ entries: 1, items: 2, bytes: 2_000, idleMs: 100 });
    const one = cache.get<string>(spec);
    const off = one.connect(async () => ({ items: ["one"], next_cursor: null }), "query");
    await one.fetchPage("query", null, false);
    const two = cache.get<string>({ key: "two", tags: [] });
    const offTwo = two.connect(async () => ({ items: ["two"], next_cursor: null }), "query");
    await two.fetchPage("query", null, false); offTwo();
    expect(one.snapshot().query.items).toEqual(["one"]);
    const three = cache.get<string>({ key: "three", tags: [] });
    const offThree = three.connect(async () => ({ items: ["three"], next_cursor: null }), "query");
    await three.fetchPage("query", null, false); offThree();
    expect(cache.get({ key: "two", tags: [] }).snapshot()).toEqual({});
    off(); cache.clear();
});

it("survives StrictMode effect replay and shares the subsequent view", async () => {
    const load = vi.fn(async () => ({ items: ["one"], next_cursor: null }));
    const view = renderHook(({ enabled }) => usePagedQuery(load, [], enabled, spec), {
        initialProps: { enabled: true },
        wrapper: ({ children }) => <StrictMode><CollectionProvider owner="one">{children}</CollectionProvider></StrictMode>,
    });
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    view.rerender({ enabled: false });
    load.mockReturnValue(new Promise(() => {}));
    view.rerender({ enabled: true });
    expect(view.result.current.items).toEqual(["one"]);
});

it("targets known mutations and ignores read-only POST and chat-control endpoints", () => {
    expect(collectionMutationTags("/library/files/documents/one", "DELETE")).toEqual(["directory:/library/files"]);
    expect(collectionMutationTags("/projects/one/documents/two", "POST")).toEqual(["directory:/projects/one"]);
    expect(collectionMutationTags("/single-documents/one/versions", "POST")).toEqual(["directories"]);
    expect(collectionMutationTags("/single-documents/parse-states", "POST")).toEqual([]);
    expect(collectionMutationTags("/chat/one/stop", "POST")).toEqual([]);
    expect(collectionMutationTags("/projects", "GET")).toEqual([]);
});


it("reuses a collection across actual consumer unmounts without sharing it across accounts", async () => {
    let latest!: ReturnType<typeof usePagedQuery<string>>;
    let resolveOld!: (value: { items: string[]; next_cursor: null }) => void;
    const load = vi.fn(async () => ({ items: ["account-one"], next_cursor: null }));
    function Consumer() {
        latest = usePagedQuery(load, [], true, spec);
        return <output>{latest.items.join(",") || "empty"}</output>;
    }
    function App({ owner, visible }: { owner: string; visible: boolean }) {
        return <CollectionProvider owner={owner}>{visible && <Consumer />}</CollectionProvider>;
    }
    const view = render(<App owner="one" visible />);
    await screen.findByText("account-one");
    view.rerender(<App owner="one" visible={false} />);
    load.mockImplementation(() => new Promise(resolve => { resolveOld = resolve; }));
    view.rerender(<App owner="one" visible />);
    expect(screen.getByText("account-one")).toBeVisible();
    const oldRequest = resolveOld;
    load.mockResolvedValue({ items: ["account-two"], next_cursor: null });
    view.rerender(<App owner="two" visible />);
    expect(screen.queryByText("account-one")).not.toBeInTheDocument();
    await screen.findByText("account-two");
    await act(async () => oldRequest({ items: ["late-private-one"], next_cursor: null }));
    expect(latest.items).toEqual(["account-two"]);
    expect(screen.queryByText("late-private-one")).not.toBeInTheDocument();
});

it("does not cancel a shared request when only one subscriber leaves", async () => {
    const response = deferred<{ items: string[]; next_cursor: null }>();
    let signal!: AbortSignal;
    const load = vi.fn((_cursor: string | null, next: AbortSignal) => { signal = next; return response.promise; });
    const view = renderHook(({ first }) => ({
        one: usePagedQuery(load, [], first, spec), two: usePagedQuery(load, [], true, spec),
    }), { wrapper, initialProps: { first: true } });
    view.rerender({ first: false });
    expect(signal.aborted).toBe(false);
    await act(async () => response.resolve({ items: ["shared"], next_cursor: null }));
    expect(view.result.current.two.items).toEqual(["shared"]);
    expect(load).toHaveBeenCalledTimes(1);
});


it("broadcasts invalidation identities, accepts only the current account, and closes its channel", async () => {
    const channels: FakeChannel[] = [];
    class FakeChannel {
        onmessage: ((event: MessageEvent) => void) | null = null;
        postMessage = vi.fn();
        close = vi.fn();
        constructor() { channels.push(this); }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    let name = "before";
    const load = vi.fn(async () => ({ items: [name], next_cursor: null }));
    const view = renderHook(() => usePagedQuery(load, [], true, spec), { wrapper });
    await waitFor(() => expect(view.result.current.items).toEqual(["before"]));
    name = "after";
    act(() => channels[0].onmessage?.({ data: { owner: "other", tags: ["projects"] } } as MessageEvent));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => channels[0].onmessage?.({ data: { owner: "one", tags: ["projects"] } } as MessageEvent));
    await waitFor(() => expect(view.result.current.items).toEqual(["after"]));
    expect(channels[0].postMessage).not.toHaveBeenCalled();
    act(() => notifyApiMutation("/projects", "POST"));
    expect(channels[0].postMessage).toHaveBeenCalledWith({ owner: "one", tags: ["projects"] });
    view.unmount();
    expect(channels[0].close).toHaveBeenCalledOnce();
});

it("clears inactive query variants after permission revocation and ignores their pending responses", async () => {
    const cache = new CollectionCache();
    const one = cache.get<string>({ key: "project?q=one", tags: ["directories", "directory:one"] });
    const two = cache.get<string>({ key: "project?q=two", tags: ["directories", "directory:one"] });
    let denied = false;
    const offOne = one.connect(async () => {
        if (denied) throw { status: 403 };
        return { items: ["private"], next_cursor: null };
    }, "query");
    const stale = deferred<{ items: string[]; next_cursor: null }>();
    const offTwo = two.connect(() => stale.promise, "query");
    await one.fetchPage("query", null, false); offTwo();
    denied = true;
    await one.fetchPage("query", null, false, true);
    stale.resolve({ items: ["late-private"], next_cursor: null });
    await stale.promise;
    expect(one.snapshot().query.items).toEqual([]);
    expect(two.snapshot().query.items).toEqual([]);
    expect(two.snapshot().query.error).toMatchObject({ status: 403 });
    offOne(); cache.clear();
});

it("does not turn chat draft autosaves into history invalidations", async () => {
    const changes: unknown[] = [];
    const { onCollectionChange } = await import("@/app/lib/collectionEvents");
    const off = onCollectionChange(value => changes.push(value));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    try {
        await apiFetch("/chat/one", { method: "PATCH", body: JSON.stringify({ draft: { content: "private" } }) });
        expect(changes).toEqual([]);
        await apiFetch("/chat/one", { method: "PATCH", body: JSON.stringify({ title: "renamed" }) });
        expect(changes).toEqual([{ tags: ["chats"] }]);
    } finally { off(); }
});
