import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { CollectionProvider } from "@/app/contexts/CollectionContext";
import { projectsCollection } from "@/app/lib/collectionKeys";
import { usePagedQuery } from "./usePagedQuery";

const wrapper = ({ children }: { children: ReactNode }) =>
    <CollectionProvider owner="one">{children}</CollectionProvider>;

it("shares the overview's explicit all filter with a default-scope project picker", async () => {
    const load = vi.fn(async () => ({ items: ["one"], next_cursor: null }));
    const view = renderHook(() => ({
        overview: usePagedQuery(load, [], true, projectsCollection({ scope: "all", q: "" })),
        picker: usePagedQuery(load, [], true, projectsCollection()),
    }), { wrapper });
    await waitFor(() => expect(view.result.current.overview.items).toEqual(["one"]));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => view.result.current.overview.setItems(["renamed"]));
    expect(view.result.current.picker.items).toEqual(["renamed"]);
});

it("does not share collections with different ownership filters or page sizes", async () => {
    const all = vi.fn(async () => ({ items: ["all"], next_cursor: null }));
    const mine = vi.fn(async () => ({ items: ["mine"], next_cursor: null }));
    const limited = vi.fn(async () => ({ items: ["limited"], next_cursor: null }));
    const view = renderHook(() => ({
        all: usePagedQuery(all, [], true, projectsCollection()),
        mine: usePagedQuery(mine, [], true, projectsCollection({ scope: "mine" })),
        limited: usePagedQuery(limited, [], true, projectsCollection({ limit: 10 })),
    }), { wrapper });
    await waitFor(() => expect(view.result.current.limited.items).toEqual(["limited"]));
    act(() => view.result.current.all.setItems(["updated"]));
    expect(view.result.current.mine.items).toEqual(["mine"]);
    expect(view.result.current.limited.items).toEqual(["limited"]);
    expect(all).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(limited).toHaveBeenCalledTimes(1);
});
