import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    apiFetch: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    API_BASE: "http://localhost:3001",
    apiFetch: mocks.apiFetch,
}));

import {
    invalidateDocxBytes,
    useFetchDocxBytes,
} from "./useFetchDocxBytes";

afterEach(() => {
    invalidateDocxBytes("local-docx");
    vi.clearAllMocks();
});

describe("useFetchDocxBytes", () => {
    it("fetches native DOCX bytes directly", async () => {
        const docx = new ArrayBuffer(24);
        mocks.apiFetch.mockResolvedValue({
            ok: true,
            arrayBuffer: async () => docx,
        });

        const { result } = renderHook(() =>
            useFetchDocxBytes("local-docx", "version-1"),
        );

        await waitFor(() => expect(result.current.bytes).toBe(docx));
        expect(mocks.apiFetch).toHaveBeenCalledOnce();
        expect(mocks.apiFetch).toHaveBeenCalledWith(
            "/single-documents/local-docx/docx?version_id=version-1",
            expect.any(Object),
        );
    });
});
