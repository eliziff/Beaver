import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useProjectFiles } from "./useProjectFiles";

const mocks = vi.hoisted(() => ({
    project: undefined as object | null | undefined,
    list: vi.fn(async () => ({ items: [], next_cursor: null })),
}));

vi.mock("./ProjectWorkspace", () => ({
    useProjectWorkspace: () => ({ projectId: "project-1", project: mocks.project, search: "" }),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    directoryResource: () => ({ list: mocks.list }),
    getDocumentParseStates: vi.fn(),
    removeProjectDocument: vi.fn(),
}));

it("loads project files while metadata is pending but not after a missing result", async () => {
    mocks.project = undefined;
    const pending = renderHook(() => useProjectFiles());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    pending.unmount();

    mocks.list.mockClear();
    mocks.project = null;
    const missing = renderHook(() => useProjectFiles());
    expect(mocks.list).not.toHaveBeenCalled();
    missing.unmount();
});
