import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    apiFetch: vi.fn(),
}));

vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));
vi.mock("@/app/lib/beaverApi", () => ({
    API_BASE: "http://localhost:3001",
    apiFetch: mocks.apiFetch,
}));

import { preloadSingleDoc } from "./useFetchSingleDoc";
import {
    invalidateDocxBytes,
    useFetchDocxBytes,
} from "./useFetchDocxBytes";

afterEach(() => {
    invalidateDocxBytes("local-docx");
    vi.clearAllMocks();
});

describe("useFetchDocxBytes", () => {
    it("reuses native DOCX bytes from the display cache", async () => {
        const docx = new ArrayBuffer(24);
        mocks.apiFetch.mockResolvedValue({
            ok: true,
            headers: {
                get: () =>
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
            arrayBuffer: async () => docx,
        });

        const { result } = renderHook(() =>
            useFetchDocxBytes("local-docx", "version-1"),
        );

        await waitFor(() => expect(result.current.bytes).toBe(docx));
        expect(mocks.apiFetch).toHaveBeenCalledOnce();
        expect(mocks.apiFetch).toHaveBeenCalledWith(
            "/single-documents/local-docx/display?version_id=version-1",
            expect.any(Object),
        );
    });

    it("fetches native DOCX bytes when the display cache contains a PDF rendition", async () => {
        const pdf = new ArrayBuffer(12);
        const docx = new ArrayBuffer(24);
        mocks.apiFetch.mockImplementation(async (path: string) => {
            const isDisplay = path.includes("/display");
            return {
                ok: true,
                headers: {
                    get: () =>
                        isDisplay
                            ? "application/pdf"
                            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                },
                arrayBuffer: async () => (isDisplay ? pdf : docx),
            };
        });
        await expect(
            preloadSingleDoc("local-docx", "version-1"),
        ).resolves.toEqual({ type: "pdf", buffer: pdf });

        const { result } = renderHook(() =>
            useFetchDocxBytes("local-docx", "version-1"),
        );

        await waitFor(() => expect(result.current.bytes).toBe(docx));
        expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
        expect(mocks.apiFetch).toHaveBeenLastCalledWith(
            "/single-documents/local-docx/docx?version_id=version-1",
            expect.any(Object),
        );
    });
});
