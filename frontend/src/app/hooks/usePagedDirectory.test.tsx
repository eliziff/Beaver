import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
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
});
