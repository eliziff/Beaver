import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    apiFetch: vi.fn((path: string, init?: RequestInit) => fetch(path, init)),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    apiFetch: mocks.apiFetch,
}));

import { preloadSingleDoc, useFetchSingleDoc } from "./useFetchSingleDoc";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("useFetchSingleDoc", () => {
    it("reuses an intent-prefetched rendition on first render", async () => {
        const buffer = new ArrayBuffer(8);
        const fetchMock = vi.fn(async () => ({
            ok: true,
            headers: { get: () => "application/pdf" },
            arrayBuffer: async () => buffer,
        }));
        vi.stubGlobal("fetch", fetchMock);

        await preloadSingleDoc("doc-prefetched", "version-1", "revision-1");
        const { result } = renderHook(() =>
            useFetchSingleDoc(
                "doc-prefetched",
                "version-1",
                "revision-1",
            ),
        );

        expect(result.current).toMatchObject({
            loading: false,
            error: null,
            result: { type: "pdf", buffer },
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    });

    it("retains DOCX bytes from the display response", async () => {
        const buffer = new ArrayBuffer(16);
        const fetchMock = vi.fn(async () => ({
            ok: true,
            headers: {
                get: () =>
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
            arrayBuffer: async () => buffer,
        }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            preloadSingleDoc("docx-prefetched", "version-2"),
        ).resolves.toEqual({ type: "docx", buffer });
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});
