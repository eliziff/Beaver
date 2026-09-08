import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Document, DocumentVersion } from "@/app/lib/api/documents";
import { useDocumentController } from "./useDocumentController";

const api = vi.hoisted(() => ({ listDocumentVersions: vi.fn(), checkpointDocumentVersion: vi.fn() }));
vi.mock("@/app/lib/api/documents", async (original) => ({
    ...await original<typeof import("@/app/lib/api/documents")>(), ...api,
}));
const document = { id: "one", filename: "Brief.docx", current_version_id: "head", current_working_revision: 3 } as Document;
const versions = [
    { id: "head", version_number: 2, working_revision: 3 },
    { id: "older", version_number: 1, working_revision: 0 },
] as DocumentVersion[];

describe("document controller", () => {
    it("retains an older selection and usable history after a revision conflict and failed refresh", async () => {
        api.listDocumentVersions.mockResolvedValueOnce({ current_version_id: "head", versions })
            .mockRejectedValueOnce(new Error("offline"));
        api.checkpointDocumentVersion.mockRejectedValueOnce(new Error("409 stale revision"));
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const { result } = renderHook(() => useDocumentController([document], vi.fn(async () => {}), vi.fn()));
        act(() => result.current.open(document));
        await waitFor(() => expect(result.current.current?.id).toBe("head"));
        act(() => result.current.selectVersion("older"));
        await act(async () => { expect(await result.current.checkpoint(document.id)).toBe(false); });
        expect(api.checkpointDocumentVersion).toHaveBeenCalledWith("one", "head", 3, undefined);
        expect(result.current.selectedId).toBe("older");
        expect(result.current.versions).toEqual(versions);
        expect(result.current.history).toMatchObject({ error: true, actionError: "Could not create this version." });
        expect(result.current.history?.pendingAction).toBeUndefined();
        log.mockRestore();
    });

    it("locks the original document and leaves another reader selected when its checkpoint completes", async () => {
        const other = { ...document, id: "two" };
        api.listDocumentVersions.mockResolvedValue({ current_version_id: "head", versions });
        let finish!: (version: DocumentVersion) => void;
        api.checkpointDocumentVersion.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const { result } = renderHook(() => useDocumentController([document, other], vi.fn(async () => {}), vi.fn()));
        act(() => result.current.open(document));
        await waitFor(() => expect(result.current.current?.id).toBe("head"));
        let pending!: Promise<boolean>;
        act(() => { pending = result.current.checkpoint(document.id); });
        await act(async () => { expect(await result.current.checkpoint(document.id)).toBe(false); });
        act(() => result.current.open(other));
        await act(async () => { finish({ ...versions[0], id: "created" }); await pending; });
        expect(result.current.doc?.id).toBe("two");
        expect(result.current.selectedId).toBe("head");
        expect(result.current.histories.get("one")?.pendingAction).toBeUndefined();
    });
});
