import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePagedQuery } from "./usePagedQuery";

describe("usePagedQuery", () => {
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
