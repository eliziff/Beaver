import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Document, DocumentVersion } from "@/app/lib/api/documents";
import { BeaverApiError } from "@/app/lib/api/client";
import { useDocumentController } from "./useDocumentController";

const api = vi.hoisted(() => ({ getDocument: vi.fn(), listDocumentVersions: vi.fn(), checkpointDocumentVersion: vi.fn(), uploadDocumentVersion: vi.fn() }));
vi.mock("@/app/lib/api/documents", async (original) => ({
    ...await original<typeof import("@/app/lib/api/documents")>(), ...api,
}));
const document = { id: "one", filename: "Brief.docx", current_version_id: "head", current_working_revision: 3 } as Document;
const versions = [
    { id: "head", version_number: 2, working_revision: 3 },
    { id: "older", version_number: 1, working_revision: 0 },
] as DocumentVersion[];

describe("document controller", () => {
    it.each([true, false])("uses the renamed snapshot when removed from filter=%s, even if history refresh fails", async (removed) => {
        api.listDocumentVersions.mockResolvedValueOnce({ current_version_id: "head", versions })
            .mockRejectedValue(new Error("offline"));
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const renamed = { ...document, filename: "Renamed.docx", current_working_revision: 4 };
        const refresh = vi.fn(async () => rerender({ documents: removed ? [] : [document] }));
        const { result, rerender } = renderHook(({ documents }: { documents: Document[] }) =>
            useDocumentController(documents, refresh, vi.fn()), { initialProps: { documents: [document] } });
        act(() => result.current.open(document));
        await waitFor(() => expect(result.current.current?.id).toBe("head"));
        act(() => result.current.selectVersion("older"));
        await act(async () => { expect(await result.current.action("one", "rename", async () => renamed, true)).toBe(true); });
        expect(result.current.docsById.has("one")).toBe(!removed);
        expect(result.current.doc).toEqual(renamed);
        expect(result.current.selectedId).toBe("older");
        expect(result.current.history?.error).toBe(true);
        const file = new File(["new"], "New.docx");
        api.uploadDocumentVersion.mockResolvedValueOnce({ id: "uploaded", version_number: 3, working_revision: 0, filename: "New.docx" });
        await act(async () => { expect(await result.current.upload(result.current.doc!, [file])).toBe(true); });
        expect(api.uploadDocumentVersion).toHaveBeenCalledWith("one", file, "head", 4);
        expect(result.current.doc).toMatchObject({ filename: "New.docx", current_version_id: "uploaded", current_working_revision: 0 });
        api.uploadDocumentVersion.mockResolvedValueOnce({ id: "uploaded-again", version_number: 4, working_revision: 0, filename: "New.docx" });
        await act(async () => { expect(await result.current.upload(result.current.doc!, [file])).toBe(true); });
        expect(api.uploadDocumentVersion).toHaveBeenLastCalledWith("one", file, "uploaded", 0);
        log.mockRestore();
    });

    it.each([true, false])("refreshes a competing upload revision and permits the next manual retry with filtered out=%s", async (removed) => {
        api.listDocumentVersions.mockResolvedValue({ current_version_id: "head", versions });
        api.uploadDocumentVersion.mockReset().mockRejectedValueOnce(new BeaverApiError({ status: 409, message: "competing rename" }));
        const latest = { ...document, filename: "Competing.docx", current_working_revision: 4 };
        api.getDocument.mockResolvedValueOnce(latest);
        const refresh = vi.fn(async () => rerender({ documents: removed ? [] : [document] }));
        const { result, rerender } = renderHook(({ documents }: { documents: Document[] }) =>
            useDocumentController(documents, refresh, vi.fn()), { initialProps: { documents: [document] } });
        act(() => result.current.open(document));
        await waitFor(() => expect(result.current.current?.id).toBe("head"));
        act(() => result.current.selectVersion("older"));
        api.listDocumentVersions.mockResolvedValue({ current_version_id: "head", versions: [{ ...versions[0], working_revision: 4 }, versions[1]] });
        const file = new File(["new"], "New.docx");
        await act(async () => { expect(await result.current.upload(result.current.doc!, [file])).toBe(false); });
        expect(api.uploadDocumentVersion).toHaveBeenCalledExactlyOnceWith("one", file, "head", 3);
        expect(result.current.doc).toEqual(latest);
        expect(result.current.selectedId).toBe("head");
        expect(result.current.current?.working_revision).toBe(4);
        expect(result.current.history?.actionError).toMatch(/document changed/i);
        expect(result.current.history?.pendingAction).toBeUndefined();
        const uploaded = { id: "uploaded", version_number: 3, working_revision: 0, filename: "New.docx" };
        api.uploadDocumentVersion.mockResolvedValueOnce(uploaded);
        api.listDocumentVersions.mockResolvedValue({ current_version_id: uploaded.id, versions: [uploaded, ...versions] });
        await act(async () => { expect(await result.current.upload(result.current.doc!, [file])).toBe(true); });
        expect(api.uploadDocumentVersion).toHaveBeenLastCalledWith("one", file, "head", 4);
        expect(result.current.selectedId).toBe("uploaded");
        expect(result.current.history?.actionError).toBeUndefined();
    });

    it("retains an older selection and usable history after a revision conflict and failed refresh", async () => {
        api.listDocumentVersions.mockResolvedValueOnce({ current_version_id: "head", versions })
            .mockRejectedValueOnce(new Error("offline"));
        api.checkpointDocumentVersion.mockRejectedValueOnce(new BeaverApiError({ status: 409, message: "stale revision" }));
        api.getDocument.mockRejectedValueOnce(new Error("offline"));
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

    it("does not replace another reader when a conflict refresh completes", async () => {
        const other = { ...document, id: "two" }, onError = vi.fn();
        api.listDocumentVersions.mockResolvedValue({ current_version_id: "head", versions });
        api.uploadDocumentVersion.mockRejectedValueOnce(new BeaverApiError({ status: 409, message: "competing edit" }));
        let finish!: (doc: Document) => void;
        api.getDocument.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const { result } = renderHook(() => useDocumentController([document, other], vi.fn(async () => {}), onError));
        act(() => result.current.open(document));
        await waitFor(() => expect(result.current.current?.id).toBe("head"));
        let pending!: Promise<boolean>;
        act(() => { pending = result.current.upload(document, [new File(["new"], "New.docx")]); });
        await waitFor(() => expect(finish).toBeTypeOf("function"));
        act(() => result.current.open(other));
        await act(async () => { finish({ ...document, current_working_revision: 4 }); expect(await pending).toBe(false); });
        expect(result.current.doc?.id).toBe("two");
        expect(result.current.histories.get("one")?.pendingAction).toBeUndefined();
        expect(onError).toHaveBeenCalledWith(expect.stringMatching(/document changed/i));
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
