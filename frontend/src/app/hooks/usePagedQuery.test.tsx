import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePagedQuery } from "./usePagedQuery";

describe("usePagedQuery", () => {
  it("retains search rows and their query only until replacement, scope change, or refusal", async () => {
    let finish!: (value: { items: string[]; next_cursor: null }) => void;
    let fail!: (error: Error) => void;
    const load = (query: string) => query === "lease"
      ? Promise.resolve({ items: ["Lease terms"], next_cursor: null })
      : new Promise<{ items: string[]; next_cursor: null }>((resolve, reject) => { finish = resolve; fail = reject; });
    const { result, rerender } = renderHook(({ query, scope }) => usePagedQuery(
      () => load(query), [query, scope], true, undefined, { query, scope }),
    { initialProps: { query: "lease", scope: "account-1:projects" } });
    await waitFor(() => expect(result.current.items).toEqual(["Lease terms"]));
    rerender({ query: "renewal", scope: "account-1:projects" });
    expect(result.current.items).toEqual(["Lease terms"]);
    expect(result.current.displayQuery).toBe("lease");
    await act(async () => finish({ items: [], next_cursor: null }));
    expect(result.current.items).toEqual([]);
    expect(result.current.displayQuery).toBe("renewal");
    rerender({ query: "lease", scope: "account-1:projects" });
    await waitFor(() => expect(result.current.items).toEqual(["Lease terms"]));
    rerender({ query: "renewal", scope: "account-2:projects" });
    expect(result.current.items).toEqual([]);
    rerender({ query: "lease", scope: "account-2:projects" });
    await waitFor(() => expect(result.current.items).toEqual(["Lease terms"]));
    rerender({ query: "renewal", scope: "account-2:projects" });
    await act(async () => fail(Object.assign(new Error("Forbidden"), { status: 403 })));
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toMatchObject({ status: 403 });
  });
  it("appends pages and preserves public item updates", async () => {
    const load = vi.fn(async (cursor: string | null) => cursor
      ? { items: ["second"], next_cursor: null }
      : { items: ["first"], next_cursor: "next" });
    const { result } = renderHook(() => usePagedQuery(load, []));

    await waitFor(() => expect(result.current.items).toEqual(["first"]));
    act(() => { void result.current.loadMore(); });
    await waitFor(() => expect(result.current.items).toEqual(["first", "second"]));
    act(() => result.current.setItems((items) => items.slice(1)));

    expect(result.current.items).toEqual(["second"]);
    expect(load).toHaveBeenNthCalledWith(2, "next", expect.any(AbortSignal));
  });
});
