import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import { usePagedDirectory } from "./usePagedDirectory";

describe("usePagedDirectory", () => {
    it("keeps an unchanged directory stable across consumer renders", async () => {
        const document = { id: "document-1" } as Document;
        const load = vi.fn(async () => ({
            items: [{ kind: "document" as const, document }],
            next_cursor: null,
        }));
        const { result, rerender } = renderHook(() =>
            usePagedDirectory(load, "", []),
        );
        await waitFor(() => expect(result.current.documents).toHaveLength(1));
        const documents = result.current.documents;
        const reload = result.current.reload;

        rerender();

        expect(result.current.documents).toBe(documents);
        expect(result.current.reload).toBe(reload);
    });

    it("keeps existing rows visible while the same directory refreshes", async () => {
        const first = { id: "document-1" } as Document;
        let finishRefresh!: (page: { items: never[]; next_cursor: null }) => void;
        const refresh = new Promise<{ items: never[]; next_cursor: null }>((resolve) => {
            finishRefresh = resolve;
        });
        const load = vi.fn()
            .mockResolvedValueOnce({
                items: [{ kind: "document" as const, document: first }],
                next_cursor: null,
            })
            .mockReturnValueOnce(refresh);
        const { result } = renderHook(() => usePagedDirectory(load, "", []));
        await waitFor(() => expect(result.current.documents).toEqual([first]));

        act(() => { void result.current.reload(); });

        expect(result.current.documents).toEqual([first]);
        await act(async () => finishRefresh({ items: [], next_cursor: null }));
        await waitFor(() => expect(result.current.documents).toEqual([]));
    });
});
